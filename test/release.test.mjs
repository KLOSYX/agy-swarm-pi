import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const agentPath = 'agents/swarm-pi-worker.md';

test('Antigravity worker proxy declares a native subagent with MCP and scheduling tools', async () => {
  const agent = await fs.readFile(path.join(root, agentPath), 'utf8');
  const frontmatter = agent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(frontmatter, 'Expected a YAML frontmatter block');
  assert.match(frontmatter[1], /^name: swarm-pi-worker$/m);
  assert.match(frontmatter[1], /^description: .+swarm-pi_pi.+wakes the main coordinator.+$/m);
  assert.match(frontmatter[1], /^subagent: true$/m);
  assert.match(frontmatter[1], /^mainAgent: false$/m);
  assert.match(frontmatter[1], /^tools: \[call_mcp_tool, schedule\]$/m);
  assert.match(frontmatter[1], /^model: flash_lite$/m);
});

test('the release archives and installer retain the worker proxy and bundled panel', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-release-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'source');
  await Promise.all([
    'plugin.json', 'mcp_config.json', 'README.md', 'README.zh-CN.md', 'LICENSE', 'install.sh',
    'agents', 'assets', 'bin', 'skills', 'scripts/pack-release.mjs', 'ui/dist/settings.html',
  ].map(async (entry) => {
    const target = path.join(fixture, entry);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(path.join(root, entry), target, { recursive: true });
  }));

  const script = await fs.readFile(path.join(fixture, 'install.sh'), 'utf8');
  assert.ok(script.split(/\r?\n/).some((line) => line.trim() === 'agents \\'));

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

  for (const entry of [agentPath, 'ui/dist/settings.html']) {
    const expected = await fs.readFile(path.join(root, entry));
    for (const pluginDir of pluginDirs) {
      assert.deepEqual(await fs.readFile(path.join(pluginDir, entry)), expected);
    }
  }
});
