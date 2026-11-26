import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  resolveEffectiveProfile,
} from '../src/config.mjs';
import {
  PiTaskManager,
  buildPiArgs,
  parseListModelsOutput,
  parsePiJsonOutput,
} from '../src/pi-runner.mjs';
import { createSwarmPiServer } from '../src/server.mjs';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-pi-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function createMockPiBinary(dir) {
  const binPath = path.join(dir, 'mock-pi');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
if (args.includes('--list-models')) {
  console.log('Provider  Model                     Context');
  console.log('anthropic/claude-sonnet-4-5         200k');
  console.log('openai    gpt-5.4                   400k');
  process.exit(0);
}

const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
};

const prompt = getArg('-p') || '';
const sessionDir = getArg('--session-dir');
const hadContinue = args.includes('--continue');
const model = getArg('--model') || '(default)';
const thinking = getArg('--thinking') || 'off';
const tools = getArg('--tools') || '';

if (prompt.includes('SETTLED_WITH_OPEN_HANDLE')) {
  console.log(JSON.stringify({type: 'message_end', message: {role: 'assistant', content: 'Ready'}}));
  console.log(JSON.stringify({type: 'agent_settled', aborted: false}));
  setInterval(() => {}, 10000);
} else if (prompt.includes('SLEEP_LONG')) {
  setTimeout(() => process.exit(0), 10000);
} else {
  if (prompt.includes('WRITE_FILE')) {
    fs.writeFileSync(path.join(process.cwd(), 'README.txt'), 'edited by pi\\n');
  }
  if (sessionDir) {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), JSON.stringify({ prompt }) + '\\n');
  }
  console.log(JSON.stringify({ type: 'tool_execution_start', toolName: 'read' }));
  console.log(JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      provider: 'mock-provider',
      model: model,
      usage: { input: 10, output: 20 },
      content: [{
        type: 'text',
        text: JSON.stringify({ model, thinking, tools, hadContinue, prompt, cwd: process.cwd() })
      }]
    }
  }));
  process.exit(0);
}
`;
  await fs.writeFile(binPath, script, { encoding: 'utf8', mode: 0o755 });
  return binPath;
}

test('SettingsStore persists and resolves default + role + override precedence', async () => {
  await withTempDir(async (dir) => {
    const store = new SettingsStore(dir);
    const initial = await store.load();
    assert.equal(initial.default.thinking, DEFAULT_SETTINGS.default.thinking);
    assert.equal(initial.roles.verifier.thinking, 'high');

    const updated = await store.patch({
      default: { model: 'anthropic/claude-sonnet-4-5', thinking: 'low' },
      roles: {
        coder: { model: 'openai/gpt-5.4', thinking: 'inherit' },
        architect: { model: '', thinking: 'xhigh', tools: 'read,grep' },
      },
    });

    const coderProfile = resolveEffectiveProfile(updated, { role: 'coder' });
    assert.equal(coderProfile.model, 'openai/gpt-5.4');
    assert.equal(coderProfile.thinking, 'low');

    const architectProfile = resolveEffectiveProfile(updated, { role: 'architect' });
    assert.equal(architectProfile.model, 'anthropic/claude-sonnet-4-5');
    assert.equal(architectProfile.thinking, 'xhigh');
    assert.equal(architectProfile.tools, 'read,grep');

    const overridden = resolveEffectiveProfile(updated, {
      role: 'coder',
      thinking: 'max',
    });
    assert.equal(overridden.thinking, 'max');

    await assert.rejects(
      () => store.patch({ default: { thinking: 'invalid-level' } }),
      /Invalid thinking level/,
    );
  });
});

test('buildPiArgs, parsePiJsonOutput, and parseListModelsOutput handle edge cases', () => {
  const args = buildPiArgs({
    prompt: 'Fix bug',
    model: 'anthropic/claude-sonnet-4-5',
    thinking: 'high',
    tools: 'read,edit',
    sessionDir: '/tmp/sess',
    continueSession: true,
  });
  assert.deepEqual(args, [
    '--mode',
    'json',
    '--session-dir',
    '/tmp/sess',
    '--continue',
    '--model',
    'anthropic/claude-sonnet-4-5',
    '--thinking',
    'high',
    '--tools',
    'read,edit',
    '-p',
    'Fix bug',
  ]);

  const parsed = parsePiJsonOutput(
    [
      JSON.stringify({
        type: 'message_start',
        message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4-5' },
      }),
      JSON.stringify({ type: 'tool_execution_start', toolName: 'bash' }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: 'All tests passed.' },
      }),
    ].join('\n'),
  );
  assert.deepEqual(parsed.toolCalls, ['bash']);
  assert.equal(parsed.actualModel, 'anthropic/claude-sonnet-4-5');
  assert.equal(parsed.finalText, 'All tests passed.');

  const models = parseListModelsOutput(
    'Provider Model\nanthropic/claude-sonnet-4-5 200k\nopenai gpt-5.4 400k',
  );
  assert.deepEqual(
    models.map((m) => m.id),
    ['anthropic/claude-sonnet-4-5', 'openai/gpt-5.4'],
  );
});

test('PiTaskManager supports batch waitTasks, sessions, worktree isolation, cleanup, and cancel', async () => {
  await withTempDir(async (dir) => {
    const mockPi = await createMockPiBinary(dir);
    const repoDir = path.join(dir, 'repo');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, 'README.txt'), 'initial\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    execFileSync('git', ['add', 'README.txt'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

    const store = new SettingsStore(path.join(dir, 'data'));
    await store.patch({
      piPath: mockPi,
      default: { model: 'anthropic/claude-sonnet-4-5', thinking: 'medium' },
    });

    const manager = new PiTaskManager({
      dataDir: path.join(dir, 'data'),
      settingsStore: store,
    });

    const modelsRes = await manager.listModels({ refresh: true });
    assert.equal(modelsRes.error, null);
    assert.equal(modelsRes.models.length, 2);

    // Parallel batch submit: one read-only + one isolated worktree writer
    const [t1, t2] = await Promise.all([
      manager.submit({
        prompt: 'Turn 1',
        cwd: repoDir,
        label: 'rev-1',
        role: 'verifier',
        sessionKey: 'worker-1',
      }),
      manager.submit({
        prompt: 'WRITE_FILE',
        cwd: repoDir,
        label: 'coder-1',
        role: 'coder',
        worktree: true,
      }),
    ]);

    const batch = await manager.waitTasks([t1.task_id, t2.task_id], {
      waitMs: 5000,
      mode: 'all',
    });
    assert.equal(batch.all_done, true);
    assert.equal(batch.completed_count, 2);

    const snap1 = batch.tasks[0];
    assert.equal(snap1.actual_model, 'mock-provider/anthropic/claude-sonnet-4-5');
    assert.equal(JSON.parse(snap1.result_text).hadContinue, false);

    const snap2 = batch.tasks[1];
    assert.equal(snap2.worktree.enabled, true);
    assert.match(snap2.worktree.branch, /^swarm-pi\/coder-1-/);
    assert.match(snap2.worktree.status_short, /README\.txt/);
    // Main repo stays untouched
    assert.equal(await fs.readFile(path.join(repoDir, 'README.txt'), 'utf8'), 'initial\n');

    const cleaned = await manager.cleanupWorktree(t2.task_id, { deleteBranch: true });
    assert.equal(cleaned.cleaned, true);
    assert.equal(cleaned.branch_deleted, true);

    // Session continuation check
    const t3 = await manager.submit({
      prompt: 'Turn 2',
      cwd: repoDir,
      role: 'verifier',
      sessionKey: 'worker-1',
    });
    const p3 = await manager.poll(t3.task_id, { waitMs: 5000 });
    assert.equal(JSON.parse(p3.result_text).hadContinue, true);

    const settledTask = await manager.submit({
      prompt: 'SETTLED_WITH_OPEN_HANDLE', cwd: repoDir, finishOnSettled: true,
    });
    const settled = await manager.poll(settledTask.task_id, { waitMs: 5000 });
    assert.equal(settled.status, 'completed');
    assert.equal(settled.result_text, 'Ready');

    // Cancel check
    const longTask = await manager.submit({
      prompt: 'SLEEP_LONG',
      cwd: repoDir,
      role: 'coder',
    });
    const cancelRes = await manager.cancel(longTask.task_id);
    assert.equal(cancelRes.cancelled, true);
    assert.equal(cancelRes.status, 'cancelled');
  });
});

test('MCP server exposes task tools and serves the bundled Pi Swarm MCP App', async () => {
  await withTempDir(async (dir) => {
    const uiDistPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      'ui',
      'dist',
      'settings.html',
    );
    const { server } = createSwarmPiServer({
      dataDir: path.join(dir, 'data'),
      uiHtmlPath: uiDistPath,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const toolsList = await client.listTools();
    const toolNames = toolsList.tools.map((t) => t.name);
    for (const expected of [
      'open_pi_swarm_settings',
      'app_get_state',
      'app_save_settings',
      'app_refresh_models',
      'app_cancel_task',
      'app_cleanup_worktree',
      'pi_get_settings',
      'pi_update_settings',
      'pi_list_models',
      'pi_submit_task',
      'pi_poll_task',
      'pi_wait_tasks',
      'pi_cancel_task',
      'pi_cleanup_worktree',
    ]) {
      assert.ok(toolNames.includes(expected), `Missing tool: ${expected}`);
    }

    const res = await client.readResource({ uri: 'ui://swarm-pi/settings.html' });
    assert.equal(res.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.ok(res.contents[0].text.includes('任务看板'));
    assert.ok(res.contents[0].text.includes('共享消息板'));
    assert.ok(Buffer.byteLength(res.contents[0].text, 'utf8') < 10 * 1024 * 1024);

    const opened = await client.callTool({
      name: 'open_pi_swarm_settings',
      arguments: { tab: 'tasks' },
    });
    assert.equal(opened.structuredContent.initialTab, 'tasks');

    await client.close();
    await server.close();
  });
});
