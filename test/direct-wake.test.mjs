import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createSwarmPiServer } from '../src/server.mjs';
import { updateBinding } from '../bin/host-binding.mjs';
import { writeJsonAtomic } from '../bin/coordinator-files.mjs';

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
}

async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(40);
  }
  assert.fail('Timed out waiting for the coordinator wake');
}

test('Direct MCP waits for board events and wakes only its idle owner', { skip: process.platform === 'win32' }, async (t) => {
  const appData = await mkdtemp(path.join(tmpdir(), 'swarm-direct-wake-'));
  const dataDir = path.join(appData, 'plugin_data', 'swarm-pi');
  const runtimeDir = path.join(appData, 'sidecar_data', 'swarm-pi', 'coordinator', 'data');
  const directory = path.join(dataDir, 'direct-wake');
  const conversationId = randomUUID();
  const transcriptPath = path.join(appData, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  function hook(toolName) {
    return JSON.parse(execFileSync(process.execPath, [path.resolve('bin/coordinator-hook.mjs'), 'tool'], {
      input: JSON.stringify({ transcriptPath, conversationId, toolCall: {
        name: 'call_mcp_tool', args: { ServerName: 'swarm-pi_pi', ToolName: toolName, Arguments: {} },
      } }),
    })).overwrite.Arguments.hostBinding;
  }

  const capture = path.join(appData, 'capture.json');
  const failFirst = path.join(appData, 'attempted');
  const executableDir = path.join(appData, 'bin');
  await mkdir(executableDir, { recursive: true });
  await writeFile(path.join(executableDir, 'agentapi'), `#!${process.execPath}
const fs = require('node:fs');
if (!fs.existsSync(${JSON.stringify(failFirst)})) {
  fs.writeFileSync(${JSON.stringify(failFirst)}, '');
  process.exit(1);
}
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o700 });
  const sidecar = spawn(process.execPath, [path.resolve('sidecars/coordinator/main.mjs')], {
    env: { ...process.env, ANTIGRAVITY_EXECUTABLE_DATA_DIR: runtimeDir, PATH: `${executableDir}:${process.env.PATH}` },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (sidecar.exitCode === null && sidecar.signalCode === null) {
      sidecar.kill();
      await new Promise((resolve) => sidecar.once('close', resolve));
    }
    await rm(appData, { recursive: true, force: true });
  });

  const { boards, taskManager } = createSwarmPiServer({ dataDir });
  const finish = new Map();
  taskManager.submit = async ({ cwd, label }) => ({ task_id: label, cwd });
  taskManager.waitForCompletion = (id) => new Promise((resolve) => finish.set(id, resolve));
  const coderResult = { status: 'completed', result_text: 'Private worker result' };
  const { id } = await boards.create({
    title: 'Direct watch', cwd: appData, hostBinding: hook('pi_create_swarm'),
    members: [{ name: 'coder' }, { name: 'verifier' }],
  });
  const pending = path.join(directory, 'pending', `${id}.json`);
  await until(() => readJson(path.join(directory, 'ready.json')));
  const other = updateBinding(appData, randomUUID(), true, true);
  assert.throws(() => boards.watch(id, 0, other), /owning Antigravity conversation/);
  assert.equal(boards.watch(id, 0, hook('pi_swarm_watch')).coordinatorWakeReady, true);

  await boards.post(id, 'coordinator', 'coder', 'Start first task');
  await boards.post(id, 'coordinator', 'verifier', 'Start second task');
  await until(() => finish.size === 2);
  finish.get('coder')(coderResult);
  await until(() => boards.read(id).members[0].status === 'waiting');
  assert.equal(await readJson(pending), null, 'Routine progress must leave coordinator idle');
  finish.get('verifier')({ ...coderResult, result_text: 'Second private result' });
  await until(async () => (await readJson(pending))?.number === 4);
  assert.equal(await readJson(capture), null);
  updateBinding(appData, conversationId, true);
  await until(() => readFile(failFirst).catch(() => null));
  assert.equal(await readJson(capture), null);
  const dispatch = path.join(directory, 'dispatch');
  const cursor = path.join(dispatch, `${id}.json`);
  const conversation = path.join(dispatch, `conversation-${conversationId}.json`);
  const firstAttempt = await readJson(cursor);
  assert.equal(firstAttempt.sent, 0, 'Failed host delivery must remain pending');
  writeJsonAtomic(cursor, { ...firstAttempt, attemptedAt: Date.now() - 16000 });
  writeJsonAtomic(conversation, { ...(await readJson(conversation)), at: Date.now() - 16000 });
  const args = await until(() => readJson(capture));
  assert.deepEqual(args.slice(0, 2), ['send-message', conversationId]);
  assert.ok(args[2].includes(id) && args[2].includes('#4') && !args[2].includes('private'));
  await until(async () => (await readJson(cursor))?.sent === 4);
  await boards.close(id);
  assert.equal(await readJson(pending), null);
});
