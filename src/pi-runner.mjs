import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { resolveEffectiveProfile } from './config.mjs';

const execFileAsync = promisify(execFile);

async function runGit(cwd, args, timeout = 15000) {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function isExecutable(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function listNvmPiCandidates() {
  const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    const entries = await fs.readdir(nvmDir);
    return entries
      .sort()
      .reverse()
      .map((ver) => path.join(nvmDir, ver, 'bin', 'pi'));
  } catch {
    return [];
  }
}

export async function resolvePiExecutable(piPathSetting = 'auto') {
  const setting = String(piPathSetting || 'auto').trim();
  const searched = [];

  if (setting && setting !== 'auto') {
    const expanded = setting.startsWith('~/')
      ? path.join(os.homedir(), setting.slice(2))
      : setting;
    if (path.isAbsolute(expanded)) {
      searched.push(expanded);
      if (await isExecutable(expanded)) {
        return { found: true, path: expanded, searched };
      }
      return { found: false, path: null, searched };
    }
    const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
      const candidate = path.join(dir, expanded);
      searched.push(candidate);
      if (await isExecutable(candidate)) {
        return { found: true, path: candidate, searched };
      }
    }
    return { found: false, path: null, searched };
  }

  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = [
    ...pathDirs.map((dir) => path.join(dir, 'pi')),
    path.join(os.homedir(), '.local', 'bin', 'pi'),
    '/opt/homebrew/bin/pi',
    '/usr/local/bin/pi',
    ...(await listNvmPiCandidates()),
  ];

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    searched.push(candidate);
    if (await isExecutable(candidate)) {
      return { found: true, path: candidate, searched };
    }
  }

  return { found: false, path: null, searched };
}

async function dirHasSessionFiles(sessionDir) {
  try {
    const entries = await fs.readdir(sessionDir);
    return entries.some((name) => name.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

export function buildPiArgs({
  prompt,
  model,
  thinking,
  tools,
  mode = 'json',
  sessionDir = null,
  continueSession = false,
  noSession = true,
}) {
  const args = ['--mode', mode];

  if (sessionDir) {
    args.push('--session-dir', sessionDir);
    if (continueSession) {
      args.push('--continue');
    }
  } else if (noSession) {
    args.push('--no-session');
  }

  if (model) {
    args.push('--model', model);
  }
  if (thinking) {
    args.push('--thinking', thinking);
  }
  if (tools) {
    args.push('--tools', tools);
  }

  args.push('-p', prompt);
  return args;
}

function extractTextFromMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function parsePiJsonOutput(stdoutText) {
  const lines = String(stdoutText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let jsonLines = 0;
  let lastAssistantText = '';
  let lastError = '';
  let actualProvider = '';
  let actualModelId = '';
  let lastUsage = null;
  const toolCalls = [];
  const plainLines = [];

  for (const line of lines) {
    let evt;
    try {
      evt = JSON.parse(line);
      jsonLines += 1;
    } catch {
      plainLines.push(line);
      continue;
    }

    if (!evt || typeof evt !== 'object') continue;

    if (
      (evt.type === 'message_start' || evt.type === 'message_end') &&
      evt.message?.role === 'assistant'
    ) {
      if (evt.message.provider) actualProvider = String(evt.message.provider);
      if (evt.message.model) actualModelId = String(evt.message.model);
      if (evt.message.usage) lastUsage = evt.message.usage;
      if (evt.type === 'message_end') {
        const text = extractTextFromMessageContent(evt.message.content);
        if (text) lastAssistantText = text;
        if (evt.message.errorMessage) lastError = String(evt.message.errorMessage);
      }
    } else if (evt.type === 'agent_end' && Array.isArray(evt.messages)) {
      for (let i = evt.messages.length - 1; i >= 0; i -= 1) {
        const msg = evt.messages[i];
        if (msg?.role === 'assistant') {
          if (msg.provider) actualProvider = String(msg.provider);
          if (msg.model) actualModelId = String(msg.model);
          if (msg.usage) lastUsage = msg.usage;
          const text = extractTextFromMessageContent(msg.content);
          if (text) {
            lastAssistantText = text;
            break;
          }
        }
      }
    } else if (evt.type === 'tool_execution_start' && evt.toolName) {
      toolCalls.push(String(evt.toolName));
    } else if (evt.type === 'error' && (evt.message || evt.error)) {
      lastError = String(evt.message || evt.error);
    } else if (typeof evt.result === 'string' && evt.result.trim()) {
      lastAssistantText = evt.result.trim();
    }
  }

  const finalText =
    lastAssistantText ||
    (jsonLines === 0 ? plainLines.join('\n').trim() : '');

  const actualModel =
    actualProvider && actualModelId
      ? `${actualProvider}/${actualModelId}`
      : actualModelId || null;

  return {
    jsonEvents: jsonLines,
    toolCalls,
    finalText,
    errorText: lastError,
    actualModel,
    usage: lastUsage,
  };
}

export function parseListModelsOutput(stdoutText) {
  const lines = String(stdoutText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const models = [];
  const seen = new Set();

  for (const line of lines) {
    if (
      line.startsWith('─') ||
      line.startsWith('=') ||
      /^provider\s+/i.test(line) ||
      /^model\s+/i.test(line)
    ) {
      continue;
    }

    const slashMatch = line.match(/\b([a-z0-9._-]+\/[a-z0-9._:@-]+)\b/i);
    if (slashMatch) {
      const id = slashMatch[1];
      if (!seen.has(id)) {
        seen.add(id);
        models.push({ id, raw: line });
      }
      continue;
    }

    const parts = line.split(/\s+/);
    if (parts.length >= 2 && /^[a-z0-9._-]+$/i.test(parts[0]) && /^[a-z0-9._:@-]+$/i.test(parts[1])) {
      const id = `${parts[0]}/${parts[1]}`;
      if (!seen.has(id)) {
        seen.add(id);
        models.push({ id, raw: line });
      }
    }
  }

  return models;
}

export class PiTaskManager {
  constructor({ dataDir, settingsStore }) {
    this.dataDir = dataDir;
    this.settingsStore = settingsStore;
    this.tasks = new Map();
    this.modelsCache = {
      updatedAt: null,
      models: [],
      rawOutput: '',
      error: null,
    };
  }

  async ensureDirs() {
    await fs.mkdir(path.join(this.dataDir, 'logs'), { recursive: true });
    await fs.mkdir(path.join(this.dataDir, 'sessions'), { recursive: true });
    await fs.mkdir(path.join(this.dataDir, 'worktrees'), { recursive: true });
  }

  async listModels({ refresh = false } = {}) {
    if (!refresh && this.modelsCache.updatedAt) {
      return this.modelsCache;
    }

    const settings = await this.settingsStore.load();
    const resolved = await resolvePiExecutable(settings.piPath);
    if (!resolved.found) {
      this.modelsCache = {
        updatedAt: new Date().toISOString(),
        models: [],
        rawOutput: '',
        error: `Pi executable not found (piPath="${settings.piPath}"). Install @mariozechner/pi-coding-agent or set piPath in settings.`,
      };
      return this.modelsCache;
    }

    const output = await new Promise((resolve) => {
      const child = spawn(resolved.path, ['--list-models'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({ code: -1, stdout, stderr: `${stderr}\nTimed out running pi --list-models` });
      }, 15000);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: err.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });

    if (output.code !== 0) {
      this.modelsCache = {
        updatedAt: new Date().toISOString(),
        models: [],
        rawOutput: output.stdout,
        error: (output.stderr || output.stdout || `pi --list-models exited with code ${output.code}`).trim(),
      };
      return this.modelsCache;
    }

    this.modelsCache = {
      updatedAt: new Date().toISOString(),
      models: parseListModelsOutput(output.stdout),
      rawOutput: output.stdout,
      error: null,
    };
    return this.modelsCache;
  }

  async createWorktree({ cwd, taskId, label, role }) {
    const realCwd = await fs.realpath(cwd);
    let repoRoot;
    try {
      const res = await runGit(realCwd, ['rev-parse', '--show-toplevel']);
      repoRoot = await fs.realpath(res.stdout);
    } catch (err) {
      throw new Error(
        `worktree=true requires a git repository (cwd=${cwd}): ${err.message}`,
      );
    }

    const relSubdir = path.relative(repoRoot, realCwd);
    const slug = String(label || role || 'task')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'task';
    const branch = `swarm-pi/${slug}-${taskId}`;
    const wtRoot = path.join(this.dataDir, 'worktrees', taskId);

    await runGit(repoRoot, ['worktree', 'add', '-b', branch, wtRoot, 'HEAD']);

    const effectiveCwd = relSubdir ? path.join(wtRoot, relSubdir) : wtRoot;
    return {
      enabled: true,
      repo_root: repoRoot,
      path: wtRoot,
      effective_cwd: effectiveCwd,
      branch,
      cleaned: false,
      status_short: '',
      diff_stat: '',
    };
  }

  async inspectWorktree(worktree) {
    if (!worktree || !worktree.enabled || worktree.cleaned) return worktree;
    try {
      const [statusRes, diffRes] = await Promise.all([
        runGit(worktree.path, ['status', '--short']),
        runGit(worktree.path, ['diff', '--stat', 'HEAD']),
      ]);
      worktree.status_short = statusRes.stdout;
      worktree.diff_stat = diffRes.stdout;
    } catch {
      // Worktree may already have been removed externally
    }
    return worktree;
  }

  async submit({
    prompt,
    cwd,
    role,
    label,
    model,
    thinking,
    tools,
    timeoutSec,
    sessionKey,
    worktree = false,
  }) {
    if (!prompt || !String(prompt).trim()) {
      throw new Error('prompt is required');
    }
    if (!cwd || !path.isAbsolute(cwd)) {
      throw new Error(`cwd must be an absolute directory path (got "${cwd || ''}")`);
    }

    const stat = await fs.stat(cwd).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`cwd does not exist or is not a directory: ${cwd}`);
    }

    await this.ensureDirs();
    const settings = await this.settingsStore.load();
    const resolved = await resolvePiExecutable(settings.piPath);
    if (!resolved.found) {
      throw new Error(
        `Pi executable not found (piPath="${settings.piPath}"). Install @mariozechner/pi-coding-agent (e.g. npm i -g @mariozechner/pi-coding-agent) or configure piPath in Pi Swarm Settings.`,
      );
    }

    const profile = resolveEffectiveProfile(settings, {
      role,
      model,
      thinking,
      tools,
      timeoutSec,
    });

    const taskId = `pi_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
    const logPath = path.join(this.dataDir, 'logs', `${taskId}.log`);

    let worktreeInfo = null;
    let runCwd = cwd;
    if (worktree) {
      worktreeInfo = await this.createWorktree({ cwd, taskId, label, role });
      runCwd = worktreeInfo.effective_cwd;
    }

    let sessionDir = null;
    let continueSession = false;
    if (sessionKey && String(sessionKey).trim()) {
      const safeKey = String(sessionKey)
        .trim()
        .replace(/[^a-zA-Z0-9._-]/g, '_');
      sessionDir = path.join(this.dataDir, 'sessions', safeKey);
      await fs.mkdir(sessionDir, { recursive: true });
      continueSession = await dirHasSessionFiles(sessionDir);
    }

    const args = buildPiArgs({
      prompt: String(prompt),
      model: profile.model,
      thinking: profile.thinking,
      tools: profile.tools,
      mode: 'json',
      sessionDir,
      continueSession,
      noSession: !sessionDir,
    });

    const logStream = await fs.open(logPath, 'w');

    const child = spawn(resolved.path, args, {
      cwd: runCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let resolveDone;
    const donePromise = new Promise((res) => {
      resolveDone = res;
    });

    const task = {
      taskId,
      label: label ? String(label).trim() : null,
      promptPreview: String(prompt).trim().slice(0, 180),
      status: 'running',
      cwd: runCwd,
      originalCwd: cwd,
      worktree: worktreeInfo,
      piPath: resolved.path,
      profile,
      sessionKey: sessionKey || null,
      createdAt: Date.now(),
      endedAt: null,
      exitCode: null,
      stdout: '',
      stderr: '',
      logPath,
      child,
      donePromise,
      timedOut: false,
      cancelled: false,
      timer: null,
    };

    task.timer = setTimeout(() => {
      if (task.status !== 'running') return;
      task.timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (task.status === 'running') child.kill('SIGKILL');
      }, 3000).unref();
    }, profile.timeoutSec * 1000);
    task.timer.unref();

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      task.stdout += text;
      logStream.write(text).catch(() => {});
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      task.stderr += text;
      logStream.write(`[stderr] ${text}`).catch(() => {});
    });

    const finalize = async (code, spawnError = null) => {
      clearTimeout(task.timer);
      task.endedAt = Date.now();
      task.exitCode = code;
      if (task.cancelled) {
        task.status = 'cancelled';
      } else if (task.timedOut) {
        task.status = 'failed';
        task.stderr = `${task.stderr}\nTimed out after ${profile.timeoutSec}s`.trim();
      } else if (spawnError) {
        task.status = 'failed';
        task.stderr = `${task.stderr}\n${spawnError.message}`.trim();
      } else if (code === 0) {
        task.status = 'completed';
      } else {
        task.status = 'failed';
      }
      if (task.worktree) {
        await this.inspectWorktree(task.worktree);
      }
      await logStream.close().catch(() => {});
      resolveDone(task);
    };

    child.on('error', (err) => {
      finalize(-1, err);
    });
    child.on('close', (code) => {
      finalize(code ?? -1);
    });

    this.tasks.set(taskId, task);

    return {
      task_id: taskId,
      label: task.label,
      status: task.status,
      pi_path: resolved.path,
      cwd: runCwd,
      worktree: worktreeInfo,
      profile,
      session_key: task.sessionKey,
      log_path: logPath,
      created_at: new Date(task.createdAt).toISOString(),
    };
  }

  formatTaskSnapshot(task) {
    const parsed = parsePiJsonOutput(task.stdout);
    const elapsedMs = (task.endedAt || Date.now()) - task.createdAt;
    const stderrTail = task.stderr.trim().slice(-2000);

    return {
      task_id: task.taskId,
      label: task.label,
      prompt_preview: task.promptPreview,
      status: task.status,
      cwd: task.cwd,
      worktree: task.worktree,
      profile: task.profile,
      actual_model: parsed.actualModel,
      usage: parsed.usage,
      elapsed_ms: elapsedMs,
      exit_code: task.exitCode,
      json_events: parsed.jsonEvents,
      tool_calls: parsed.toolCalls,
      result_text: parsed.finalText,
      error_text: parsed.errorText || (task.status === 'failed' ? stderrTail : ''),
      stderr_tail: stderrTail,
      log_path: task.logPath,
      created_at: new Date(task.createdAt).toISOString(),
    };
  }

  async poll(taskId, { waitMs = 15000 } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task_id: ${taskId}`);
    }

    if (task.status === 'running' && waitMs > 0) {
      const cappedWait = Math.min(Math.max(0, Number(waitMs) || 0), 60000);
      await Promise.race([
        task.donePromise,
        new Promise((resolve) => setTimeout(resolve, cappedWait)),
      ]);
    }

    if (task.worktree && task.status !== 'running') {
      await this.inspectWorktree(task.worktree);
    }

    return this.formatTaskSnapshot(task);
  }

  async waitTasks(taskIds, { waitMs = 20000, mode = 'all' } = {}) {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      throw new Error('taskIds must be a non-empty array');
    }
    const tasks = taskIds.map((id) => {
      const t = this.tasks.get(id);
      if (!t) throw new Error(`Unknown task_id: ${id}`);
      return t;
    });

    const running = tasks.filter((t) => t.status === 'running');
    const cappedWait = Math.min(Math.max(0, Number(waitMs) || 0), 60000);

    if (running.length > 0 && cappedWait > 0) {
      const waiter =
        mode === 'any'
          ? Promise.race(running.map((t) => t.donePromise))
          : Promise.all(running.map((t) => t.donePromise));
      await Promise.race([
        waiter,
        new Promise((resolve) => setTimeout(resolve, cappedWait)),
      ]);
    }

    for (const t of tasks) {
      if (t.worktree && t.status !== 'running') {
        await this.inspectWorktree(t.worktree);
      }
    }

    const snapshots = tasks.map((t) => this.formatTaskSnapshot(t));
    const runningCount = snapshots.filter((s) => s.status === 'running').length;
    return {
      all_done: runningCount === 0,
      running_count: runningCount,
      completed_count: snapshots.filter((s) => s.status === 'completed').length,
      failed_count: snapshots.filter((s) => s.status === 'failed').length,
      tasks: snapshots,
    };
  }

  async cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task_id: ${taskId}`);
    }
    if (task.status !== 'running') {
      return { task_id: taskId, status: task.status, cancelled: false };
    }
    task.cancelled = true;
    task.child.kill('SIGTERM');
    setTimeout(() => {
      if (task.status === 'running') task.child.kill('SIGKILL');
    }, 3000).unref();
    await Promise.race([
      task.donePromise,
      new Promise((resolve) => setTimeout(resolve, 3500)),
    ]);
    return { task_id: taskId, status: task.status, cancelled: true };
  }

  async cleanupWorktree(taskId, { deleteBranch = false } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task_id: ${taskId}`);
    }
    if (!task.worktree || !task.worktree.enabled) {
      return { task_id: taskId, cleaned: false, reason: 'Task has no worktree' };
    }
    if (task.status === 'running') {
      throw new Error(`Cannot cleanup worktree while task ${taskId} is still running`);
    }
    if (task.worktree.cleaned) {
      return { task_id: taskId, cleaned: true, already_cleaned: true };
    }

    await runGit(task.worktree.repo_root, [
      'worktree',
      'remove',
      '--force',
      task.worktree.path,
    ]).catch(async () => {
      await fs.rm(task.worktree.path, { recursive: true, force: true });
      await runGit(task.worktree.repo_root, ['worktree', 'prune']).catch(() => {});
    });

    let branchDeleted = false;
    if (deleteBranch && task.worktree.branch) {
      try {
        await runGit(task.worktree.repo_root, ['branch', '-D', task.worktree.branch]);
        branchDeleted = true;
      } catch {
        branchDeleted = false;
      }
    }

    task.worktree.cleaned = true;
    return {
      task_id: taskId,
      cleaned: true,
      branch: task.worktree.branch,
      branch_deleted: branchDeleted,
    };
  }

  listTasks({ limit = 25 } = {}) {
    return Array.from(this.tasks.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((t) => {
        const snap = this.formatTaskSnapshot(t);
        return {
          ...snap,
          result_text: snap.result_text.slice(0, 4000),
        };
      });
  }
}
