import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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

test('a late sidecar delivers queued work once after the owner stops', { skip: process.platform === 'win32' }, async (t) => {
  const appData = await mkdtemp(path.join(tmpdir(), 'swarm-direct-wake-'));
  const dataDir = path.join(appData, 'plugin_data', 'swarm-pi');
  const runtimeDir = path.join(appData, 'sidecar_data', 'swarm-pi', 'coordinator', 'data');
  const directory = path.join(dataDir, 'direct-wake');
  const conversationId = randomUUID();
  const transcriptPath = path.join(appData, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  function runHook(phase, toolCall) {
    return JSON.parse(execFileSync(process.execPath, [path.resolve('bin/coordinator-hook.mjs'), phase], {
      input: JSON.stringify({ transcriptPath, conversationId, toolCall }),
    }));
  }
  const binding = runHook('tool', {
    name: 'mcp_swarm-pi_pi_pi_create_swarm', args: {},
  }).overwrite.hostBinding;

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
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`, { mode: 0o700 });
  let sidecar;
  t.after(async () => {
    if (sidecar?.exitCode === null && sidecar.signalCode === null) {
      sidecar.kill();
      await new Promise((resolve) => sidecar.once('close', resolve));
    }
    await rm(appData, { recursive: true, force: true });
  });

  const { server, taskManager } = createSwarmPiServer({ dataDir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'direct-wake-test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = (name, args) => client.callTool({ name, arguments: args });
  async function success(name, args) {
    const result = await call(name, args);
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent;
  }
  const finish = new Map();
  taskManager.submit = async ({ cwd, label }) => ({ task_id: label, cwd });
  taskManager.waitForCompletion = (id) => new Promise((resolve) => finish.set(id, resolve));
  const coderResult = { status: 'completed', result_text: 'Private worker result' };
  const { id, coordinatorBound, coordinatorWakeReady } = await success('pi_create_swarm', {
    title: 'Direct watch', cwd: appData, hostBinding: binding,
    members: [{ name: 'coder' }, { name: 'verifier' }],
  });
  const pending = path.join(directory, 'pending', `${id}.json`);
  assert.equal(coordinatorBound, true);
  assert.equal(coordinatorWakeReady, false);
  const other = updateBinding(appData, randomUUID(), true, true);
  const denied = await call('pi_swarm_watch', { boardId: id, after: 0, hostBinding: other });
  assert.ok(denied.isError);
  assert.match(denied.content[0].text, /owning Antigravity conversation/);
  runHook('busy');

  await success('pi_swarm_post', { boardId: id, to: 'coder', text: 'Start first task' });
  await success('pi_swarm_post', { boardId: id, to: 'verifier', text: 'Start second task' });
  await until(() => finish.size === 2);
  finish.get('coder')(coderResult);
  await until(async () => (await success('pi_swarm_read', { boardId: id })).members[0].status === 'waiting');
  assert.equal(await readJson(pending), null, 'Routine progress must leave coordinator idle');
  finish.get('verifier')({ ...coderResult, result_text: 'Second private result' });
  await until(async () => (await readJson(pending))?.number === 4);
  sidecar = spawn(process.execPath, [path.resolve('sidecars/coordinator/main.mjs')], {
    env: { ...process.env, ANTIGRAVITY_EXECUTABLE_DATA_DIR: runtimeDir, PATH: `${executableDir}:${process.env.PATH}` },
    stdio: 'ignore',
  });
  await until(() => readJson(path.join(directory, 'ready.json')));
  assert.equal((await success('pi_swarm_read', { boardId: id })).coordinatorWakeReady, true);
  await delay(1250);
  assert.equal(await readFile(failFirst).catch(() => null), null, 'Busy coordinator must have no delivery attempt');
  assert.equal(await readJson(capture), null);
  runHook('idle');
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
  assert.match(args[2], /waitMs=0/);
  await until(async () => (await readJson(cursor))?.sent === 4);
  writeJsonAtomic(conversation, { ...(await readJson(conversation)), at: Date.now() - 16000 });
  await delay(1250);
  assert.deepEqual(await readJson(capture), args, 'The acknowledged cursor must stay silent on later scans');
  await success('pi_swarm_close', { boardId: id });
  assert.equal(await readJson(pending), null);
});

test('an unavailable sidecar does not lose coordinator posts or errors', async (t) => {
  const appData = await mkdtemp(path.join(tmpdir(), 'swarm-wake-targets-'));
  t.after(() => rm(appData, { recursive: true, force: true }));
  const dataDir = path.join(appData, 'plugin_data', 'swarm-pi');
  const wakeDir = path.join(dataDir, 'direct-wake');

  const hostBinding = updateBinding(appData, randomUUID(), false, true);
  const { boards, taskManager } = createSwarmPiServer({ dataDir });
  const finish = new Map();
  taskManager.submit = async ({ cwd, label }) => ({ task_id: label, cwd });
  taskManager.waitForCompletion = (id) => new Promise((resolve) => finish.set(id, resolve));
  const { id, coordinatorWakeReady } = await boards.create({
    title: 'Actionable reports', cwd: appData, hostBinding,
    members: [{ name: 'sender' }, { name: 'failing' }, { name: 'active' }],
  });
  const pending = path.join(wakeDir, 'pending', `${id}.json`);
  assert.equal(coordinatorWakeReady, false);

  for (const name of ['sender', 'failing', 'active']) await boards.post(id, 'coordinator', name, 'Start task');
  await until(() => finish.size === 3);
  finish.get('sender')({ status: 'completed', result_text: 'SWARM_POST @coordinator Action required' });
  await until(() => boards.read(id).members[0].status === 'waiting');
  assert.equal((await readJson(pending)).number, 5, 'An addressed report is queued while the sidecar is unavailable');
  assert.equal(boards.watch(id, 4, hostBinding).coordinatorWakeReady, false);
  finish.get('failing')({ status: 'failed', error_text: 'Fixture worker failed' });
  await until(async () => (await readJson(pending))?.number === 6);
  assert.equal(boards.read(id).members[2].status, 'working');
  writeJsonAtomic(path.join(wakeDir, 'ready.json'), { pid: process.pid });
  assert.equal(boards.watch(id, 4, hostBinding).coordinatorWakeReady, true);
  assert.equal((await readJson(pending)).number, 6, 'An earlier cursor must not replace a newer queued error');
  finish.get('active')({ status: 'completed', result_text: 'All done' });
  await until(async () => (await readJson(pending))?.number === 7);
});
