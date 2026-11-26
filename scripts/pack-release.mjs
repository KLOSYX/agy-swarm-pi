import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');

const INCLUDE_PATHS = [
  'plugin.json',
  'mcp_config.json',
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'install.sh',
  'assets/logo.svg',
  'bin/start-server.sh',
  'bin/server.bundle.mjs',
  'skills/swarm_pi/SKILL.md',
  'ui/dist/settings.html',
];

async function sha256File(filePath) {
  const data = await fs.readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

async function copyEntry(srcRoot, dstRoot, relPath) {
  const src = path.join(srcRoot, relPath);
  const dst = path.join(dstRoot, relPath);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
  const st = await fs.stat(src);
  await fs.chmod(dst, st.mode);
}

async function pack() {
  const manifest = JSON.parse(
    await fs.readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'),
  );
  const version = manifest.version || '0.1.0';
  const name = manifest.name || 'swarm-pi';
  const baseName = `${name}-v${version}`;

  const distDir = path.join(pluginRoot, 'dist');
  const stageDir = path.join(distDir, '.stage', name);
  await fs.rm(path.join(distDir, '.stage'), { recursive: true, force: true });
  await fs.mkdir(stageDir, { recursive: true });

  for (const relPath of INCLUDE_PATHS) {
    await copyEntry(pluginRoot, stageDir, relPath);
  }

  const zipPath = path.join(distDir, `${baseName}.zip`);
  const tarPath = path.join(distDir, `${baseName}.tar.gz`);
  await fs.rm(zipPath, { force: true });
  await fs.rm(tarPath, { force: true });

  // Package with `swarm-pi/` as top-level folder in tar.gz, and root files in zip (tested with `agy plugin validate`)
  execFileSync('tar', ['-czf', tarPath, '-C', path.join(distDir, '.stage'), name], {
    stdio: 'inherit',
  });
  execFileSync('zip', ['-rq', zipPath, '.'], {
    cwd: stageDir,
    stdio: 'inherit',
  });

  await fs.rm(path.join(distDir, '.stage'), { recursive: true, force: true });

  const zipHash = await sha256File(zipPath);
  const tarHash = await sha256File(tarPath);
  await fs.writeFile(`${zipPath}.sha256`, `${zipHash}  ${path.basename(zipPath)}\n`);
  await fs.writeFile(`${tarPath}.sha256`, `${tarHash}  ${path.basename(tarPath)}\n`);

  const zipStat = await fs.stat(zipPath);
  const tarStat = await fs.stat(tarPath);

  console.log(
    JSON.stringify(
      {
        version,
        files: INCLUDE_PATHS.length,
        zip: { path: zipPath, bytes: zipStat.size, sha256: zipHash },
        tarGz: { path: tarPath, bytes: tarStat.size, sha256: tarHash },
      },
      null,
      2,
    ),
  );
}

pack().catch((err) => {
  console.error(err);
  process.exit(1);
});
