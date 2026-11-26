import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSwarmPiServer } from '../src/server.mjs';

test('MCP board routes peer and user messages to the same worker session and worktree', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'swarm-board-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { server, taskManager } = createSwarmPiServer({ dataDir: cwd });
  const turns = [];
  const taskWorktree = path.join(cwd, 'coder-worktree');
  let finishFirstTurn;
  const firstTurn = new Promise((resolve) => { finishFirstTurn = resolve; });
  const replies = [
    'SWARM_POST @verifier Please review',
    'SWARM_POST @coder Fix the lower bound',
    'SWARM_POST @verifier Please recheck',
    'SWARM_POST @coordinator PASS',
    'User follow-up completed',
  ];
  taskManager.submit = async (args) => {
    turns.push(args);
    const taskId = String(turns.length);
    const cwd = args.worktree ? taskWorktree : args.cwd;
    const worktree = args.worktree ? { branch: 'swarm-pi/coder', path: taskWorktree, cleaned: false } : null;
    const logPath = path.join(cwd, `${taskId}.log`);
    const createdAt = Date.now();
    const stdout = [
      { type: 'tool_execution_start', toolName: 'read' },
      { type: 'message_end', message: { role: 'assistant', provider: 'test', model: 'model' } },
    ].map((event) => JSON.stringify(event)).join('\n');
    taskManager.tasks.set(taskId, {
      taskId, cwd, worktree, logPath, createdAt, stdout, stderr: '', status: 'running',
      profile: { harness: 'pi', model: 'configured/model' },
    });
    return {
      task_id: taskId, cwd, worktree, log_path: logPath,
    };
  };
  taskManager.waitForCompletion = async (id) => {
    const task = taskManager.tasks.get(id);
    if (id === '1') await firstTurn;
    task.status = 'completed';
    task.endedAt = task.createdAt + 12;
    return { ...taskManager.formatTaskSnapshot(task), result_text: replies[Number(id) - 1] };
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'board-test', version: '1' });
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

  const { id: boardId, members } = await success('pi_create_swarm', {
    title: 'Board test', cwd, members: [
      { name: 'coder', worktree: true, brief: 'Fix the lower bound' }, { name: 'verifier' },
    ],
  });
  assert.deepEqual(members.map(({ brief }) => brief), ['Fix the lower bound', '']);
  assert.ok(members.every((member) => !Object.hasOwn(member, 'latestTask')));
  assert.equal((await call('pi_swarm_post', { boardId, to: 'missing', text: 'Bad recipient' })).isError, true);
  const posted = await success('pi_swarm_post', { boardId, to: 'coder', text: 'Start' });
  assert.equal(posted.postedMessageNumber, 1);
  const active = (await success('app_read_board', { boardId })).members[0];
  assert.equal(active.status, 'working');
  assert.equal(active.latestTask.status, 'running');
  assert.equal(active.latestTask.taskId, '1');
  assert.deepEqual(active.latestTask.toolCalls, ['read']);
  assert.ok(active.latestTask.elapsedMs >= 0);
  finishFirstTurn();
  await setImmediate();
  const final = await success('pi_swarm_read', { boardId });
  assert.deepEqual(final.messages.filter((message) => message.to).map(({ from, to }) => [from, to]), [
    ['coordinator', 'coder'], ['coder', 'verifier'], ['verifier', 'coder'],
    ['coder', 'verifier'], ['verifier', 'coordinator'],
  ]);
  assert.equal(turns[0].sessionKey, turns[2].sessionKey);
  assert.equal(turns[1].sessionKey, turns[3].sessionKey);
  assert.notEqual(turns[0].sessionKey, turns[1].sessionKey);
  assert.equal(turns[2].cwd, taskWorktree);
  assert.equal(turns[2].worktree, false);
  assert.ok(turns[1].prompt.includes(taskWorktree));
  const [coder, verifier] = final.members;
  assert.equal(coder.taskId, '3');
  assert.equal(coder.worktreeTaskId, '1');
  assert.equal(coder.status, 'waiting');
  assert.equal(coder.actualModel, 'test/model');
  assert.equal(coder.brief, 'Fix the lower bound');
  assert.deepEqual(coder.latestTask, {
    taskId: '3', status: 'completed', elapsedMs: 12, toolCalls: ['read'],
    configuredModel: 'configured/model', actualModel: 'test/model', worktreeBranch: 'swarm-pi/coder',
    worktreePath: taskWorktree, worktreeCleaned: false, logPath: path.join(taskWorktree, '3.log'),
  });
  assert.equal(verifier.latestTask.worktreeBranch, null);
  assert.equal(verifier.latestTask.worktreePath, null);
  const panel = await success('open_pi_swarm_settings', { tab: 'board', boardId });
  assert.deepEqual(panel.initialBoard.members, final.members);

  const { id: otherBoardId } = await success('pi_create_swarm', {
    title: 'Other board', cwd, members: [{ name: 'coder' }],
  });
  assert.deepEqual((await success('pi_swarm_read', { boardId: otherBoardId })).messages, []);
  assert.deepEqual((await success('app_read_board', { boardId })).boards.map(({ id }) => id), [
    otherBoardId, boardId,
  ]);

  const waiting = success('pi_swarm_read', { boardId, after: final.lastMessage, waitMs: 1000 });
  await success('app_post_board', { boardId, to: 'coder', text: 'Follow-up from the panel' });
  assert.equal((await waiting).messages[0].from, 'user');
  const followUp = await success('app_read_board', { boardId, after: final.lastMessage });
  assert.equal(followUp.messages[1].text, 'User follow-up completed');
  assert.equal(followUp.members[0].latestTask.taskId, '5');
  assert.equal(followUp.members[0].latestTask.logPath, path.join(taskWorktree, '5.log'));
  assert.equal(turns[4].sessionKey, turns[0].sessionKey);
  assert.equal(turns[4].cwd, taskWorktree);

  assert.ok(taskManager.worktreeLeases.has('1'));
  await success('pi_swarm_close', { boardId });
  assert.equal(taskManager.worktreeLeases.has('1'), false);
  taskManager.tasks.get('1').worktree.cleaned = true;
  assert.equal((await success('app_read_board', { boardId })).members[0].latestTask.worktreeCleaned, true);
  taskManager.tasks.delete('4');
  const memberWithMissingTask = (await success('app_read_board', { boardId })).members[1];
  assert.equal(memberWithMissingTask.taskId, '4');
  assert.equal(Object.hasOwn(memberWithMissingTask, 'latestTask'), false);
  assert.equal((await call('app_post_board', { boardId, to: 'coder', text: 'Closed' })).isError, true);
});

test('MCP board waits can target a worker for up to one minute', { timeout: 4000 }, async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'swarm-board-wait-'));
  const { server, boards, taskManager } = createSwarmPiServer({ dataDir: cwd });
  const { id: boardId } = await boards.create({
    title: 'Wait test', cwd, members: [{ name: 'coder' }, { name: 'verifier' }],
  });
  const board = boards.get(boardId);
  let finishWorker;
  const workerCompletion = new Promise((resolve) => { finishWorker = resolve; });
  const workerResult = { status: 'completed', result_text: 'Done' };
  taskManager.submit = async () => ({ task_id: '1', cwd });
  taskManager.waitForCompletion = () => workerCompletion;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'board-wait-test', version: '1' });
  t.after(async () => {
    finishWorker(workerResult);
    await setImmediate();
    boards.close(boardId);
    await client.close();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const read = (args) => client.callTool({ name: 'pi_swarm_read', arguments: { boardId, ...args } });
  assert.equal((await read({ waitMs: 60001 })).isError, true);
  const unknown = await read({ member: 'missing' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown member: @missing/);

  const targeted = read({ member: 'coder', waitMs: 55000 });
  const unscoped = read({ waitMs: 55000 });
  await setImmediate();
  assert.equal(board.waiters.size, 2);
  boards.append(board, { from: 'coordinator', to: 'verifier', kind: 'message', text: 'Unrelated' });
  assert.equal((await unscoped).structuredContent.messages[0].to, 'verifier');
  assert.equal(board.waiters.size, 1);

  await boards.post(boardId, 'coordinator', 'coder', 'Start work');
  const { structuredContent: started } = await targeted;
  assert.deepEqual(started.messages.map(({ to }) => to), ['verifier', 'coder']);
  assert.equal(started.members[0].status, 'working');

  const completion = read({ member: 'coder', after: started.lastMessage, waitMs: 60000 });
  const statusOnly = read({ member: 'coder', after: 100, waitMs: 55000 });
  await setImmediate();
  assert.equal(board.waiters.size, 2);
  finishWorker(workerResult);
  const { structuredContent: finished } = await completion;
  assert.equal(finished.messages[0].from, 'coder');
  assert.equal(finished.messages[0].kind, 'result');
  assert.equal(finished.members[0].status, 'waiting');
  const { structuredContent: stateChange } = await statusOnly;
  assert.deepEqual(stateChange.messages, []);
  assert.equal(stateChange.members[0].status, 'waiting');

  const idle = await read({ member: 'coder', after: finished.lastMessage, waitMs: 55000 });
  assert.deepEqual(idle.structuredContent.messages, []);
  const timedWait = await read({ member: 'verifier', after: finished.lastMessage, waitMs: 1 });
  assert.deepEqual(timedWait.structuredContent.messages, []);
  assert.equal(board.waiters.size, 0);

  const closing = read({ member: 'verifier', after: finished.lastMessage, waitMs: 55000 });
  await setImmediate();
  assert.equal(board.waiters.size, 1);
  boards.close(boardId);
  assert.equal((await closing).structuredContent.closed, true);
  assert.equal(board.waiters.size, 0);
});

test('concurrent identical posts identify their own replies beyond the first board page', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'swarm-board-post-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { boards, taskManager } = createSwarmPiServer({ dataDir: cwd });
  const { id: boardId } = await boards.create({ title: 'Post test', cwd, members: [{ name: 'coder' }] });
  const board = boards.get(boardId);
  for (let i = 0; i < 50; i += 1) {
    boards.append(board, { from: 'user', to: 'coordinator', kind: 'message', text: 'Earlier post' });
  }
  let taskCount = 0;
  let finishFirstTask;
  const firstTask = new Promise((resolve) => { finishFirstTask = resolve; });
  taskManager.submit = async () => ({ task_id: String(++taskCount), cwd });
  taskManager.waitForCompletion = async (taskId) => {
    if (taskId === '1') await firstTask;
    return { status: 'completed', result_text: `Finished task ${taskId}` };
  };

  const post = () => boards.post(boardId, 'coordinator', 'coder', 'Identical assignment');
  const posts = await Promise.all([post(), post()]);
  const [first, second] = posts.sort((a, b) => a.postedMessageNumber - b.postedMessageNumber);
  assert.deepEqual([first.postedMessageNumber, second.postedMessageNumber], [51, 52]);
  assert.equal(second.messages.at(-1).number, 50);
  assert.equal(taskCount, 1);
  finishFirstTask();
  await setImmediate();

  const findReply = ({ postedMessageNumber }) => boards.read(boardId, postedMessageNumber).messages.find(
    ({ from, kind, replyTo }) => from === 'coder' && kind === 'result' && replyTo === postedMessageNumber,
  );
  assert.equal(findReply(first)?.text, 'Finished task 1');
  assert.equal(findReply(second)?.text, 'Finished task 2');
});
