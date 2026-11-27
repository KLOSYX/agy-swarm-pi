import { createHash, randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import tar from 'tar-stream';
import { processIsAlive } from '../bin/coordinator-files.mjs';

const REPOSITORY = 'KLOSYX/agy-swarm-pi';
const RELEASES = `https://github.com/${REPOSITORY}/releases`;
const API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const ARCHIVE_LIMIT = 16 * 1024 * 1024;
const CONTENT_LIMIT = 64 * 1024 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];
const headers = { 'User-Agent': 'Swarm-Pi-Updater' };
const unzip = promisify(gunzip);

const requiredFiles = [
  'plugin.json', 'mcp_config.json', 'bin/server.bundle.mjs', 'ui/dist/settings.html',
];

function versionFrom(value) {
  return typeof value === 'string' && /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value)
    ? value.replace(/^v/, '')
    : null;
}

function releaseFiles(tag, version) {
  const archive = `swarm-pi-v${version}.tar.gz`;
  return {
    version, url: `${RELEASES}/tag/${tag}`, archive, checksum: `${archive}.sha256`,
    downloadBase: `${RELEASES}/download/${tag}`,
  };
}

function assetRedirect(response, url) {
  if (!REDIRECTS.includes(response.status)) return null;
  const target = new URL(response.headers.get('location') || '', url);
  if (target.protocol !== 'https:' || target.username || target.password || target.port
    || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) {
    throw new Error('Unexpected GitHub download redirect');
  }
  return target.href;
}

function compareVersions(left, right) {
  const first = left.split('.').map(Number);
  const second = right.split('.').map(Number);
  return first[0] - second[0] || first[1] - second[1] || first[2] - second[2];
}

function readManifest(root) {
  return JSON.parse(fsSync.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
}

function contains(root, target) {
  const relative = path.relative(root, target);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function processMarkers(directory) {
  try {
    return fsSync.readdirSync(directory).filter((name) => /^\d+-[0-9a-f-]{36}$/.test(name));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function markerIsLive(name) {
  return processIsAlive(Number(name.split('-')[0]));
}

function removeEmptyDirectory(directory) {
  try {
    fsSync.rmdirSync(directory);
  } catch (err) {
    if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(err.code)) throw err;
  }
}

class UpdateError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.code = code;
  }
}

export function updateError(error) {
  return error instanceof UpdateError
    ? { status: 'error', code: error.code, detail: error.message }
    : { status: 'error', code: 'installationFailed', detail: error.message };
}

async function responseBytes(response, limit) {
  if (Number(response.headers.get('content-length')) > limit || !response.body) {
    throw new Error('Invalid download size');
  }
  const parts = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Download exceeded the size limit');
    parts.push(chunk);
  }
  return Buffer.concat(parts, size);
}

async function extractPackage(archive, staging) {
  const bytes = await unzip(archive, { maxOutputLength: CONTENT_LIMIT });
  const parser = tar.extract();
  const seen = new Set();

  async function writeEntries() {
    for await (const entry of parser) {
      const { name, type, mode } = entry.header;
      const parts = name.replace(/\/$/, '').split('/');
      const key = parts.join('/').toLowerCase();
      if (parts[0] !== 'swarm-pi' || (parts.length === 1 && type !== 'directory')
        || parts.some((part) => !/^[a-z0-9][a-z0-9._-]*$/i.test(part) || part.endsWith('.')
          || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
        || !['file', 'directory'].includes(type) || seen.has(key) || seen.size >= 256) {
        throw new Error(`Unsupported archive entry: ${name}`);
      }
      seen.add(key);
      const location = path.join(staging, ...parts);
      if (type === 'directory') {
        await fs.mkdir(location, { recursive: true });
        for await (const _chunk of entry) {
          throw new Error('Archive directory contains data');
        }
      } else {
        await fs.mkdir(path.dirname(location), { recursive: true });
        await fs.writeFile(location, entry, { flag: 'wx', mode: (mode & 0o111) ? 0o755 : 0o644 });
      }
    }
  }

  await Promise.all([pipeline(Readable.from([bytes]), parser), writeEntries()]);
  for (const file of requiredFiles) {
    if (!(await fs.stat(path.join(staging, 'swarm-pi', file))).isFile()) {
      throw new Error(`Required release file is invalid: ${file}`);
    }
  }
}

export class PluginUpdates {
  constructor({ root, dataDir, version, fetchRelease = globalThis.fetch, hasActiveWork, openBoards }) {
    this.root = path.resolve(root);
    this.dataDir = path.resolve(dataDir);
    this.currentVersion = version;
    this.physicalRoot = fsSync.realpathSync(this.root);
    this.directory = path.join(path.dirname(this.physicalRoot), `.swarm-pi-updates-${path.basename(this.physicalRoot)}`);
    this.workDir = path.join(this.directory, 'work');
    this.activationLock = path.join(this.directory, 'install.lock');
    this.fetchRelease = fetchRelease;
    this.hasActiveWork = hasActiveWork;
    this.openBoards = openBoards;
    this.installing = false;
    this.workCount = 0;
    this.workMarker = null;
  }

  installationLayoutBlock() {
    if (fsSync.existsSync(path.join(this.root, '.git'))) return 'gitCheckout';
    if (fsSync.lstatSync(this.root).isSymbolicLink()) return 'linkedInstallation';
    if (contains(this.root, this.dataDir) || fsSync.existsSync(path.join(this.root, '.data'))
      || (fsSync.existsSync(this.dataDir) && contains(fsSync.realpathSync(this.root), fsSync.realpathSync(this.dataDir)))) {
      return 'dataInPlugin';
    }
    if (readManifest(this.root).name !== 'swarm-pi') return 'invalidInstallation';
    return null;
  }

  installationBlock() {
    return this.installationLayoutBlock()
      ?? (this.hasActiveWork() || processMarkers(this.workDir).some(markerIsLive) ? 'activeWork' : null);
  }

  createUpdateDirectory() {
    fsSync.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fsSync.lstatSync(this.directory).isSymbolicLink()) throw new Error('The update directory is a symbolic link');
  }

  claimWork() {
    if (this.workCount > 0) return this.retainWork();
    // A checkout cannot be replaced by the updater even when opened through
    // another path. All other aliases share the real installation's leases.
    if (fsSync.existsSync(path.join(this.physicalRoot, '.git'))) return undefined;
    if (processMarkers(this.activationLock).some(markerIsLive)) {
      throw new Error('Wait for the Pi Swarm update to finish before starting a task');
    }
    try {
      this.createUpdateDirectory();
      fsSync.mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
      if (fsSync.lstatSync(this.workDir).isSymbolicLink()) return undefined;
      this.workMarker = path.join(this.workDir, `${process.pid}-${randomUUID()}`);
      fsSync.writeFileSync(this.workMarker, '', { mode: 0o600, flag: 'wx' });
    } catch (err) {
      // Read-only installations can keep running tasks.
      if (['EACCES', 'EPERM', 'EROFS'].includes(err.code)) return undefined;
      throw err;
    }
    const release = this.retainWork();
    // Publish before checking the lock. Installation takes the lock before
    // checking work, so the two operations cannot cross the directory switch.
    if (processMarkers(this.activationLock).some(markerIsLive)) {
      release();
      throw new Error('Wait for the Pi Swarm update to finish before starting a task');
    }
    return release;
  }

  retainWork() {
    this.workCount += 1;
    return () => {
      this.workCount -= 1;
      if (this.workCount > 0) return;
      try {
        fsSync.rmSync(this.workMarker, { force: true });
      } catch (err) {
        console.error('Pi Swarm could not release its update work lease:', err.message);
      } finally {
        this.workMarker = null;
      }
    };
  }

  lockActivation() {
    const staging = fsSync.mkdtempSync(path.join(this.directory, 'lock-'));
    const marker = `${process.pid}-${randomUUID()}`;
    try {
      fsSync.writeFileSync(path.join(staging, marker), '', { mode: 0o600 });
      for (const name of processMarkers(this.activationLock)) {
        if (!markerIsLive(name)) fsSync.rmSync(path.join(this.activationLock, name), { force: true });
      }
      removeEmptyDirectory(this.activationLock);
      // A nonempty lock cannot be replaced by this rename.
      fsSync.renameSync(staging, this.activationLock);
    } catch (err) {
      if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(err.code)
        && processMarkers(this.activationLock).some(markerIsLive)) {
        throw new UpdateError('installationBusy', 'Another update is applying on this host');
      }
      throw err;
    } finally {
      fsSync.rmSync(staging, { recursive: true, force: true });
    }
    return () => {
      fsSync.rmSync(path.join(this.activationLock, marker), { force: true });
      removeEmptyDirectory(this.activationLock);
    };
  }

  async releaseFromWeb() {
    const options = { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000), headers };
    const latest = await this.fetchRelease(`${RELEASES}/latest`, options);
    const location = latest.headers.get('location') || '';
    const prefix = `${RELEASES}/tag/`;
    const tag = location.startsWith(prefix) ? location.slice(prefix.length) : null;
    const version = versionFrom(tag);
    if (!REDIRECTS.includes(latest.status) || !version) throw new Error('GitHub did not return a stable version');
    const release = releaseFiles(tag, version);
    const assets = await Promise.all([release.archive, release.checksum].map(async (name) => {
      const url = `${release.downloadBase}/${name}`;
      const response = await this.fetchRelease(url, options);
      return response.ok || Boolean(assetRedirect(response, url));
    }));
    return { ...release, hasInstaller: assets.every(Boolean) };
  }

  async release() {
    try {
      const response = await this.fetchRelease(API, {
        headers: { ...headers, Accept: 'application/vnd.github+json' },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      if ([403, 429].includes(response.status)) {
        await response.body?.cancel();
        return await this.releaseFromWeb();
      }
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
      const data = JSON.parse((await responseBytes(response, 1024 * 1024)).toString('utf8'));
      const version = versionFrom(data.tag_name);
      if (!version || data.prerelease || data.draft) throw new Error('GitHub did not return a stable version');
      const release = releaseFiles(data.tag_name, version);
      const assets = new Set((data.assets || []).filter(({ state }) => state === 'uploaded').map(({ name }) => name));
      return { ...release, hasInstaller: assets.has(release.archive) && assets.has(release.checksum) };
    } catch (err) {
      throw new UpdateError('checkFailed', err.message, err);
    }
  }

  async check() {
    const release = await this.release();
    const installedVersion = readManifest(this.root).version;
    const pendingReload = installedVersion !== this.currentVersion;
    return {
      currentVersion: this.currentVersion,
      installedVersion,
      latestVersion: release.version,
      releaseUrl: release.url,
      available: compareVersions(release.version, installedVersion) > 0,
      pendingReload,
      openBoards: this.openBoards(),
      installBlock: pendingReload ? 'reloadRequired' : this.installationBlock()
        ?? (release.hasInstaller ? null : 'installerMissing'),
    };
  }

  async download(url, limit) {
    const signal = AbortSignal.timeout(25000);
    let response = await this.fetchRelease(url, { redirect: 'manual', signal, headers });
    const target = assetRedirect(response, url);
    if (target) {
      await response.body?.cancel();
      response = await this.fetchRelease(target, { redirect: 'error', signal, headers });
    }
    if (!response.ok) throw new Error(`GitHub asset download returned HTTP ${response.status}`);
    return responseBytes(response, limit);
  }

  assertInstallable() {
    const block = this.installationBlock();
    if (block) throw new UpdateError(block, 'This installation is currently unavailable for automatic replacement');
    const installed = readManifest(this.root).version;
    if (installed !== this.currentVersion) {
      throw new UpdateError('reloadRequired', 'Reload the installed update before installing another release');
    }
    return installed;
  }

  async install(expectedVersion) {
    if (this.installing) throw new UpdateError('installationBusy', 'An update is already in progress');
    const installed = this.assertInstallable();
    this.installing = true;
    let staging;
    let backup;
    try {
      const release = await this.release();
      if (release.version !== expectedVersion || compareVersions(release.version, installed) <= 0) {
        throw new UpdateError('versionChanged', 'The latest release changed. Check for updates again.');
      }
      if (!release.hasInstaller) throw new UpdateError('installerMissing', 'The release installer or checksum is missing');
      const [archive, checksum] = await Promise.all([
        this.download(`${release.downloadBase}/${release.archive}`, ARCHIVE_LIMIT),
        this.download(`${release.downloadBase}/${release.checksum}`, 2048),
      ]);
      const checksumLine = checksum.toString('utf8').trim();
      const match = /^([a-f0-9]{64})[ \t]+\*?([^\r\n]+)$/i.exec(checksumLine);
      if (!match || match[2] !== release.archive
        || createHash('sha256').update(archive).digest('hex') !== match[1].toLowerCase()) {
        throw new UpdateError('checksumFailed', 'The release archive does not match its SHA-256 file');
      }
      this.createUpdateDirectory();
      staging = await fs.mkdtemp(path.join(this.directory, 'update-'));
      await extractPackage(archive, staging);
      const replacement = path.join(staging, 'swarm-pi');
      const manifest = readManifest(replacement);
      if (manifest.name !== 'swarm-pi' || manifest.version !== release.version) {
        throw new UpdateError('invalidPackage', 'The archive manifest does not match the selected Swarm Pi release');
      }

      this.assertInstallable();
      const unlock = this.lockActivation();
      try {
        this.assertInstallable();
        backup = path.join(staging, `previous-v${installed}`);
        fsSync.renameSync(this.root, backup);
        try {
          fsSync.renameSync(replacement, this.root);
        } catch (installError) {
          try {
            fsSync.renameSync(backup, this.root);
          } catch {
            throw new UpdateError('rollbackFailed', `Restore the previous plugin from ${backup}`, installError);
          }
          throw installError;
        }
      } finally {
        unlock();
      }
      return { status: 'installed', installedVersion: release.version, backupPath: backup };
    } finally {
      this.installing = false;
      if (staging && (!backup || !fsSync.existsSync(backup))) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
