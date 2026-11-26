import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function windowsNpmCandidates(dir) {
  const targets = process.arch === 'arm64' ? ['arm64', 'x64'] : ['x64', 'arm64'];
  const scope = path.join(dir, 'node_modules', '@openai');
  const root = path.join(scope, 'codex');
  return targets.flatMap((arch) => {
    const triple = `${arch === 'x64' ? 'x86_64' : 'aarch64'}-pc-windows-msvc`;
    const platform = `codex-win32-${arch}`;
    return [
      path.join(root, 'node_modules', '@openai', platform),
      path.join(scope, platform),
      root,
    ].flatMap((pkg) => ['bin', 'codex'].map((folder) =>
      path.join(pkg, 'vendor', triple, folder, 'codex.exe')));
  });
}

export async function resolveCodexExecutable(setting = 'auto') {
  const windows = process.platform === 'win32';
  const auto = !setting || setting === 'auto';
  const command = auto ? 'codex' :
    /^~[\\/]/.test(setting) ? path.join(os.homedir(), setting.slice(2)) : setting;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (auto) {
    dirs.push(path.join(os.homedir(), '.local', 'bin'));
    if (windows) {
      if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'));
      if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
    } else {
      dirs.push('/opt/homebrew/bin', '/usr/local/bin');
    }
  }
  const candidates = path.isAbsolute(command) ? [command] : dirs.map((dir) => path.resolve(dir, command));
  const searched = [];
  for (const candidate of new Set(candidates.flatMap((file) => {
    if (!windows) return [file];
    const ext = path.extname(file).toLowerCase();
    if (ext === '.exe') return [file];
    const basename = path.basename(file, ext).toLowerCase();
    const native = ext ? [] : [`${file}.exe`];
    return basename === 'codex' ? [...native, ...windowsNpmCandidates(path.dirname(file))] : native;
  }))) {
    searched.push(candidate);
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      await fs.access(candidate, fsConstants.X_OK);
      return { found: true, path: candidate, searched };
    } catch {
      // Continue through the locally installed candidates.
    }
  }
  return { found: false, path: null, searched };
}

export function buildCodexArgs({ model, thinking, sandbox, sessionPath, threadId, outputPath }) {
  const args = ['exec'];
  if (threadId) args.push('resume', threadId);
  args.push('--json', '--skip-git-repo-check', '--output-last-message', outputPath);
  // Config overrides also work on `exec resume`, which has no --sandbox flag.
  args.push('-c', 'approval_policy="never"', '-c', `sandbox_mode="${sandbox}"`);
  if (!sessionPath) args.push('--ephemeral');
  if (model) args.push('--model', model);
  if (thinking) args.push('-c', `model_reasoning_effort="${thinking}"`);
  args.push('-');
  return args;
}

export function parseCodexJsonOutput(stdout) {
  let jsonEvents = 0;
  let threadId = null;
  let usage = null;
  let completed = false;
  let lastError = '';
  let turnError = '';
  const toolCalls = [];

  for (const line of stdout.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event.type !== 'string') continue;
    jsonEvents += 1;
    if (event.type === 'thread.started' && THREAD_ID.test(event.thread_id)) {
      threadId = event.thread_id;
    } else if (event.type === 'turn.completed') {
      completed = true;
      usage = event.usage ?? null;
    } else if (event.type === 'turn.failed') {
      turnError = event.error?.message || 'Codex turn failed';
    } else if (event.type === 'error') {
      lastError = event.message || lastError;
    } else if (event.type === 'item.completed') {
      const item = event.item;
      if (item?.type === 'mcp_tool_call') {
        toolCalls.push(`${item.server}/${item.tool}`);
      } else if (['command_execution', 'file_change', 'web_search'].includes(item?.type)) {
        toolCalls.push(item.type);
      }
    }
  }

  return {
    jsonEvents, threadId, usage, toolCalls, completed,
    errorText: turnError || (completed ? '' : lastError),
    actualModel: null,
  };
}

export async function readCodexSession(dataDir, cwd, key) {
  if (!key) return { sessionPath: null, threadId: null };
  const id = createHash('sha256').update(JSON.stringify([await fs.realpath(cwd), key])).digest('hex');
  const dir = path.join(dataDir, 'codex-sessions');
  await fs.mkdir(dir, { recursive: true });
  const sessionPath = path.join(dir, id);
  let threadId;
  try {
    threadId = (await fs.readFile(sessionPath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { sessionPath, threadId: null };
  }
  if (!THREAD_ID.test(threadId)) throw new Error(`Invalid Codex session in ${sessionPath}`);
  return { sessionPath, threadId };
}
