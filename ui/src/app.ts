import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { panelText, thinkingLabel, type Language } from './locale';

type Harness = 'pi' | 'codex';

interface Profile {
  model: string;
  thinking: string;
  tools: string;
  timeoutSec: number | null;
  codexModel: string;
  codexThinking: string;
  codexSandbox: string;
}

interface Settings {
  version: number;
  harness: Harness;
  piPath: string;
  codexPath: string;
  default: Profile;
  roles: Record<string, Profile>;
}

interface WorktreeInfo {
  enabled: boolean;
  repo_root: string;
  path: string;
  branch: string;
  cleaned: boolean;
  status_short: string;
  diff_stat: string;
}

interface TaskSnapshot {
  task_id: string;
  label: string | null;
  prompt_preview: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  harness: Harness;
  cwd: string;
  worktree: WorktreeInfo | null;
  profile: { role: string | null; model: string; thinking: string; tools: string };
  actual_model: string | null;
  elapsed_ms: number;
  exit_code: number | null;
  tool_calls: string[];
  result_text: string;
  error_text: string;
  log_path: string;
  created_at: string;
}

type Tab = 'board' | 'tasks' | 'settings';

interface BoardSummary {
  id: string;
  title: string;
  harness: Harness;
  closed: boolean;
}

interface BoardMessage {
  number: number;
  from: string;
  to: string | null;
  text: string;
  time: string;
  kind: 'message' | 'result' | 'error';
  replyTo?: number;
  actualModel?: string;
  logPath?: string;
}

interface Board extends BoardSummary {
  members: Array<{
    name: string;
    role?: string;
    status: 'waiting' | 'working' | 'blocked';
    queued: number;
    turns: number;
    actualModel?: string;
  }>;
  messages: BoardMessage[];
  lastMessage: number;
}

interface BoardView extends Board {
  boards?: BoardSummary[];
}

interface AppState {
  language?: Language;
  settings: Settings;
  defaults: Settings;
  thinkingLevels: string[];
  roleThinkingOptions: string[];
  codexThinkingLevels: string[];
  codexSandboxModes: string[];
  piStatus: { found: boolean; path: string | null; searched: string[] };
  codexStatus: AppState['piStatus'];
  modelsCache: {
    updatedAt: string | null;
    models: Array<{ id: string; raw: string }>;
    error: string | null;
  };
  recentTasks: TaskSnapshot[];
  settingsPath: string;
  initialTab?: Tab | null;
  boards: BoardSummary[];
  initialBoard?: Board | null;
}

const root = document.getElementById('app') as HTMLElement;
const app = new App({ name: 'Pi Swarm', version: '0.4.0' }, {});
const harnessName = { pi: 'Pi', codex: 'Codex' };

let state: AppState | null = null;
let language: Language = 'en';
let labels = panelText.en;
let savingLanguage = false;

let draft: Settings | null = null;
let activeTab: Tab = 'settings';
let boardId = '';
let board: Board | null = null;
let boardTimer: number | null = null;
let boardError = '';
let composing = false;
let tabInitialized = false;
let dirty = false;
let busy = false;
let banner = '';
let bannerKind: 'ok' | 'warn' | 'error' = 'ok';
let newRoleName = '';
let pollTimer: number | null = null;

function useLanguage(value: Language) {
  language = value;
  labels = panelText[value];
  document.documentElement.lang = value;
}

function setBanner(text: string, kind: 'ok' | 'warn' | 'error' = 'ok') {
  banner = text;
  bannerKind = kind;
  render();
}

function scheduleAutoRefresh() {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  const hasRunning = Boolean(
    state?.recentTasks?.some((t) => t.status === 'running'),
  );
  if (hasRunning && activeTab === 'tasks') {
    pollTimer = window.setTimeout(async () => {
      if (busy) {
        scheduleAutoRefresh();
        return;
      }
      try {
        const res = await app.callServerTool({ name: 'app_get_state', arguments: {} });
        if (res.structuredContent) {
          applyIncomingState(res.structuredContent as unknown as AppState, false);
        }
      } catch {
        // Ignore transient poll errors while view reloads
      }
    }, 2500);
  }
}

function applyIncomingState(nextState: AppState, resetDraft = false) {
  if (!state) useLanguage(nextState.language === 'zh-CN' ? 'zh-CN' : 'en');
  state = nextState;
  if (!draft || resetDraft) {
    draft = structuredClone(nextState.settings);
    dirty = false;
  }
  if (nextState.initialBoard) {
    board = nextState.initialBoard;
    boardId = board.id;
    boardError = '';
  } else if (!boardId && nextState.boards.length) {
    boardId = nextState.boards[0].id;
  }
  if (nextState.initialTab) {
    activeTab = nextState.initialTab;
    tabInitialized = true;
  } else if (!tabInitialized) {
    activeTab = boardId ? 'board' : nextState.recentTasks.length > 0 ? 'tasks' : 'settings';
    tabInitialized = true;
  }
  render();
  scheduleAutoRefresh();
  scheduleBoardRefresh();
}

function escapeHtml(text: string): string {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function markDirty() {
  dirty = true;
  const indicator = document.getElementById('dirty-indicator');
  if (indicator) indicator.textContent = labels.unsavedChanges;
}

function renderBoardFeed(current: Board): string {
  const members = current.members.map((member) => `
    <li><b>@${escapeHtml(member.name)}</b>
      <span>${labels[member.status]}${member.queued ? ` · ${labels.queued(member.queued)}` : ''}</span>
      ${member.actualModel ? ` <small>${escapeHtml(member.actualModel)}</small>` : ''}
    </li>`).join('');
  const messages = current.messages.map((message) => `
    <li class="board-message ${message.kind === 'error' ? 'message-error' : ''}">
      <div><b>@${escapeHtml(message.from)}</b>
        ${message.to ? ` → @${escapeHtml(message.to)}` : ''}
        <span class="hint">#${message.number}
          ${message.replyTo ? ` · ${labels.replyTo(message.replyTo)}` : ''}
          · ${escapeHtml(new Date(message.time).toLocaleTimeString(language))}
        </span>
      </div>
      <div class="board-message-text">${escapeHtml(message.text || labels.handoffPosted)}</div>
      ${message.logPath ? `<small class="mono">${escapeHtml(message.logPath)}</small>` : ''}
    </li>`).join('');
  return `<ul class="board-members" aria-label="${labels.members}">${members}</ul>
    <ol class="board-messages" aria-label="${labels.board}">${messages || `<li>${labels.noMessages}</li>`}</ol>`;
}

function boardOptions(boards: BoardSummary[]): string {
  return boards.map(({ id, title, harness, closed }) =>
    `<option value="${escapeHtml(id)}" ${id === boardId ? 'selected' : ''}>${escapeHtml(title)} · ${harnessName[harness]}${closed ? ` · ${labels.closed}` : ''}</option>`,
  ).join('');
}

function renderBoardTab(current: AppState): string {
  if (!current.boards.length) {
    return `<div class="card">${labels.noBoard}</div>`;
  }
  const selected = board?.id === boardId ? board : null;
  const inactive = selected && selected.harness !== current.settings.harness;
  return `<div class="card">
    <label for="board-select">${labels.swarm}</label>
    <select id="board-select">
      ${boardOptions(current.boards)}
    </select>
    <div id="board-error" role="status">${escapeHtml(boardError)}</div>
    <div id="board-feed">${selected ? renderBoardFeed(selected) : labels.loadingMessages}</div>
    ${inactive && !selected.closed ? `<p class="hint">${labels.inactiveBoard(harnessName[selected.harness])}</p>` : ''}
    ${selected && !selected.closed && !inactive ? `<form id="board-form">
      <label for="board-recipient">${labels.recipient}</label>
      <select id="board-recipient">
        ${selected.members.map(({name}) => `<option value="${escapeHtml(name)}">@${escapeHtml(name)}</option>`).join('')}
      </select>
      <label for="board-instruction">${labels.instruction}</label>
      <textarea id="board-instruction" required maxlength="4000" rows="3"></textarea>
      <button class="btn primary" type="submit" ${savingLanguage ? 'disabled' : ''}>${labels.sendInstruction}</button>
      <output id="board-post-status" aria-live="polite"></output>
    </form>` : ''}
  </div>`;
}

function updateBoardView(next: BoardView) {
  if (state && next.boards && JSON.stringify(state.boards) !== JSON.stringify(next.boards)) {
    state.boards = next.boards;
    const picker = document.getElementById('board-select');
    if (picker) picker.innerHTML = boardOptions(next.boards);
  }
  const sameBoard = board?.id === next.id;
  const wasClosed = board?.closed;
  if (sameBoard && board!.lastMessage > next.lastMessage) return;
  const messages = sameBoard ? board!.messages : [];
  const cursor = messages.at(-1)?.number || 0;
  board = { ...next, messages: [...messages, ...next.messages.filter((m) => m.number > cursor)] };
  if (activeTab !== 'board') return;
  if (!sameBoard || wasClosed !== next.closed) {
    render();
  } else {
    const feed = document.getElementById('board-feed');
    if (feed) {
      const follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 30;
      feed.innerHTML = renderBoardFeed(board);
      if (follow) feed.scrollTop = feed.scrollHeight;
    }
  }
}

function showBoardError(message: string) {
  boardError = message;
  const el = document.getElementById('board-error');
  if (el) el.textContent = message;
}

async function refreshBoard() {
  const id = boardId;
  if (activeTab !== 'board') return;
  try {
    const after = board?.id === id ? board.messages.at(-1)?.number || 0 : 0;
    const result = await app.callServerTool({ name: 'app_read_board', arguments: id ? { boardId: id, after } : {} });
    if (boardId !== id || activeTab !== 'board') return;
    if (result.isError) throw new Error(result.content.map((item) => 'text' in item ? item.text : '').join(' '));
    if (!result.structuredContent) return;
    if (id) {
      updateBoardView(result.structuredContent as unknown as BoardView);
    } else {
      const { boards } = result.structuredContent as { boards: BoardSummary[] };
      if (state && boards.length) {
        state.boards = boards;
        boardId = boards[0].id;
        render();
      }
    }
    if (!composing) showBoardError('');
  } catch (error) {
    if (boardId === id) showBoardError(error instanceof Error ? error.message : String(error));
  } finally {
    scheduleBoardRefresh();
  }
}

function scheduleBoardRefresh() {
  if (boardTimer !== null) window.clearTimeout(boardTimer);
  const catchingUp = boardId && (
    board?.id !== boardId || (board.messages.at(-1)?.number || 0) < board.lastMessage
  );
  boardTimer = activeTab === 'board'
    ? window.setTimeout(refreshBoard, catchingUp ? 50 : 2000)
    : null;
}

function renderTasksTab(current: AppState): string {
  const tasks = current.recentTasks || [];
  if (tasks.length === 0) {
    return `
      <div class="card">
        <div class="empty-state">
          <div style="font-weight:600;margin-bottom:6px;">${labels.noTasks}</div>
          <button id="btn-refresh-tasks" type="button" class="btn sm">${labels.refreshTasks}</button>
        </div>
      </div>`;
  }

  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">${labels.taskCount(tasks.length)}</span>
        <button id="btn-refresh-tasks" type="button" class="btn sm" ${busy ? 'disabled' : ''}>${labels.refreshTasks}</button>
      </div>
      ${tasks
        .map((t) => {
          const displayTitle = t.label || t.task_id;
          const configuredModel = t.profile.model || labels.harnessDefault(harnessName[t.harness]);
          const actualModel = t.actual_model || (t.status === 'running' ? labels.starting : labels.modelNotReported);
          const toolCounts = t.tool_calls.reduce<Record<string, number>>((acc, name) => {
            acc[name] = (acc[name] || 0) + 1;
            return acc;
          }, {});
          const toolChips = Object.entries(toolCounts)
            .map(([name, cnt]) => `<span class="chip">${escapeHtml(name)}×${cnt}</span>`)
            .join(' ');

          return `
            <div class="task-card">
              <div class="card-header">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                  <span class="role-badge">${escapeHtml(t.profile.role || labels.defaultRole)}</span>
                  <span class="hint">${harnessName[t.harness]}</span>
                  <strong>${escapeHtml(displayTitle)}</strong>
                  <span class="hint mono">${escapeHtml(t.task_id)}</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                  <span class="status-pill ${escapeHtml(t.status)}">${labels[t.status]} · ${formatDuration(t.elapsed_ms)}</span>
                  ${
                    t.status === 'running'
                      ? `<button type="button" class="btn sm danger" data-cancel-task="${escapeHtml(t.task_id)}" ${busy ? 'disabled' : ''}>${labels.cancel}</button>`
                      : ''
                  }
                  ${
                    t.status !== 'running' && t.worktree?.enabled && !t.worktree.cleaned
                      ? `<button type="button" class="btn sm" data-cleanup-wt="${escapeHtml(t.task_id)}" ${busy ? 'disabled' : ''}>${labels.cleanWorktree}</button>`
                      : ''
                  }
                </div>
              </div>

              <div class="meta-row">
                <span>${labels.configuredModel}: <span class="mono">${escapeHtml(configuredModel)}</span></span>
                <span>${labels.actualModel}: <strong class="mono">${escapeHtml(actualModel)}</strong></span>
                <span>${labels.thinking}: <span class="mono">${escapeHtml(t.profile.thinking ? thinkingLabel(language, t.profile.thinking) : labels.cliDefault)}</span></span>
              </div>

              ${
                t.prompt_preview
                  ? `<div class="hint">${escapeHtml(t.prompt_preview)}${t.prompt_preview.length >= 180 ? '…' : ''}</div>`
                  : ''
              }

              ${toolChips ? `<div class="meta-row">${labels.toolCalls}: ${toolChips}</div>` : ''}

              ${
                t.worktree?.enabled
                  ? `<div class="hint">
                      ${labels.worktreeBranch}: <span class="mono">${escapeHtml(t.worktree.branch)}</span>
                      ${t.worktree.cleaned ? `(${labels.worktreeCleaned})` : `· ${labels.path}: <span class="mono">${escapeHtml(t.worktree.path)}</span>`}
                    </div>`
                  : ''
              }

              ${
                t.worktree?.diff_stat
                  ? `<details><summary>${labels.worktreeDiff}</summary><pre class="output-box">${escapeHtml(t.worktree.diff_stat)}</pre></details>`
                  : ''
              }

              ${
                t.error_text
                  ? `<pre class="output-box" style="color:var(--danger)">${escapeHtml(t.error_text)}</pre>`
                  : t.result_text
                    ? `<details ${t.status === 'completed' ? 'open' : ''}><summary>${labels.result}</summary><pre class="output-box">${escapeHtml(t.result_text)}</pre></details>`
                    : ''
              }
            </div>`;
        })
        .join('')}
    </div>`;
}

function renderCodexFields(current: AppState, profile: Profile, roleName?: string): string {
  const scope = (field: 'codexModel' | 'codexThinking' | 'codexSandbox') =>
    roleName ? `data-role-field="${field}" data-role-name="${escapeHtml(roleName)}"` : `data-codex-default="${field}"`;
  const fallback = roleName ? labels.inheritDefault : labels.cliDefault;
  return `
    <div class="field">
      <label>${labels.codexModel}</label>
      <input type="text" ${scope('codexModel')} value="${escapeHtml(profile.codexModel)}" placeholder="${fallback}" />
    </div>
    <div class="field">
      <label>${labels.codexThinking}</label>
      <select ${scope('codexThinking')}>
        <option value="">${fallback}</option>
        ${current.codexThinkingLevels.map((level) =>
          `<option value="${level}" ${profile.codexThinking === level ? 'selected' : ''}>${escapeHtml(thinkingLabel(language, level))}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>${labels.codexSandbox}</label>
      <select ${scope('codexSandbox')}>
        ${roleName ? '<option value="inherit">' + labels.inheritDefault + '</option>' : ''}
        ${current.codexSandboxModes.map((mode) =>
          `<option value="${mode}" ${profile.codexSandbox === mode ? 'selected' : ''}>${mode}</option>`).join('')}
      </select>
    </div>`;
}

function renderSettingsTab(current: AppState, currentDraft: Settings): string {
  const models = current.modelsCache.models || [];
  const roleEntries = Object.entries(currentDraft.roles || {});
  const codex = currentDraft.harness === 'codex';

  return `
    <datalist id="pi-models-datalist">
      ${models.map((m) => `<option value="${escapeHtml(m.id)}"></option>`).join('')}
    </datalist>

    <div class="card">
      <div class="card-header">
        <span class="card-title">${labels.globalDefaults}</span>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="harness">${labels.harness}</label>
          <select id="harness">
            <option value="pi" ${codex ? '' : 'selected'}>Pi</option>
            <option value="codex" ${codex ? 'selected' : ''}>Codex</option>
          </select>
        </div>
        <div class="field">
          <label for="harness-path">${codex ? labels.codexExecutable : labels.piExecutable}</label>
          <input id="harness-path" type="text" value="${escapeHtml(codex ? currentDraft.codexPath : currentDraft.piPath)}" placeholder="auto" />
        </div>
      </div>
      <p class="hint">${labels.harnessHelp}</p>
      ${codex ? `<div class="grid-2">${renderCodexFields(current, currentDraft.default)}</div>` : `
        <div class="field">
          <label for="def-model">${labels.defaultModel}</label>
          <input id="def-model" type="text" list="pi-models-datalist" value="${escapeHtml(currentDraft.default.model)}" placeholder="${labels.exampleModel}" />
        </div>
      <div class="field">
        <label>${labels.defaultThinking}</label>
        <div class="segmented" id="def-thinking-group">
          ${current.thinkingLevels
            .map(
              (lvl) => `
            <button type="button" class="seg-btn ${currentDraft.default.thinking === lvl ? 'active' : ''}" data-def-thinking="${lvl}">
              ${escapeHtml(thinkingLabel(language, lvl))}
            </button>`,
            )
            .join('')}
        </div>
      </div>
        <div class="field">
          <label for="def-tools">${labels.defaultTools}</label>
          <input id="def-tools" type="text" value="${escapeHtml(currentDraft.default.tools)}" placeholder="read,write,edit,bash" />
        </div>`}
        <div class="field">
          <label for="def-timeout">${labels.defaultTimeout}</label>
          <input id="def-timeout" type="number" min="10" max="7200" value="${currentDraft.default.timeoutSec ?? 900}" />
        </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">${labels.roles}</span>
        <span class="hint">${labels.roleHelp}</span>
      </div>

      ${roleEntries
        .map(
          ([roleName, role]) => `
        <div class="role-card" data-role="${escapeHtml(roleName)}">
          <div class="card-header">
            <span class="role-badge">${escapeHtml(roleName)}</span>
            <button type="button" class="btn sm danger" data-delete-role="${escapeHtml(roleName)}">${labels.deleteRole}</button>
          </div>
          <div class="grid-2">
            ${codex ? renderCodexFields(current, role, roleName) : `
            <div class="field">
              <label>${labels.roleModel}</label>
              <input type="text" list="pi-models-datalist" data-role-field="model" data-role-name="${escapeHtml(roleName)}" value="${escapeHtml(role.model || '')}" placeholder="${labels.inheritDefault}" />
            </div>
            <div class="field">
              <label>${labels.roleThinking}</label>
              <select data-role-field="thinking" data-role-name="${escapeHtml(roleName)}">
                ${current.roleThinkingOptions
                  .map(
                    (lvl) =>
                      `<option value="${lvl}" ${role.thinking === lvl ? 'selected' : ''}>${escapeHtml(thinkingLabel(language, lvl))}</option>`,
                  )
                  .join('')}
              </select>
            </div>
            <div class="field">
              <label>${labels.roleTools}</label>
              <input type="text" data-role-field="tools" data-role-name="${escapeHtml(roleName)}" value="${escapeHtml(role.tools || '')}" placeholder="${labels.inheritDefault}" />
            </div>`}
            <div class="field">
              <label>${labels.roleTimeout}</label>
              <input type="number" min="10" max="7200" data-role-field="timeoutSec" data-role-name="${escapeHtml(roleName)}" value="${role.timeoutSec ?? ''}" placeholder="${labels.inheritDefault}" />
            </div>
          </div>
        </div>`,
        )
        .join('')}

      <div class="add-role-row">
        <input id="new-role-name" type="text" value="${escapeHtml(newRoleName)}" placeholder="${labels.roleName}" />
        <button id="btn-add-role" type="button" class="btn">${labels.addRole}</button>
      </div>
    </div>`;
}

function render() {
  if (!state || !draft) {
    root.innerHTML = `<div class="container"><div class="card">${labels.loadingPanel}</div></div>`;
    return;
  }

  const codex = state.settings.harness === 'codex';
  const activeHarness = harnessName[state.settings.harness];
  const status = codex ? state.codexStatus : state.piStatus;
  const models = state.modelsCache.models || [];
  const runningCount = state.recentTasks.filter((t) => t.status === 'running').length;

  root.innerHTML = `
    <div class="container">
      <div class="header">
        <div class="title-group">
          <h1>Pi Swarm (/swarm_pi)</h1>
          <p class="subtitle">${labels.subtitle}</p>
        </div>
        <div class="header-actions">
          <label class="language-picker" for="panel-language">
            <span>${labels.language}</span>
            <select id="panel-language" ${savingLanguage ? 'disabled' : ''}>
              <option value="en" lang="en" ${language === 'en' ? 'selected' : ''}>English</option>
              <option value="zh-CN" lang="zh-CN" ${language === 'zh-CN' ? 'selected' : ''}>简体中文</option>
            </select>
          </label>
          <button id="btn-refresh-models" class="btn sm" ${busy ? 'disabled' : ''}>
            ${busy ? labels.checkingHarness : codex ? labels.detectCodex : labels.detectPi}
          </button>
        </div>
      </div>

      <div class="tabs">
        <button type="button" class="tab-btn ${activeTab === 'board' ? 'active' : ''}" data-tab="board">${labels.board}</button>
        <button type="button" class="tab-btn ${activeTab === 'tasks' ? 'active' : ''}" data-tab="tasks">
          ${labels.tasks}
          <span class="badge ${runningCount > 0 ? 'running' : ''}">
            ${runningCount > 0 ? labels.runningCount(runningCount) : state.recentTasks.length}
          </span>
        </button>
        <button type="button" class="tab-btn ${activeTab === 'settings' ? 'active' : ''}" data-tab="settings">
          ${labels.settings}
          ${dirty ? `<span class="badge">${labels.unsaved}</span>` : ''}
        </button>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">${labels.environment}</span>
          <span class="status-pill ${status.found ? 'ok' : 'warn'}">
            ${status.found ? `${activeHarness}: <span class="mono">${escapeHtml(status.path || '')}</span>` : labels.missingHarness(activeHarness)}
          </span>
        </div>
        ${
          !status.found
            ? `<div class="hint">${codex ? labels.installCodex : labels.installPi}</div>`
            : ''
        }
        ${
          !codex && state.modelsCache.error
            ? `<div class="hint" style="color:var(--warn)">${labels.modelRefresh}: ${escapeHtml(state.modelsCache.error)}</div>`
            : !codex && models.length > 0
              ? `<div class="hint">${labels.cachedModels(models.length)} · ${labels.settingsFile}: <span class="mono">${escapeHtml(state.settingsPath)}</span></div>`
              : `<div class="hint">${labels.settingsFile}: <span class="mono">${escapeHtml(state.settingsPath)}</span></div>`
        }
        ${
          banner
            ? `<div class="hint" style="color:var(--${bannerKind === 'error' ? 'danger' : bannerKind})">${escapeHtml(banner)}</div>`
            : ''
        }
      </div>

      ${activeTab === 'board' ? renderBoardTab(state) : activeTab === 'tasks' ? renderTasksTab(state) : renderSettingsTab(state, draft)}
    </div>

    ${
      activeTab === 'settings'
        ? `<div class="footer-bar">
            <span id="dirty-indicator" class="hint">${dirty ? labels.unsavedChanges : labels.settingsSynced}</span>
            <div class="footer-actions">
              <button id="btn-reset-defaults" type="button" class="btn" ${busy ? 'disabled' : ''}>${labels.resetDefaults}</button>
              <button id="btn-save" type="button" class="btn primary" ${busy ? 'disabled' : ''}>${labels.saveSettings}</button>
            </div>
          </div>`
        : ''
    }
  `;

  bindEvents();
}

async function refreshTasks() {
  if (busy) return;
  try {
    const res = await app.callServerTool({ name: 'app_get_state', arguments: {} });
    if (res.isError) throw new Error(res.content.map((item) => 'text' in item ? item.text : '').join(' '));
    if (activeTab === 'tasks' && res.structuredContent) {
      applyIncomingState(res.structuredContent as unknown as AppState, false);
    }
  } catch (error) {
    setBanner(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function changeLanguage(select: HTMLSelectElement) {
  const next = select.value as Language;
  if (savingLanguage || composing || next === language) {
    select.value = language;
    return;
  }
  savingLanguage = true;
  select.disabled = true;
  const submit = document.querySelector<HTMLButtonElement>('#board-form button[type=submit]');
  if (submit) submit.disabled = true;
  let error: string | null = null;
  try {
    const result = await app.callServerTool({ name: 'app_set_language', arguments: { language: next } });
    if (result.isError) throw new Error(result.content.map((item) => 'text' in item ? item.text : '').join(' '));
    useLanguage(next);
    banner = '';
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    savingLanguage = false;
    const instruction = document.querySelector<HTMLTextAreaElement>('#board-instruction')?.value;
    const recipient = document.querySelector<HTMLSelectElement>('#board-recipient')?.value;
    const focused = select.isConnected
      && (document.activeElement === select || document.activeElement === document.body);
    if (error) setBanner(`${labels.languageFailed}: ${error}`, 'error');
    else render();
    const instructionInput = document.querySelector<HTMLTextAreaElement>('#board-instruction');
    const recipientInput = document.querySelector<HTMLSelectElement>('#board-recipient');
    if (instructionInput && instruction !== undefined) instructionInput.value = instruction;
    if (recipientInput && recipient !== undefined) recipientInput.value = recipient;
    if (focused) document.getElementById('panel-language')?.focus();
  }
}

function bindEvents() {
  const languageSelect = document.getElementById('panel-language') as HTMLSelectElement | null;
  languageSelect?.addEventListener('change', () => void changeLanguage(languageSelect));

  const boardSelect = document.getElementById('board-select') as HTMLSelectElement | null;
  boardSelect?.addEventListener('change', () => {
    boardId = boardSelect.value;
    board = null;
    boardError = '';
    render();
    void refreshBoard();
  });

  const form = document.getElementById('board-form') as HTMLFormElement | null;
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (composing || savingLanguage) return;
    const input = form.querySelector<HTMLTextAreaElement>('#board-instruction')!;
    const recipient = form.querySelector<HTMLSelectElement>('#board-recipient')!;
    const text = input.value.trim();
    const id = boardId;
    if (!text) return;
    composing = true;
    const status = form.querySelector<HTMLOutputElement>('#board-post-status')!;
    status.value = labels.sending;
    try {
      const result = await app.callServerTool({
        name: 'app_post_board', arguments: { boardId: id, to: recipient.value, text },
      });
      if (boardId !== id) return;
      if (result.isError) throw new Error(result.content.map((item) => 'text' in item ? item.text : '').join(' '));
      if (input.value.trim() === text) input.value = '';
      status.value = labels.instructionPosted;
      await refreshBoard();
    } catch (error) {
      status.value = error instanceof Error ? error.message : String(error);
    } finally {
      composing = false;
    }
  });

  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.tab as Tab;
      if (next && next !== activeTab) {
        activeTab = next;
        render();
        if (next === 'tasks') void refreshTasks();
        else if (next === 'board') void refreshBoard();
        scheduleAutoRefresh();
        scheduleBoardRefresh();
      }
    });
  });

  document.getElementById('btn-refresh-models')?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    banner = '';
    render();
    try {
      const res = await app.callServerTool({
        name: 'app_refresh_models',
        arguments: {},
      });
      if (res.isError) throw new Error(res.content.map((item) => 'text' in item ? item.text : '').join(' '));
      if (res.structuredContent) {
        applyIncomingState(res.structuredContent as unknown as AppState, false);
      }
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      busy = false;
      render();
    }
  });

  document.getElementById('btn-refresh-tasks')?.addEventListener('click', refreshTasks);

  document.querySelectorAll<HTMLButtonElement>('[data-cancel-task]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const taskId = btn.dataset.cancelTask;
      if (!taskId || busy) return;
      busy = true;
      render();
      try {
        const res = await app.callServerTool({
          name: 'app_cancel_task',
          arguments: { taskId },
        });
        if (res.structuredContent) {
          applyIncomingState(res.structuredContent as unknown as AppState, false);
          setBanner(labels.taskCancelled(taskId), 'warn');
        }
      } catch (err) {
        setBanner(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        busy = false;
        render();
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-cleanup-wt]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const taskId = btn.dataset.cleanupWt;
      if (!taskId || busy) return;
      busy = true;
      render();
      try {
        const res = await app.callServerTool({
          name: 'app_cleanup_worktree',
          arguments: { taskId, deleteBranch: false },
        });
        if (res.isError) throw new Error(res.content.map((item) => 'text' in item ? item.text : '').join(' '));
        if (res.structuredContent) {
          applyIncomingState(res.structuredContent as unknown as AppState, false);
          setBanner(labels.worktreeRemoved(taskId), 'ok');
        }
      } catch (err) {
        setBanner(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        busy = false;
        render();
      }
    });
  });

  if (activeTab !== 'settings') return;

  const harnessSelect = document.getElementById('harness') as HTMLSelectElement | null;
  const harnessPathInput = document.getElementById('harness-path') as HTMLInputElement | null;
  const defModelInput = document.getElementById('def-model') as HTMLInputElement | null;
  const defToolsInput = document.getElementById('def-tools') as HTMLInputElement | null;
  const defTimeoutInput = document.getElementById('def-timeout') as HTMLInputElement | null;
  const newRoleInput = document.getElementById('new-role-name') as HTMLInputElement | null;

  harnessSelect?.addEventListener('change', () => {
    if (!draft) return;
    draft.harness = harnessSelect.value === 'codex' ? 'codex' : 'pi';
    dirty = true;
    render();
  });
  harnessPathInput?.addEventListener('input', () => {
    if (draft) {
      if (draft.harness === 'codex') draft.codexPath = harnessPathInput.value;
      else draft.piPath = harnessPathInput.value;
      markDirty();
    }
  });
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-codex-default]').forEach((el) => {
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
      if (!draft) return;
      const field = el.dataset.codexDefault as 'codexModel' | 'codexThinking' | 'codexSandbox';
      draft.default[field] = el.value;
      markDirty();
    });
  });
  defModelInput?.addEventListener('input', () => {
    if (draft) {
      draft.default.model = defModelInput.value;
      markDirty();
    }
  });
  defToolsInput?.addEventListener('input', () => {
    if (draft) {
      draft.default.tools = defToolsInput.value;
      markDirty();
    }
  });
  defTimeoutInput?.addEventListener('input', () => {
    if (draft) {
      draft.default.timeoutSec = Number(defTimeoutInput.value) || 900;
      markDirty();
    }
  });
  newRoleInput?.addEventListener('input', () => {
    newRoleName = newRoleInput.value;
  });

  document.querySelectorAll<HTMLButtonElement>('[data-def-thinking]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!draft) return;
      draft.default.thinking = btn.dataset.defThinking || 'medium';
      dirty = true;
      render();
    });
  });

  document
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-role-field]')
    .forEach((el) => {
      const eventName = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(eventName, () => {
        if (!draft) return;
        const roleName = el.dataset.roleName;
        const field = el.dataset.roleField;
        if (!roleName || !field || !draft.roles[roleName]) return;
        if (field === 'timeoutSec') {
          draft.roles[roleName].timeoutSec = el.value === '' ? null : Number(el.value);
        } else {
          (draft.roles[roleName] as Record<string, unknown>)[field] = el.value;
        }
        markDirty();
      });
    });

  document.querySelectorAll<HTMLButtonElement>('[data-delete-role]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!draft) return;
      const roleName = btn.dataset.deleteRole;
      if (roleName) {
        delete draft.roles[roleName];
        dirty = true;
        render();
      }
    });
  });

  document.getElementById('btn-add-role')?.addEventListener('click', () => {
    if (!draft) return;
    const clean = newRoleName.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(clean)) {
      setBanner(labels.invalidRole, 'error');
      return;
    }
    if (draft.roles[clean]) {
      setBanner(labels.duplicateRole(clean), 'warn');
      return;
    }
    draft.roles[clean] = {
      model: '',
      thinking: 'inherit',
      tools: '',
      timeoutSec: null,
      codexModel: '',
      codexThinking: '',
      codexSandbox: 'inherit',
    };
    newRoleName = '';
    dirty = true;
    banner = '';
    render();
  });

  document.getElementById('btn-reset-defaults')?.addEventListener('click', () => {
    if (!state || !draft) return;
    draft = { ...structuredClone(state.defaults), harness: draft.harness };
    dirty = true;
    setBanner(labels.defaultsRestored, 'warn');
  });

  document.getElementById('btn-save')?.addEventListener('click', async () => {
    if (!draft || busy) return;
    busy = true;
    banner = '';
    render();
    try {
      const res = await app.callServerTool({
        name: 'app_save_settings',
        arguments: { settings: draft },
      });
      if (res.isError) {
        const msg = res.content?.map((c) => ('text' in c ? c.text : '')).join('\n') || labels.saveFailed;
        setBanner(msg, 'error');
      } else if (res.structuredContent) {
        applyIncomingState(res.structuredContent as unknown as AppState, true);
        setBanner(labels.settingsSaved, 'ok');
      }
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      busy = false;
      render();
    }
  });
}

app.ontoolresult = (result) => {
  if (result?.structuredContent?.settings) {
    applyIncomingState(result.structuredContent as unknown as AppState, !dirty);
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function init() {
  render();
  await app.connect();
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);

  if (!state) {
    const res = await app.callServerTool({ name: 'app_get_state', arguments: {} });
    if (res.structuredContent) {
      applyIncomingState(res.structuredContent as unknown as AppState, true);
    }
  }
}

init().catch((err) => {
  root.innerHTML = `<div class="container"><div class="card">${labels.initFailed}: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
});
