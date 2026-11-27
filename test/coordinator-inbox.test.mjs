import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { updateBinding } from '../bin/host-binding.mjs';
import { createSwarmPiServer } from '../src/server.mjs';
import trace from './fixtures/coordinator-replay.json' with { type: 'json' };

async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'swarm-coordinator-'));
  const dataDir = path.join(cwd, 'plugin_data', 'swarm-pi');
  const binding = updateBinding(cwd, randomUUID(), false, true);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  async function start() {
    const runtime = createSwarmPiServer({ dataDir });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'inbox-test', version: '1' });
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);
    const close = async () => {
      await client.close();
      await runtime.server.close();
    };
    t.after(close);
    const call = (name, args) => client.callTool({ name, arguments: args });
    const success = async (name, args) => {
      const result = await call(name, args);
      assert.ok(!result.isError, JSON.stringify(result));
      return { value: result.structuredContent, bytes: Buffer.byteLength(result.content[0].text) };
    };
    return { ...runtime, call, success, close };
  }
  return { cwd, binding, start };
}

function sampleText(chars, bytes) {
  const extra = bytes - chars;
  const threeByte = Math.floor(extra / 2);
  const twoByte = extra % 2;
  assert.ok(extra >= 0 && threeByte + twoByte <= chars);
  return '字'.repeat(threeByte) + 'é'.repeat(twoByte) + 'x'.repeat(chars - threeByte - twoByte);
}

test('60-post coordinator replay uses the original sequence, routes, and JSON text sizes', async (t) => {
  const { cwd, binding, start } = await fixture(t);
  const { boards, taskManager, success } = await start();
  const actors = trace.actors;
  const members = actors.slice(1, 4).map((name) => ({ name, brief: 'worker brief '.repeat(45) }));
  const { value: { id: boardId } } = await success('pi_create_swarm', {
    cwd, title: 'Coordinator replay', members, hostBinding: binding,
  });
  const board = boards.get(boardId);
  const inputs = trace.messages.map(([number, sender, recipient, kind, replyTo, chars, previewBytes, bytes, taskIdSize]) => {
    const previewChars = Math.min(chars, 500);
    return {
      number, from: actors[sender], to: actors[recipient], kind, replyTo: replyTo ?? undefined,
      text: sampleText(previewChars, previewBytes) + sampleText(chars - previewChars, bytes - previewBytes),
      taskId: taskIdSize ? ('task-' + String(replyTo).padStart(taskIdSize - 5, '0')) : undefined,
    };
  });
  const started = [];
  const finish = new Map();
  taskManager.submit = async ({ prompt, cwd: workDir, label }) => {
    const number = Number(prompt.match(/Board message #(\d+) from/)[1]);
    assert.equal(board.messages[number - 1].to, label);
    started.push(number);
    return { task_id: 'task-' + String(number).padStart(13, '0'), cwd: workDir };
  };
  taskManager.waitForCompletion = async (taskId) => new Promise((resolve) => finish.set(taskId, resolve));

  let receiptBytes = 0;
  let inboxBytes = 0;
  let lookupBytes = 0;
  let readCalls = 0;
  let repeatedReceipts = 0;
  const handled = [];
  for (const [step, , head, posted] of trace.returns) {
    while (board.messages.length < head) {
      const entry = inputs[board.messages.length];
      if (entry.from === 'coordinator') {
        const args = {
          boardId, to: entry.to, text: entry.text, hostBinding: binding,
          assignmentKey: 'dispatch-' + entry.number,
        };
        const sends = await Promise.all([
          success('pi_swarm_post', args),
          success('pi_swarm_post', args),
        ]);
        for (const { value } of sends) assert.deepEqual(value, { postedMessageNumber: entry.number });
        receiptBytes += sends[0].bytes;
        repeatedReceipts += 1;
      } else {
        assert.equal(entry.kind, 'result');
        const handoffs = [];
        for (const next of inputs.slice(entry.number)) {
          if (next.kind !== 'message' || next.from !== entry.from || next.replyTo !== entry.replyTo) break;
          handoffs.push('SWARM_POST @' + next.to + ' ' + next.text);
        }
        assert.ok(finish.has(entry.taskId), 'The original task must be running for reply #' + entry.number);
        finish.get(entry.taskId)({
          status: 'completed', result_text: [entry.text, ...handoffs].join('\n'),
        });
        finish.delete(entry.taskId);
      }
      await setImmediate();
    }
    assert.equal(board.messages.length, head, 'Board head at captured tool result ' + step);
    if (step === 50 || posted) continue;
    let page;
    do {
      const result = await success('pi_swarm_inbox', { boardId, hostBinding: binding });
      page = result.value;
      readCalls += 1;
      inboxBytes += result.bytes;
      for (const { number, truncated, ...notice } of page.messages) {
        const original = inputs[number - 1];
        assert.equal(notice.replyTo, original.replyTo);
        assert.equal(board.messages[notice.resultNumber - 1].kind, 'result');
        assert.equal(board.messages[notice.resultNumber - 1].replyTo, original.replyTo);
        assert.equal(notice.text, original.text.slice(0, 500));
        if (truncated) {
          const lookup = await success('pi_swarm_read', { boardId, messageNumber: number });
          assert.equal(lookup.value.text, original.text);
          lookupBytes += lookup.bytes;
        }
        handled.push(number);
      }
      if (page.pageThrough > page.handledThrough) {
        const ack = await success('pi_swarm_inbox', { boardId, hostBinding: binding, ackThrough: page.pageThrough });
        assert.equal(ack.value.handledThrough, page.pageThrough);
        inboxBytes += ack.bytes;
      }
    } while (page.hasMore);
  }

  assert.deepEqual(handled, inputs.filter(({ to }) => to === 'coordinator').map(({ number }) => number));
  const expectedWorkerPosts = inputs.filter(({ to }) => to && to !== 'coordinator').map(({ number }) => number);
  const remaining = expectedWorkerPosts.filter((number) => !started.includes(number));
  assert.deepEqual(remaining, [37, 40]);
  for (const { number, from, to, kind, replyTo, text } of inputs) {
    const actual = boards.message(boardId, number);
    assert.deepEqual([actual.from, actual.to, actual.kind, actual.replyTo, actual.text], [from, to, kind, replyTo, text]);
  }
  const last = await success('pi_swarm_inbox', { boardId, hostBinding: binding });
  assert.equal(last.value.handledThrough, 60);
  assert.equal(last.value.hasMore, false);
  assert.deepEqual(last.value.messages, []);

  // The later capture showed #28 and #40 hitting the shared chain limit.
  // Bodies of the rejected handoffs were absent, so their intent is represented by fixtures.
  const followUps = new Map([
    [28, 'SWARM_POST @verifier Review the new patch\nSWARM_POST @coder-b Check the integration'],
    [37, 'SWARM_POST @verifier Review the follow-up patch'],
    [40, 'SWARM_POST @verifier Verify the last change'],
  ]);
  while (finish.size) {
    const active = [...finish];
    finish.clear();
    for (const [taskId, complete] of active) {
      const number = Number(taskId.slice(5));
      complete({ status: 'completed', result_text: followUps.get(number) ?? 'Replay stop' });
    }
    await setImmediate();
  }
  const completedOriginal = started.filter((number) => number <= 60).sort((a, b) => a - b);
  assert.deepEqual(completedOriginal, expectedWorkerPosts);
  assert.equal(new Set(started).size, started.length);
  const continued = board.messages.slice(60).filter(({ to }) => to && to !== 'coordinator');
  assert.deepEqual(continued.map(({ to, replyTo }) => [to, replyTo]), [
    ['verifier', 28], ['coder-b', 28], ['verifier', 37], ['verifier', 40],
  ]);
  assert.ok(continued.every(({ number }) => started.includes(number)));
  assert.equal(board.messages.some(({ kind }) => kind === 'error'), false);

  const oldBytes = trace.returns.slice(1).reduce((total, [, bytes]) => total + bytes, 0);
  assert.equal(oldBytes, 312372);
  assert.ok((receiptBytes + inboxBytes + lookupBytes) < oldBytes / 5);
  t.diagnostic(JSON.stringify({
    posts: inputs.length, workersStarted: completedOriginal.length, coordinatorMessages: handled.length,
    originalWakeNotifications: trace.wakes.length, readCalls, repeatedReceipts, oldBytes,
    receiptBytes, inboxBytes, lookupBytes, withAllTruncatedPosts: receiptBytes + inboxBytes + lookupBytes,
  }));
});

test('inbox pagination, replay after restart, and assignment retry respect the board owner', async (t) => {
  const { cwd, binding, start } = await fixture(t);
  const first = await start();
  const { value: { id: boardId } } = await first.success('pi_create_swarm', {
    cwd, title: 'Restart test', members: [{ name: 'coder' }], hostBinding: binding,
  });
  const board = first.boards.get(boardId);
  for (const [n, to, kind] of [[1, 'coder', 'message'], [2, 'coordinator', 'message'], [3, null, 'error']]) {
    first.boards.append(board, { from: 'system', to, kind, text: 'Fixture ' + n });
  }
  const inbox = async (server, options) => (await server.success('pi_swarm_inbox', { boardId, hostBinding: binding, ...options })).value;
  const premature = await first.call('pi_swarm_inbox', { boardId, hostBinding: binding, ackThrough: 3 });
  assert.equal(premature.isError, true);
  const foreign = updateBinding(cwd, randomUUID(), false, true);
  assert.equal((await first.call('pi_swarm_inbox', { boardId, hostBinding: foreign })).isError, true);

  const page = await inbox(first, { limit: 1 });
  assert.deepEqual(page.messages.map(({ number }) => number), [2]);
  assert.equal(page.pageThrough, 2);
  assert.equal(page.hasMore, true);
  assert.deepEqual(await inbox(first, { ackThrough: page.pageThrough }), { handledThrough: 2 });
  const stillUnconfirmed = await inbox(first, {});
  assert.deepEqual(stillUnconfirmed.messages.map(({ number }) => number), [3]);

  let executions = 0;
  let complete;
  first.taskManager.submit = async () => {
    executions += 1;
    return { task_id: 'worker-task', cwd };
  };
  first.taskManager.waitForCompletion = () => new Promise((resolve) => { complete = resolve; });
  const assignment = { boardId, hostBinding: binding, to: 'coder', text: 'Follow up', replyTo: 3, assignmentKey: 'post-3-followup' };
  const post = (server, options) => server.success('pi_swarm_post', { ...assignment, ...options });
  assert.deepEqual((await post(first)).value, { postedMessageNumber: 4 });
  assert.deepEqual((await post(first, { assignmentKey: 'other-queued-assignment' })).value, { postedMessageNumber: 5 });
  await setImmediate();
  assert.ok(complete);
  assert.equal(executions, 1);

  await first.close();
  const restarted = await start();
  restarted.taskManager.submit = async () => { executions += 1; };
  assert.deepEqual((await post(restarted)).value, { postedMessageNumber: 4 });
  assert.deepEqual((await post(restarted, { assignmentKey: 'other-queued-assignment' })).value, { postedMessageNumber: 5 });
  const conflict = await restarted.call('pi_swarm_post', { ...assignment, text: 'Different task' });
  assert.match(conflict.content[0].text, /already posted as #4/);
  assert.equal(executions, 1);

  const recovery = await inbox(restarted, {});
  assert.equal(recovery.handledThrough, 2);
  assert.deepEqual(recovery.messages.map(({ number, replyTo }) => [number, replyTo]), [
    [3, undefined], [6, 4], [7, 5],
  ]);
  assert.equal(recovery.messages[1].taskId, 'worker-task');
  assert.equal(recovery.messages[2].taskId, undefined);
  await inbox(restarted, { ackThrough: recovery.pageThrough });
  assert.deepEqual((await inbox(restarted, {})).messages, []);
  await restarted.close();

  const again = await start();
  assert.equal((await inbox(again, {})).handledThrough, 7);
  assert.equal(again.boards.get(boardId).messages.length, 7);
});


test('a fresh bundled MCP process reads the saved inbox and returns the original receipt', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'swarm-stdio-restart-'));
  const dataDir = path.join(cwd, 'plugin_data', 'swarm-pi');
  const hostBinding = updateBinding(cwd, randomUUID(), false, true);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let boardId;
  async function connect(run) {
    const client = new Client({ name: 'restart-test', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['bin/server.bundle.mjs', '--data-dir', dataDir],
    });
    try {
      await client.connect(transport);
      await run(async (name, args) => {
        const result = await client.callTool({ name, arguments: { hostBinding, ...args } });
        assert.ok(!result.isError, JSON.stringify(result));
        return result.structuredContent;
      });
    } finally {
      await client.close();
    }
  }

  const assignment = { to: 'coordinator', text: 'Needs review', assignmentKey: 'review' };
  await connect(async (call) => {
    const board = await call('pi_create_swarm', { cwd, title: 'Restart test', members: [{ name: 'coder' }] });
    boardId = board.id;
    assert.deepEqual(await call('pi_swarm_post', { ...assignment, boardId }), { postedMessageNumber: 1 });
    const page = await call('pi_swarm_inbox', { boardId });
    assert.equal(page.pageThrough, 1);
    assert.equal(page.messages[0].text, 'Needs review');
  });
  await connect(async (call) => {
    assert.deepEqual(await call('pi_swarm_post', { ...assignment, boardId }), { postedMessageNumber: 1 });
    const page = await call('pi_swarm_inbox', { boardId });
    assert.equal(page.handledThrough, 0);
    assert.deepEqual(page.messages.map(({ number }) => number), [1]);
    assert.deepEqual(await call('pi_swarm_inbox', { boardId, ackThrough: page.pageThrough }), { handledThrough: 1 });
  });
  await connect(async (call) => {
    const page = await call('pi_swarm_inbox', { boardId });
    assert.equal(page.handledThrough, 1);
    assert.deepEqual(page.messages, []);
  });
});

test('automatic routing pauses repeated loops and runaway chains with the full pending handoff preserved', async (t) => {
  for (const [reason, expectedTurns] of [['repeated', 5], ['limit', 65]]) {
    await t.test(reason, async (st) => {
      const { cwd, binding, start } = await fixture(st);
      const { boards, taskManager, success } = await start();
      const { value: { id: boardId } } = await success('pi_create_swarm', {
        cwd, title: 'Peer handoff guard', members: [{ name: 'coder' }, { name: 'verifier' }], hostBinding: binding,
      });
      const tasks = [];
      taskManager.submit = async ({ label }) => {
        const task = { task_id: String(tasks.length + 1), label, cwd };
        tasks.push(task);
        return task;
      };
      taskManager.waitForCompletion = async (taskId) => {
        const recipient = tasks[Number(taskId) - 1].label === 'coder' ? 'verifier' : 'coder';
        const text = reason === 'repeated' ? 'Check the patch' : 'Review revision ' + taskId;
        return { status: 'completed', result_text: [
          'SWARM_POST @' + recipient + ' ' + text,
          'SWARM_POST @' + recipient + ' ' + text.replace(' ', '  '),
        ].join('\n') };
      };
      await success('pi_swarm_post', {
        boardId, hostBinding: binding, to: 'coder', text: 'Start', assignmentKey: 'start',
      });
      await setImmediate();

      assert.equal(tasks.length, expectedTurns);
      assert.equal(boards.settled(boards.get(boardId)), true);
      const page = (await success('pi_swarm_inbox', { boardId, hostBinding: binding })).value;
      assert.equal(page.messages.length, 1);
      const notice = page.messages[0];
      assert.equal(notice.kind, 'error');
      assert.deepEqual(notice.pendingHandoff, { to: 'verifier', reason });
      const { value: original } = await success('pi_swarm_read', { boardId, messageNumber: notice.number });
      assert.deepEqual(original.pendingHandoff, {
        to: 'verifier', reason, text: reason === 'repeated' ? 'Check the patch' : 'Review revision 65',
      });
      assert.equal(boards.message(boardId, notice.replyTo).to, 'coder');
    });
  }
});
