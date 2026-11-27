import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillPath = 'skills/swarm_pi/SKILL.md';
const workerPath = 'skills/swarm_pi/native-worker.md';

test('native Swarm defines an MCP-enabled monitor for an existing assignment', async () => {
  const skill = await fs.readFile(path.join(root, skillPath), 'utf8');
  const worker = await fs.readFile(path.join(root, workerPath), 'utf8');
  assert.match(skill, /`define_subagent`[\s\S]+?EnableMCPTools: true[\s\S]+?EnableWriteTools: false[\s\S]+?`invoke_subagent`/);
  assert.match(skill, /postedMessageNumber/);
  assert.match(skill, /pi_swarm_watch/);
  assert.match(worker, /call_mcp_tool/);
  assert.match(worker, /pi_swarm_read/);
  assert.match(worker, /replyTo/);
  assert.doesNotMatch(worker, /pi_submit_task/);
});
test('the release archives and installer retain the native worker prompt and bundled panel', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-release-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'source');
  await Promise.all([
    'plugin.json', 'mcp_config.json', 'hooks.json', 'README.md', 'README.zh-CN.md', 'LICENSE', 'install.sh',
    'assets', 'bin', 'sidecars', 'skills', 'scripts/pack-release.mjs', 'ui/dist/settings.html',
  ].map(async (entry) => {
    const target = path.join(fixture, entry);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(path.join(root, entry), target, { recursive: true });
  }));

  const release = JSON.parse(execFileSync(process.execPath, [path.join(fixture, 'scripts', 'pack-release.mjs')], {
    encoding: 'utf8',
  }));
  const tarDir = path.join(dir, 'tar');
  const zipDir = path.join(dir, 'zip');
  await Promise.all([fs.mkdir(tarDir), fs.mkdir(zipDir)]);
  execFileSync('tar', ['-xzf', release.tarGz.path, '-C', tarDir]);
  if (process.platform === 'win32') {
    execFileSync('tar', ['-xf', release.zip.path, '-C', zipDir]);
  } else {
    execFileSync('unzip', ['-q', release.zip.path, '-d', zipDir]);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'plugin.json'), 'utf8'));
  const extracted = path.join(tarDir, manifest.name);
  const pluginDirs = [zipDir, extracted];
  if (process.platform !== 'win32') {
    const target = path.join(dir, 'installed');
    execFileSync('bash', [path.join(extracted, 'install.sh'), '--target', target]);
    pluginDirs.push(target);
  }

  for (const entry of [
    skillPath, workerPath, 'ui/dist/settings.html', 'hooks.json', 'bin/coordinator-files.mjs', 'bin/coordinator-hook.mjs',
    'bin/host-binding.mjs', 'sidecars/coordinator/sidecar.json', 'sidecars/coordinator/main.mjs',
  ]) {
    const expected = await fs.readFile(path.join(root, entry));
    for (const pluginDir of pluginDirs) {
      assert.deepEqual(await fs.readFile(path.join(pluginDir, entry)), expected);
    }
  }
});
