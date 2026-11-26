import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SettingsStore } from '../src/config.mjs';
import { PiTaskManager } from '../src/pi-runner.mjs';
import { SwarmBoards } from '../src/board.mjs';

const threadId = '0199a213-81c0-7800-8aa1-bbab2a035a53';

test('Codex worker keeps its worktree and resumes its exact thread across board turns', {
  skip: process.platform === 'win32' && 'The mock Codex executable uses a POSIX shebang',
}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-codex-worker-'));
  const dataDir = path.join(dir, 'data with spaces');
  const repo = path.join(dir, 'repo');
  const mock = path.join(dir, 'mock-codex');
  try {
    await fs.mkdir(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init');
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'original\n');
    git('add', 'tracked.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Initial commit');
    await fs.writeFile(mock, `#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const threadId = '${threadId}';
const emit = (evt) => console.log(JSON.stringify(evt));
assert.equal(args[0], 'exec');
assert.equal(args.at(-1), '-');
assert.ok(args.includes('--json'));
assert.ok(args.includes('approval_policy="never"'));
emit({type: 'thread.started', thread_id: threadId});
emit({type: 'item.completed', item: {type: 'agent_message', text: 'SWARM_POST @coordinator Interim'}});
const out = args[args.indexOf('--output-last-message') + 1];
if (prompt.includes('FAIL_TURN')) {
  fs.writeFileSync(out, 'This must not be routed');
  emit({type: 'turn.failed', error: {message: 'Synthetic failure'}});
} else if (prompt.includes('写入文件')) {
  assert.notEqual(args[1], 'resume');
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
  fs.writeFileSync('tracked.txt', 'edited by Codex\\n');
  fs.writeFileSync(out, 'Edited\\nSWARM_POST @coordinator Ready for review');
  emit({type: 'turn.completed', usage: {input_tokens: 10}});
} else {
  assert.equal(args[1], 'resume');
  assert.equal(args[2], threadId);
  assert.equal(fs.readFileSync('tracked.txt', 'utf8'), 'edited by Codex\\n');
  fs.writeFileSync(out, 'Resumed');
  emit({type: 'turn.completed', usage: {input_tokens: 20}});
}
`, { mode: 0o755 });
    const settingsStore = new SettingsStore(dataDir);
    const taskManager = new PiTaskManager({ dataDir, settingsStore });
    const defaults = await settingsStore.load();
    await taskManager.updateSettings({ ...defaults, harness: 'codex', codexPath: mock }, { fromPanel: true });
    const boards = new SwarmBoards(taskManager, settingsStore);
    const { id } = await boards.create({
      title: 'Codex Swarm', cwd: repo, members: [{ name: 'coder', role: 'coder', worktree: true }],
    });
    const post = (text) => boards.post(id, 'coordinator', 'coder', text);
    await post('写入文件');
    await post('Continue');
    for (let attempt = 0; attempt < 50 && boards.read(id).members[0].status === 'working'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const board = boards.read(id);
    assert.equal(board.members[0].status, 'waiting', JSON.stringify(board.messages));
    assert.equal(board.harness, 'codex');
    const turns = taskManager.listTasks().reverse();
    assert.deepEqual(turns.map((task) => task.result_text), ['Edited\nSWARM_POST @coordinator Ready for review', 'Resumed']);
    assert.equal(turns[0].cwd, turns[1].cwd);
    assert.match(turns[0].worktree.diff_stat, /tracked.txt/);
    assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'original\n');
    assert.equal(board.messages.filter(({ text }) => text === 'Ready for review').length, 1);
    assert.equal(board.messages.some(({ text }) => text.includes('Interim')), false);

    const reopened = new PiTaskManager({ dataDir, settingsStore });
    const { task_id: resumed } = await reopened.submit({
      prompt: 'Continue after restart', cwd: turns[0].cwd, sessionKey: `board-${id}-coder`,
    });
    assert.equal((await reopened.waitForCompletion(resumed)).result_text, 'Resumed');
    const { task_id: failed } = await reopened.submit({ prompt: 'FAIL_TURN', cwd: repo });
    const result = await reopened.waitForCompletion(failed);
    assert.equal(result.status, 'failed');
    assert.equal(result.result_text, '');
    assert.equal(result.error_text, 'Synthetic failure');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
