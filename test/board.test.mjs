import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSwarmPiServer } from '../src/server.mjs';

test('MCP board routes peer and user messages to the same worker session and worktree', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'swarm-board-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { server, taskManager } = createSwarmPiServer({ dataDir: cwd });
  const turns = [];
  const taskWorktree = path.join(cwd, 'coder-worktree');
  const replies = [
    'SWARM_POST @verifier Please review',
    'SWARM_POST @coder Fix the lower bound',
    'SWARM_POST @verifier Please recheck',
    'SWARM_POST @coordinator PASS',
    'User follow-up completed',
  ];
  taskManager.submit = async (args) => {
    turns.push(args);
    return {
      task_id: String(turns.length),
      cwd: args.worktree ? taskWorktree : args.cwd,
      worktree: args.worktree ? { path: taskWorktree } : null,
    };
  };
  taskManager.waitForCompletion = async (id) => ({
    status: 'completed',
    actual_model: 'test/model',
    result_text: replies[Number(id) - 1],
  });

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

  const { id: boardId } = await success('pi_create_swarm', {
    title: 'Board test', cwd, members: [{ name: 'coder', worktree: true }, { name: 'verifier' }],
  });
  assert.equal((await call('pi_swarm_post', { boardId, to: 'missing', text: 'Bad recipient' })).isError, true);
  await success('pi_swarm_post', { boardId, to: 'coder', text: 'Start' });
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
  assert.equal(turns[4].sessionKey, turns[0].sessionKey);
  assert.equal(turns[4].cwd, taskWorktree);

  assert.ok(taskManager.worktreeLeases.has('1'));
  await success('pi_swarm_close', { boardId });
  assert.equal(taskManager.worktreeLeases.has('1'), false);
  assert.equal((await call('app_post_board', { boardId, to: 'coder', text: 'Closed' })).isError, true);
});
