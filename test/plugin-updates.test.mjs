import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import tar from 'tar-stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSwarmPiServer } from '../src/server.mjs';
import { PluginUpdates } from '../src/plugin-updates.mjs';
import pluginManifest from '../plugin.json' with { type: 'json' };

const installedVersion = pluginManifest.version;
const version = '0.10.0';
const asset = `swarm-pi-v${version}.tar.gz`;

async function archiveFixture(extra = []) {
  const archive = tar.pack();
  const data = (async () => {
    const parts = [];
    for await (const chunk of archive) parts.push(chunk);
    return gzipSync(Buffer.concat(parts));
  })();
  for (const [name, text] of [
    ['plugin.json', JSON.stringify({ name: 'swarm-pi', version })],
    ['mcp_config.json', '{}'],
    ['bin/server.bundle.mjs', 'new bundle'],
    ['ui/dist/settings.html', '<title>New panel</title>'],
    ...extra,
  ]) {
    archive.entry({ name: `swarm-pi/${name}` }, text);
  }
  archive.finalize();
  return data;
}

async function fixture(t, { extra, badHash = false, rateLimited = false, duringDownload } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-updater-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'plugins', 'swarm-pi');
  const dataDir = path.join(dir, 'plugin-data');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(root, 'plugin.json'), JSON.stringify({ name: 'swarm-pi', version: installedVersion }));
  await fs.writeFile(path.join(root, 'old-file'), 'previous bundle');
  await fs.writeFile(path.join(dataDir, 'settings.json'), '{}');
  const archive = await archiveFixture(extra);
  const digest = badHash ? '0'.repeat(64) : createHash('sha256').update(archive).digest('hex');
  const urls = [];
  async function fetchRelease(url, options) {
    urls.push(url);
    if (url === 'https://api.github.com/repos/KLOSYX/agy-swarm-pi/releases/latest') {
      if (rateLimited) return new Response(null, { status: 403 });
      return Response.json({ tag_name: `v${version}`, assets: [asset, `${asset}.sha256`].map((name) => ({ name, state: 'uploaded' })) });
    }
    if (url === 'https://github.com/KLOSYX/agy-swarm-pi/releases/latest') {
      assert.equal(options.method, 'HEAD');
      return Response.redirect(`https://github.com/KLOSYX/agy-swarm-pi/releases/tag/v${version}`, 302);
    }
    const base = `https://github.com/KLOSYX/agy-swarm-pi/releases/download/v${version}/`;
    if (url === `${base}${asset}.sha256`) return new Response(`${digest}  ${asset}\n`);
    if (url === `${base}${asset}`) {
      duringDownload?.();
      return Response.redirect(`https://release-assets.githubusercontent.com/${asset}`, 302);
    }
    assert.equal(url, `https://release-assets.githubusercontent.com/${asset}`);
    return new Response(archive);
  }
  return { root, dir, dataDir, urls, fetchRelease };
}

test('the panel checks explicitly, confirms installation, and preserves plugin data and the old version', async (t) => {
  const { root, dataDir, urls, fetchRelease } = await fixture(t);
  const { server, taskManager, boards } = createSwarmPiServer({ dataDir, pluginRoot: root, updateFetch: fetchRelease });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'panel-update-test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  assert.equal((await call('app_get_state')).structuredContent.pluginVersion, installedVersion);
  assert.deepEqual(urls, []);
  const install = { expectedVersion: version, confirmed: true };
  assert.equal((await call('app_install_update', { ...install, confirmed: false })).isError, true);
  assert.deepEqual(urls, []);
  const check = (await call('app_check_update')).structuredContent;
  assert.equal(check.latestVersion, version);
  assert.equal(check.available, true);
  assert.equal(check.installBlock, null);
  assert.equal(check.releaseUrl, `https://github.com/KLOSYX/agy-swarm-pi/releases/tag/v${version}`);
  assert.equal(urls.length, 1);
  taskManager.pendingStarts = 1;
  assert.equal((await call('app_install_update', install)).structuredContent.code, 'activeWork');
  assert.equal(urls.length, 1);
  taskManager.pendingStarts = 0;

  const board = await boards.create({ title: 'Idle board', cwd: dataDir, members: [{ name: 'worker' }] });
  const worker = boards.get(board.id).roster.get('worker');
  worker.queue.push({ assignment: 'test' });
  assert.equal((await call('app_install_update', install)).structuredContent.code, 'activeWork');
  worker.queue.length = 0;
  assert.equal((await call('app_check_update')).structuredContent.openBoards, 1);

  const result = (await call('app_install_update', install)).structuredContent;
  assert.equal(result.status, 'installed', JSON.stringify(result));
  assert.equal(result.installedVersion, version);
  assert.equal(await fs.readFile(path.join(result.backupPath, 'old-file'), 'utf8'), 'previous bundle');
  assert.equal(await fs.readFile(path.join(root, 'bin/server.bundle.mjs'), 'utf8'), 'new bundle');
  assert.equal(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'), '{}');
  assert.equal(boards.read(board.id).id, board.id);
  assert.equal((await call('app_check_update')).structuredContent.pendingReload, true);
  assert.equal((await call('app_install_update', install)).structuredContent.code, 'reloadRequired');
});

test('checksum or unsafe archive entries leave the current plugin intact', async (t) => {
  for (const [options, reason] of [
    [{ badHash: true }, 'SHA-256'],
    [{ extra: [['../outside', 'blocked']] }, 'Unsupported archive entry'],
  ]) {
    const { root, dir, dataDir, fetchRelease } = await fixture(t, options);
    const updates = new PluginUpdates({ root, dataDir, version: installedVersion, fetchRelease, hasActiveWork: () => false, openBoards: () => 0 });
    await assert.rejects(updates.install(version), new RegExp(reason));
    assert.equal(await fs.readFile(path.join(root, 'old-file'), 'utf8'), 'previous bundle');
    await assert.rejects(fs.stat(path.join(dir, 'outside')), { code: 'ENOENT' });
  }
});

test('an install rechecks work at activation and keeps the current directory if promotion fails', async (t) => {
  let active = false;
  let startDuringDownload = true;
  const { root, dataDir, fetchRelease } = await fixture(t, {
    duringDownload() { active = startDuringDownload; },
  });
  const updates = new PluginUpdates({ root, dataDir, version: installedVersion, fetchRelease, hasActiveWork: () => active, openBoards: () => 0 });
  await assert.rejects(updates.install(version), { code: 'activeWork' });
  assert.equal(await fs.readFile(path.join(root, 'old-file'), 'utf8'), 'previous bundle');

  active = false;
  startDuringDownload = false;
  const rename = fsSync.renameSync;
  t.mock.method(fsSync, 'renameSync', (source, target) => {
    if (target === root && path.basename(source) === 'swarm-pi') throw new Error('Fixture promotion failed');
    return rename(source, target);
  });
  await assert.rejects(updates.install(version), /Fixture promotion failed/);
  assert.equal(await fs.readFile(path.join(root, 'old-file'), 'utf8'), 'previous bundle');
});

test('Git and in-directory data installs are identified without modifying them', async (t) => {
  const { root, dataDir, fetchRelease } = await fixture(t);
  const updates = new PluginUpdates({ root, dataDir, version: installedVersion, fetchRelease, hasActiveWork: () => false, openBoards: () => 0 });
  await fs.mkdir(path.join(root, '.git'));
  assert.equal((await updates.check()).installBlock, 'gitCheckout');
  await assert.rejects(updates.install(version), { code: 'gitCheckout' });
  await fs.rmdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.data'));
  assert.equal((await updates.check()).installBlock, 'dataInPlugin');
  await assert.rejects(updates.install(version), { code: 'dataInPlugin' });
});

test('the public release page provides update checks when the GitHub API is rate limited', async (t) => {
  const { root, dataDir, fetchRelease } = await fixture(t, { rateLimited: true });
  const updates = new PluginUpdates({ root, dataDir, version: installedVersion, fetchRelease, hasActiveWork: () => false, openBoards: () => 0 });
  const available = await updates.check();
  assert.equal(available.latestVersion, version);
  assert.equal(available.available, true);
  assert.equal(available.installBlock, null);
});
