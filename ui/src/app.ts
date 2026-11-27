import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod/v4';
import { panelText, thinkingLabel, type Language } from './locale';
import pluginManifest from '../../plugin.json';

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
  goal?: string | null;
  summary?: string | null;
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

interface BoardMember {
  name: string;
  role?: string;
  status: 'waiting' | 'working' | 'blocked';
  queued: number;
  turns: number;
  actualModel?: string;
  brief?: string;
  cwd?: string;
  taskId?: string | null;
  worktreeTaskId?: string | null;
  worktree?: boolean;
  latestTask?: {
    taskId?: string;
    status?: TaskSnapshot['status'];
    elapsedMs?: number;
    toolCalls?: string[];
    configuredModel?: string;
    actualModel?: string | null;
    worktreeBranch?: string | null;
    worktreePath?: string | null;
    worktreeCleaned?: boolean;
    logPath?: string;
  } | null;
}

interface Board extends BoardSummary {
  members: BoardMember[];
  messages: BoardMessage[];
  lastMessage: number;
}

interface BoardView extends Board {
  boards?: BoardSummary[];
}

interface UpdateCheck {
  currentVersion: string;
  installedVersion: string;
  latestVersion: string;
  releaseUrl: string;
  available: boolean;
  pendingReload: boolean;
  openBoards: number;
  installBlock: string | null;
}

interface UpdateFailure {
  status: 'error';
  code: string;
  detail: string;
}

interface InstalledUpdate {
  status: 'installed';
  installedVersion: string;
  backupPath: string;
}

interface AppState {
  pluginVersion?: string;
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
const app = new App({ name: 'Pi Swarm', version: pluginManifest.version }, {});
const harnessName = { pi: 'Pi', codex: 'Codex' };
const brand = `<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
  <path d="M8 20.5 16 7l8 13.5M8 20.5h16M16 7v18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
  <circle cx="16" cy="7" r="2.6" fill="currentColor"/>
  <circle cx="8" cy="20.5" r="2.6" fill="currentColor"/>
  <circle cx="24" cy="20.5" r="2.6" fill="currentColor"/>
  <circle cx="16" cy="25" r="2.3" fill="currentColor"/>
</svg>`;
const glyphs = {
  board: '<path d="M3 4h10v7H7l-3 2v-2H3z"/>',
  tasks: '<path d="m3 5 1 1 2-2m2 1h5M3 10h3v3H3zm5 1.5h5"/>',
  settings: '<path d="M3 5h10M3 11h10M6 3v4m4 2v4"/>',
  send: '<path d="m3 8 10-5-3 10-2.5-4.5L3 8Zm4.5.5L13 3"/>',
  file: '<path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 8h4m-4 2.5h4"/>',
  terminal: '<path d="M2.5 3.5h11v9h-11zM5 6l2 2-2 2m4 0h2"/>',
  chevron: '<path d="m5 6.5 3 3 3-3"/>',
  branch: '<path d="M5 6v4m2 2h1a3 3 0 0 0 3-3V6"/><circle cx="5" cy="4.5" r="1.5"/><circle cx="5" cy="11.5" r="1.5"/><circle cx="11" cy="4.5" r="1.5"/>',
};

let state: AppState | null = null;
let language: Language = 'en';
let labels = panelText.en;
let savingLanguage = false;
let updateCheck: UpdateCheck | null = null;
let updateFailure: UpdateFailure | null = null;
let installedUpdate: InstalledUpdate | null = null;
let updateAction: 'checking' | 'installing' | null = null;
let confirmUpdate = false;
let releaseLinkFailed = false;

let draft: Settings | null = null;
let activeTab: Tab = 'settings';
let boardId = '';
let board: Board | null = null;
let boardTimer: number | null = null;
let boardRefreshSerial = 0;
let boardError = '';
let selectedMember = '';
let overviewRecipient = '';
const boardDrafts = new Map<string, string>();
let boardPostStatus: { recipient: string; text: string; failed: boolean } | null = null;
let runtimeOpen = false;
const logFallbacks = new Set<string>();
const openingLogs = new Set<string>();
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
  if (!state) return;
  const hasRunning = state.recentTasks.some((task) => task.status === 'running');
  pollTimer = window.setTimeout(async () => {
    try {
      if (busy || document.hidden) return;
      const res = await app.callServerTool({ name: 'app_get_state', arguments: {} });
      if (!state || busy || !res.structuredContent) return;
      const next = res.structuredContent as unknown as AppState;
      const changed = JSON.stringify(state.recentTasks) !== JSON.stringify(next.recentTasks);
      if (!changed) return;
      if (activeTab === 'tasks') applyIncomingState(next, false);
      else {
        state.recentTasks = next.recentTasks;
        updateTabActivity();
      }
    } catch {
      // Keep the last known state during transient poll errors.
    } finally {
      scheduleAutoRefresh();
    }
  }, hasRunning ? 2500 : 6500);
}

function selectBoard(id: string) {
  if (id === boardId) return;
  boardId = id;
  board = null;
  boardError = '';
  selectedMember = '';
  overviewRecipient = '';
  boardDrafts.clear();
  boardPostStatus = null;
}

function applyIncomingState(nextState: AppState, resetDraft = false) {
  if (!state) useLanguage(nextState.language === 'zh-CN' ? 'zh-CN' : 'en');
  state = nextState;
  if (!draft || resetDraft) {
    draft = structuredClone(nextState.settings);
    dirty = false;
  }
  if (nextState.initialBoard) {
    selectBoard(nextState.initialBoard.id);
    if (!board || nextState.initialBoard.lastMessage >= board.lastMessage) {
      const messages = board?.messages || [];
      const cursor = messages.at(-1)?.number || 0;
      board = { ...nextState.initialBoard, messages: [...messages, ...nextState.initialBoard.messages.filter((message) => message.number > cursor)] };
    }
    if (selectedMember && !board?.members.some(({ name }) => name === selectedMember)) selectedMember = '';
    boardError = '';
  } else if (!boardId && nextState.boards.length) {
    selectBoard(nextState.boards[0].id);
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

function icon(name: keyof typeof glyphs): string {
  return `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name]}</svg>`;
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
  const badge = root.querySelector<HTMLElement>('[data-tab="settings"] .unsaved-dot');
  if (badge) badge.hidden = false;
}

function statusPill(status: BoardMember['status'] | TaskSnapshot['status']): string {
  return `<span class="status-pill ${status}"><span class="status-dot" aria-hidden="true"></span>${labels[status]}</span>`;
}

function metadata(label: string, value?: string | null): string {
  return value ? `<div><dt>${label}</dt><dd class="mono">${escapeHtml(value)}</dd></div>` : '';
}

function renderToolCalls(calls?: string[]): string {
  if (!calls?.length) return '';
  const counts = new Map<string, number>();
  for (const name of calls) counts.set(name, (counts.get(name) ?? 0) + 1);
  const chips = Array.from(counts, ([name, count]) =>
    `<span class="chip">${escapeHtml(name)} <span class="chip-count">×${count}</span></span>`).join('');
  return `<div class="tool-row"><span class="hint">${labels.toolCalls}</span><div class="chip-list">${chips}</div></div>`;
}

function renderLogFallback(path: string): string {
  if (!logFallbacks.has(path)) return '';
  return `<div class="log-fallback">
    <p class="hint" role="status">${labels.logFallback}</p>
    <code class="log-path">${escapeHtml(path)}</code>
    <button class="btn sm" type="button" data-copy-log>${labels.copyPath}</button>
  </div>`;
}

function renderLogAction(path?: string): string {
  return path ? `<div class="log-action" data-log-path="${escapeHtml(path)}">
    <button class="btn sm" type="button" data-open-log aria-disabled="${openingLogs.has(path)}">${icon('file')}${labels.openLog}</button>
    <div class="log-feedback">${renderLogFallback(path)}</div>
  </div>` : '';
}

function renderRoster(current: Board): string {
  return current.members.map((member) => {
    const name = escapeHtml(member.name);
    const model = member.latestTask?.actualModel || member.latestTask?.configuredModel || member.actualModel;
    const hasWorktree = member.worktree || member.worktreeTaskId || member.latestTask?.worktreeBranch
      || member.latestTask?.worktreePath || member.latestTask?.worktreeCleaned;
    const worktreeDetail = member.latestTask?.worktreeCleaned ? labels.worktreeCleaned : member.latestTask?.worktreeBranch;
    const worktreeTitle = escapeHtml(worktreeDetail ? `${labels.worktree} · ${worktreeDetail}` : labels.worktree);
    return `<li><button class="member-card" type="button" data-member="${name}"
        aria-pressed="${member.name === selectedMember}" aria-controls="board-inspector board-feed">
      <span class="member-top"><strong>@${name}</strong><span class="status-dot ${member.status}" aria-hidden="true"></span></span>
      <span class="member-meta"><span class="role-badge">${escapeHtml(member.role || labels.defaultRole)}</span>
        <span class="member-state ${member.status}">${labels[member.status]}</span></span>
      <span class="member-model">
        <span class="chip model-chip" ${model ? `title="${escapeHtml(model)}"` : ''}>${escapeHtml(model || labels.modelNotReported)}</span>
        ${hasWorktree ? `<span class="worktree-indicator" title="${worktreeTitle}" role="img" aria-label="${worktreeTitle}">${icon('branch')}</span>` : ''}
      </span>
      <span class="member-counts"><span>${labels.turns(member.turns)}</span><span>${labels.queued(member.queued)}</span></span>
    </button></li>`;
  }).join('');
}

function renderInspector(current: Board, canPost: boolean): string {
  const member = current.members.find((item) => item.name === selectedMember);
  if (!member) return '';
  const task = member.latestTask;
  const location = [
    metadata(labels.workspace, member.cwd),
    metadata(labels.worktreeBranch, task?.worktreeBranch),
    metadata(labels.worktreePath, task?.worktreePath),
    metadata(labels.worktreeTaskId, member.worktreeTaskId),
  ].join('');
  const taskDetails = [
    metadata(labels.taskId, task?.taskId || member.taskId),
    metadata(labels.elapsed, task?.elapsedMs == null ? '' : formatDuration(task.elapsedMs)),
    metadata(labels.configuredModel, task?.configuredModel),
    metadata(labels.actualModel, task ? task.actualModel : member.actualModel),
  ].join('');
  const name = escapeHtml(member.name);
  return `<details class="card inspector-card" data-disclosure="worker-${name}" open>
    <summary class="inspector-heading">
      <span><span class="inspector-caption">${labels.inspector}</span><strong class="mono">@${name}</strong></span>
      <span class="inspector-status">${statusPill(member.status)}${icon('chevron')}</span>
    </summary>
    <div class="inspector-body">
    ${canPost ? `<button class="btn sm inspector-message" type="button" data-message-member="${name}">${icon('send')}${escapeHtml(labels.messageMember(member.name))}</button>` : ''}
    ${member.brief ? `<div class="inspector-group"><h4>${labels.brief}</h4><p class="board-message-text">${escapeHtml(member.brief)}</p></div>` : ''}
    ${location ? `<dl class="metadata">${location}</dl>` : ''}
    ${task?.worktreeCleaned ? `<span class="status-pill ok">${labels.worktreeCleaned}</span>` : ''}
    ${task || taskDetails ? `<div class="inspector-group">
      <div class="card-header"><h4>${labels.latestTask}</h4>${task?.status ? statusPill(task.status) : ''}</div>
      ${taskDetails ? `<dl class="metadata">${taskDetails}</dl>` : ''}
      ${renderToolCalls(task?.toolCalls)}
      ${renderLogAction(task?.logPath)}
    </div>` : ''}
    ${!member.brief && !location && !task && !taskDetails ? `<p class="hint">${labels.noMemberDetails}</p>` : ''}
    </div>
  </details>`;
}

function renderMemberStatus(current: Board): string {
  const counts = { working: 0, waiting: 0, blocked: 0 };
  for (const { status } of current.members) counts[status]++;
  const stats = [
    { status: 'working', text: labels.workingWorkers(counts.working), count: counts.working },
    { status: 'waiting', text: labels.waitingWorkers(counts.waiting), count: counts.waiting },
    { status: 'blocked', text: labels.blockedWorkers(counts.blocked), count: counts.blocked },
  ];
  return `<ul class="swarm-status" aria-label="${labels.workerStatus}">${stats.filter(({ count }) => count > 0)
    .map(({ status, text }) => `<li class="${status}"><span class="status-dot ${status}" aria-hidden="true"></span>${text}</li>`).join('')}</ul>`;
}

function renderBoardHeader(summary: BoardSummary, current: Board | null): string {
  const goal = current?.goal || summary.goal;
  const description = goal || current?.summary || summary.summary;
  return `<div class="swarm-identity">
    <h2 id="board-title">${escapeHtml(summary.title)}</h2>
    <span class="status-pill harness-pill">${harnessName[summary.harness]}</span>
    ${summary.closed ? `<span class="status-pill">${labels.closed}</span>` : ''}
  </div>
  ${description ? `<div class="swarm-goal"><span class="hint">${goal ? labels.swarmGoal : labels.swarmSummary}</span>
    <p>${escapeHtml(description)}</p></div>` : ''}
  ${current?.members.length ? renderMemberStatus(current) : ''}`;
}

function renderBoardDetails(current: Board, canPost: boolean): string {
  if (selectedMember) return renderInspector(current, canPost);
  const progress = current.members.reduce((totals, member) => {
    totals.turns += member.turns;
    totals.queued += member.queued;
    return totals;
  }, { turns: 0, queued: 0 });
  return `<section class="card progress-card" aria-labelledby="board-progress-title">
    <h3 id="board-progress-title">${labels.swarmProgress}</h3>
    <dl class="board-progress">
      <div><dt>${labels.turnsStarted}</dt><dd>${progress.turns}</dd></div>
      <div><dt>${labels.queuedInstructions}</dt><dd>${progress.queued}</dd></div>
      <div><dt>${labels.boardPosts}</dt><dd>${current.lastMessage}</dd></div>
    </dl>
  </section>`;
}

function visibleMessages(messages: BoardMessage[]): BoardMessage[] {
  if (!selectedMember) return messages;
  return messages.filter(({ from, to, text }) =>
    from === selectedMember || to === selectedMember ||
    Array.from(text.matchAll(/(?<![a-z0-9_@-])@([a-z0-9_-]+)/gi))
      .some(([, mention]) => mention.toLowerCase() === selectedMember));
}

function renderMessage(message: BoardMessage): string {
  const tone = message.kind === 'error' ? 'error'
    : message.kind === 'result' ? 'result'
      : message.from === 'coordinator' ? 'directive'
        : message.from === 'user' ? 'instruction' : 'handoff';
  const messageKind = {
    error: labels.messageError,
    result: labels.workerResult,
    directive: labels.directive,
    instruction: labels.userInstruction,
    handoff: labels.handoff,
  };
  const text = message.text || labels.handoffPosted;
  const safeText = escapeHtml(text);
  const time = new Date(message.time);
  return `<li class="board-message message-${tone}" id="board-message-${message.number}" tabindex="-1">
    <div class="message-heading">
      <div class="message-route"><span class="sender-chip">@${escapeHtml(message.from)}</span>
        ${message.to ? `<span class="hint" aria-hidden="true">→</span><span class="recipient-chip">@${escapeHtml(message.to)}</span>` : ''}
        <span class="message-kind">${messageKind[tone]}</span>
      </div>
      <span class="message-time"><span aria-label="${labels.messageNumber(message.number)}">#${message.number}</span>
        <time datetime="${escapeHtml(message.time)}">${escapeHtml(time.toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' }))}</time></span>
    </div>
    ${message.replyTo ? `<a class="reply-link" href="#board-message-${message.replyTo}" data-reply="${message.replyTo}">${labels.replyTo(message.replyTo)}</a>` : ''}
    ${text.length > 450 ? `<details class="message-disclosure" data-disclosure="message-${message.number}">
      <summary><span class="message-preview board-message-text">${escapeHtml(text.slice(0, 450))}…</span>
        <span class="disclosure-show">${labels.showOutput}</span><span class="disclosure-hide">${labels.hideOutput}</span></summary>
      <p class="board-message-text">${safeText}</p>
    </details>` : `<p class="board-message-text">${safeText}</p>`}
    ${message.actualModel ? `<span class="chip message-model">${escapeHtml(message.actualModel)}</span>` : ''}
    ${renderLogAction(message.logPath)}
  </li>`;
}

function renderBoardFeed(messages: BoardMessage[]): string {
  const visible = visibleMessages(messages);
  return `<ol class="board-messages">${visible.length ? visible.map(renderMessage).join('') :
    `<li class="empty-state">${selectedMember ? labels.noMemberMessages : labels.noMessages}</li>`}</ol>`;
}

function composerRecipient(current: Board): string {
  const preferred = selectedMember || overviewRecipient;
  return current.members.some(({ name }) => name === preferred) ? preferred : current.members[0]?.name || '';
}

function recipientOptions(current: Board): string {
  const target = composerRecipient(current);
  return current.members.map(({ name }) =>
    `<option value="${escapeHtml(name)}" ${name === target ? 'selected' : ''}>@${escapeHtml(name)}</option>`).join('');
}

function updateComposerTarget(current: Board) {
  const recipient = root.querySelector<HTMLSelectElement>('#board-recipient');
  const input = root.querySelector<HTMLTextAreaElement>('#board-instruction');
  const output = root.querySelector<HTMLOutputElement>('#board-post-status');
  if (!recipient || !input || !output) return;
  const target = composerRecipient(current);
  recipient.value = target;
  if (input.dataset.recipient !== target) {
    input.dataset.recipient = target;
    input.value = boardDrafts.get(target) || '';
  }
  input.placeholder = labels.composerFor(target);
  const feedback = boardPostStatus?.recipient === target ? boardPostStatus : null;
  const feedbackText = feedback?.text || '';
  if (output.value !== feedbackText) output.value = feedbackText;
  output.classList.toggle('is-danger', Boolean(feedback?.failed));
}

function renderComposer(current: Board): string {
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ + Enter' : 'Ctrl + Enter';
  return `<form id="board-form">
    <div class="composer-header"><label for="board-recipient">${labels.recipient}</label>
      <select id="board-recipient">${recipientOptions(current)}</select></div>
    <label class="sr-only" for="board-instruction">${labels.instruction}</label>
    <textarea id="board-instruction" required maxlength="4000" rows="3"></textarea>
    <div class="composer-actions"><span class="hint shortcut">${labels.submitShortcut(shortcut)}</span>
      <button class="btn primary" type="submit" ${savingLanguage || composing ? 'disabled' : ''}>${icon('send')}${labels.sendInstruction}</button></div>
    <output id="board-post-status" aria-live="polite"></output>
  </form>`;
}

function boardOptions(boards: BoardSummary[]): string {
  return boards.map(({ id, title, harness, closed }) =>
    `<option value="${escapeHtml(id)}" ${id === boardId ? 'selected' : ''}>${escapeHtml(title)} · ${harnessName[harness]}${closed ? ` · ${labels.closed}` : ''}</option>`,
  ).join('');
}

function renderBoardTab(current: AppState): string {
  if (!current.boards.length) {
    return `<section class="card"><h2>${labels.board}</h2><p class="empty-state">${labels.noBoard}</p></section>`;
  }
  const selected = board?.id === boardId ? board : null;
  const summary = current.boards.find(({ id }) => id === boardId) || selected || current.boards[0];
  const inactive = selected && selected.harness !== current.settings.harness;
  const canPost = Boolean(selected && !selected.closed && !inactive && selected.members.length);
  return `<section class="board-view" data-board-id="${escapeHtml(boardId)}" data-board-view="${selectedMember ? 'member' : 'overview'}" aria-labelledby="board-title">
    <div class="card swarm-header">
      <div id="swarm-header-details">${renderBoardHeader(summary, selected)}</div>
      <label class="board-picker"><span class="hint">${labels.switchSwarm}</span><select id="board-select">${boardOptions(current.boards)}</select></label>
    </div>
    <div id="board-error" class="callout is-danger" role="status">${escapeHtml(boardError)}</div>
    ${selected ? `<section class="card roster-card" aria-labelledby="roster-title">
      <div class="card-header"><h3 id="roster-title" class="card-title">${labels.subagents}</h3>
        <button id="board-all" class="filter-pill" type="button" data-member="" aria-pressed="${!selectedMember}"
          aria-controls="board-inspector board-feed">${labels.overview}</button></div>
      ${selected.members.length ? `<ul class="board-members">${renderRoster(selected)}</ul>` : `<p class="hint">${labels.noSubagents}</p>`}
    </section>` : ''}
    <div class="board-layout ${selected ? 'has-board' : ''}">
      ${selected ? `<aside id="board-inspector">${renderBoardDetails(selected, canPost)}</aside>` : ''}
      <section class="card conversation-card" aria-labelledby="timeline-title">
        <div class="card-header timeline-header"><h3 id="timeline-title" class="card-title">${escapeHtml(selectedMember ? labels.workerMessages(selectedMember) : labels.timeline)}</h3>
          <span id="board-filter-label" class="sr-only" ${selectedMember ? '' : 'hidden'}>@${escapeHtml(selectedMember)}</span></div>
        <div id="board-feed" tabindex="0" role="region" aria-labelledby="timeline-title">${selected ? renderBoardFeed(selected.messages) : `<p class="empty-state">${labels.loadingMessages}</p>`}</div>
        ${inactive && selected && !selected.closed ? `<p class="callout is-warning">${labels.inactiveBoard(harnessName[selected.harness])}</p>` : ''}
        ${selected && canPost ? renderComposer(selected) : ''}
      </section>
    </div>
  </section>`;
}

function updateBoardView(next: BoardView) {
  const hadBoards = Boolean(state?.boards.length);
  const previousSummary = state?.boards.find(({ id }) => id === next.id);
  if (state && next.boards && JSON.stringify(state.boards) !== JSON.stringify(next.boards)) {
    state.boards = next.boards;
    const picker = document.getElementById('board-select');
    if (picker) picker.innerHTML = boardOptions(next.boards);
  }
  const previous = board?.id === next.id ? board : null;
  if (previous && previous.lastMessage > next.lastMessage) return;
  const messages = previous?.messages || [];
  const cursor = messages.at(-1)?.number || 0;
  const added = next.messages.filter((m) => m.number > cursor);
  board = { ...next, messages: [...messages, ...added] };
  const lostSelection = selectedMember && !board.members.some(({ name }) => name === selectedMember);
  if (lostSelection) selectedMember = '';
  updateTabActivity();
  if (activeTab !== 'board') return;
  if (!previous || previous.closed !== next.closed || previous.harness !== next.harness || hadBoards !== Boolean(state?.boards.length)
    || Boolean(previous.members.length) !== Boolean(next.members.length)) {
    render();
    return;
  }
  const summary = state?.boards.find(({ id }) => id === next.id) || board;
  const header = document.getElementById('swarm-header-details');
  const headerMarkup = renderBoardHeader(summary, board);
  if (header && headerMarkup !== renderBoardHeader(previousSummary || previous, previous)) {
    header.innerHTML = headerMarkup;
  }
  if (JSON.stringify(previous.members) !== JSON.stringify(next.members)) {
    const roster = renderRoster(board);
    if (lostSelection || roster !== renderRoster(previous)) updateRoster(roster);
    const recipient = root.querySelector<HTMLSelectElement>('#board-recipient');
    if (recipient && JSON.stringify(previous.members.map(({ name }) => name)) !== JSON.stringify(next.members.map(({ name }) => name))) {
      recipient.innerHTML = recipientOptions(board);
      updateComposerTarget(board);
    }
  }
  updateBoardDetails();
  const feed = document.getElementById('board-feed');
  if (!feed) return;
  if (lostSelection) {
    updateBoardFocus();
    return;
  }
  const visibleAdded = visibleMessages(added);
  if (visibleAdded.length) {
    const follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 30;
    feed.querySelector('.empty-state')?.remove();
    feed.querySelector('.board-messages')?.insertAdjacentHTML('beforeend', visibleAdded.map(renderMessage).join(''));
    if (follow) feed.scrollTop = feed.scrollHeight;
  }
}

function updateRoster(html: string) {
  const roster = root.querySelector<HTMLElement>('.board-members');
  if (roster) {
    const { scrollLeft, scrollTop } = roster;
    const focusedMember = (document.activeElement as HTMLElement | null)?.dataset.member;
    roster.innerHTML = html;
    roster.scrollLeft = scrollLeft;
    roster.scrollTop = scrollTop;
    Array.from(roster.querySelectorAll<HTMLButtonElement>('[data-member]'))
      .find((button) => button.dataset.member === focusedMember)?.focus({ preventScroll: true });
  }
}

function updateBoardDetails() {
  const inspector = root.querySelector<HTMLElement>('#board-inspector');
  if (!board || !inspector) return;
  const html = renderBoardDetails(board, Boolean(root.querySelector('#board-form')));
  if (inspector.dataset.rendered !== html) {
    const previous = inspector.querySelector<HTMLDetailsElement>('details[data-disclosure]');
    const activeElement = document.activeElement;
    const focusControl = activeElement && inspector.contains(activeElement)
      ? ['summary', '[data-message-member]', '[data-open-log]', '[data-copy-log]'].find((selector) => activeElement.matches(selector))
      : undefined;
    inspector.dataset.rendered = html;
    inspector.innerHTML = html;
    const details = inspector.querySelector<HTMLDetailsElement>('details[data-disclosure]');
    if (details && previous?.dataset.disclosure === details.dataset.disclosure) {
      details.open = previous?.open ?? true;
      if (focusControl) details.querySelector<HTMLElement>(focusControl)?.focus({ preventScroll: true });
    }
  }
}

function updateBoardFocus() {
  if (!board) return;
  const view = root.querySelector<HTMLElement>('.board-view');
  if (view) view.dataset.boardView = selectedMember ? 'member' : 'overview';
  root.querySelectorAll<HTMLButtonElement>('[data-member]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.member === selectedMember));
  });
  updateBoardDetails();
  updateComposerTarget(board);
  const title = document.getElementById('timeline-title');
  if (title) title.textContent = selectedMember ? labels.workerMessages(selectedMember) : labels.timeline;
  const label = document.getElementById('board-filter-label');
  if (label) {
    label.hidden = !selectedMember;
    label.textContent = `@${selectedMember}`;
  }
  const feed = document.getElementById('board-feed');
  if (feed) {
    const expanded = new Set(Array.from(feed.querySelectorAll<HTMLDetailsElement>('details[open][data-disclosure]'), (details) => details.dataset.disclosure));
    feed.innerHTML = renderBoardFeed(board.messages);
    feed.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]').forEach((details) => {
      if (expanded.has(details.dataset.disclosure)) details.open = true;
    });
    feed.scrollTop = feed.scrollHeight;
  }
}

function showBoardError(message: string) {
  boardError = message;
  const el = document.getElementById('board-error');
  if (el) el.textContent = message;
}

async function refreshBoard() {
  const id = boardId;
  if (!id && activeTab !== 'board') return;
  const request = ++boardRefreshSerial;
  try {
    const after = board?.id === id ? board.messages.at(-1)?.number || 0 : 0;
    const result = await app.callServerTool({ name: 'app_read_board', arguments: id ? { boardId: id, after } : {} });
    if (boardId !== id || request !== boardRefreshSerial) return;
    if (result.isError) throw new Error(result.content.map((item) => 'text' in item ? item.text : '').join(' '));
    if (!result.structuredContent) return;
    if (id) {
      updateBoardView(result.structuredContent as unknown as BoardView);
    } else {
      const { boards } = result.structuredContent as { boards: BoardSummary[] };
      if (state && boards.length) {
        state.boards = boards;
        selectBoard(boards[0].id);
        render();
      }
    }
    if (!composing) showBoardError('');
  } catch (error) {
    if (boardId === id && request === boardRefreshSerial && activeTab === 'board') {
      showBoardError(error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (request === boardRefreshSerial) scheduleBoardRefresh();
  }
}

function scheduleBoardRefresh() {
  if (boardTimer !== null) window.clearTimeout(boardTimer);
  const catchingUp = boardId && (
    board?.id !== boardId || (board.messages.at(-1)?.number || 0) < board.lastMessage
  );
  if (activeTab === 'board') boardTimer = window.setTimeout(refreshBoard, catchingUp ? 50 : 2000);
  else boardTimer = boardId && !board?.closed ? window.setTimeout(refreshBoard, 5000) : null;
}

function renderTasksTab(current: AppState): string {
  const tasks = current.recentTasks || [];
  const counts = { running: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const task of tasks) counts[task.status]++;
  return `
    <section class="tasks-view" aria-labelledby="tasks-title">
      <div class="view-heading">
        <h2 id="tasks-title">${labels.taskCount(tasks.length)}</h2>
        <button id="btn-refresh-tasks" type="button" class="btn sm" ${busy ? 'disabled' : ''}>${labels.refreshTasks}</button>
      </div>
      <dl class="task-stats">
        ${Object.entries(counts).filter(([status, count]) => status !== 'cancelled' || count > 0).map(([status, count]) =>
          `<div class="${status}"><dt><span class="status-dot" aria-hidden="true"></span>${labels[status as keyof typeof counts]}</dt><dd>${count}</dd></div>`).join('')}
      </dl>
      ${tasks.length ? `<div class="task-list">${tasks.map(renderTaskCard).join('')}</div>` : `<p class="card empty-state">${labels.noTasks}</p>`}
    </section>`;
}

function renderTaskCard(task: TaskSnapshot): string {
  const id = escapeHtml(task.task_id);
  const harness = harnessName[task.harness];
  const configuredModel = task.profile.model || labels.harnessDefault(harness);
  const actualModel = task.actual_model || (task.status === 'running' ? labels.starting : labels.modelNotReported);
  const worktree = task.worktree?.enabled ? task.worktree : null;
  const disabled = busy ? 'disabled' : '';
  return `<article class="task-card ${task.status}">
    <div class="card-header task-header">
      <div class="task-identity">
        <h3>${escapeHtml(task.label || task.task_id)}</h3>
        <div class="chip-list"><span class="role-badge">${escapeHtml(task.profile.role || labels.defaultRole)}</span>
          <span class="chip">${harness}</span>${task.label ? `<span class="hint mono">${id}</span>` : ''}</div>
      </div>
      ${statusPill(task.status)}
    </div>
    ${task.prompt_preview ? `<p class="task-prompt">${escapeHtml(task.prompt_preview)}${task.prompt_preview.length >= 180 ? '…' : ''}</p>` : ''}
    <dl class="metadata task-metadata">
      ${metadata(labels.elapsed, formatDuration(task.elapsed_ms))}
      ${metadata(labels.configuredModel, configuredModel)}
      ${metadata(labels.actualModel, actualModel)}
      ${metadata(labels.thinking, task.profile.thinking ? thinkingLabel(language, task.profile.thinking) : labels.cliDefault)}
      ${metadata(labels.workspace, task.cwd)}
      ${metadata(labels.worktreeBranch, worktree?.branch)}
      ${metadata(labels.worktreePath, worktree?.cleaned ? labels.worktreeCleaned : worktree?.path)}
    </dl>
    ${renderToolCalls(task.tool_calls)}
    ${worktree?.diff_stat ? `<details class="task-disclosure" data-disclosure="diff-${id}"><summary>${labels.worktreeDiff}</summary><pre class="output-box">${escapeHtml(worktree.diff_stat)}</pre></details>` : ''}
    ${task.error_text ? `<pre class="output-box is-danger">${escapeHtml(task.error_text)}</pre>` : ''}
    ${task.result_text ? `<details class="task-disclosure" data-disclosure="result-${id}"><summary>${labels.result}</summary><pre class="output-box">${escapeHtml(task.result_text)}</pre></details>` : ''}
    ${task.log_path || task.status === 'running' || (worktree && !worktree.cleaned) ? `<div class="task-actions">
      ${renderLogAction(task.log_path)}
      ${task.status === 'running'
        ? `<button type="button" class="btn sm danger" data-cancel-task="${id}" ${disabled}>${labels.cancel}</button>`
        : worktree && !worktree.cleaned ? `<button type="button" class="btn sm" data-cleanup-wt="${id}" ${disabled}>${labels.cleanWorktree}</button>` : ''}
    </div>` : ''}
  </article>`;
}

function renderCodexFields(current: AppState, profile: Profile, roleName?: string): string {
  const scope = (field: 'codexModel' | 'codexThinking' | 'codexSandbox') =>
    roleName ? `data-role-field="${field}" data-role-name="${escapeHtml(roleName)}"` : `data-codex-default="${field}"`;
  const fallback = roleName ? labels.inheritDefault : labels.cliDefault;
  const id = roleName ? `role-${escapeHtml(roleName)}` : 'def';
  return `
    <div class="field">
      <label for="${id}-codex-model">${labels.codexModel}</label>
      <input id="${id}-codex-model" type="text" ${scope('codexModel')} value="${escapeHtml(profile.codexModel)}" placeholder="${fallback}" />
    </div>
    <div class="field">
      <label for="${id}-codex-thinking">${labels.codexThinking}</label>
      <select id="${id}-codex-thinking" ${scope('codexThinking')}>
        <option value="">${fallback}</option>
        ${current.codexThinkingLevels.map((level) =>
          `<option value="${level}" ${profile.codexThinking === level ? 'selected' : ''}>${escapeHtml(thinkingLabel(language, level))}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="${id}-codex-sandbox">${labels.codexSandbox}</label>
      <select id="${id}-codex-sandbox" ${scope('codexSandbox')}>
        ${roleName ? '<option value="inherit">' + labels.inheritDefault + '</option>' : ''}
        ${current.codexSandboxModes.map((mode) =>
          `<option value="${mode}" ${profile.codexSandbox === mode ? 'selected' : ''}>${mode}</option>`).join('')}
      </select>
    </div>`;
}

function renderHarnessPicker(current: AppState, currentDraft: Settings): string {
  const codex = currentDraft.harness === 'codex';
  const cards = (['pi', 'codex'] as const).map((harness) => {
    const status = harness === 'pi' ? current.piStatus : current.codexStatus;
    return `<button type="button" class="harness-card" data-harness="${harness}" aria-pressed="${currentDraft.harness === harness}">
      <span class="harness-card-heading">
        <span class="harness-icon" aria-hidden="true">${harness === 'pi' ? 'π' : icon('terminal')}</span>
        <strong>${harnessName[harness]}</strong>
        <span class="status-pill ${status.found ? 'ok' : 'warn'}">${status.found ? labels.found : labels.missing}</span>
      </span>
      <span class="hint">${harness === 'pi' ? labels.piHarnessHint : labels.codexHarnessHint}</span>
      <span class="harness-path mono">${escapeHtml(status.path || labels.noBinaryPath)}</span>
    </button>`;
  }).join('');
  return `<section class="card settings-card">
    <h2 id="harness-title">${labels.harness}</h2>
    <select id="harness" hidden aria-labelledby="harness-title">
      <option value="pi" ${codex ? '' : 'selected'}>Pi</option>
      <option value="codex" ${codex ? 'selected' : ''}>Codex</option>
    </select>
    <div class="harness-grid" role="group" aria-labelledby="harness-title">${cards}</div>
    <div class="field">
      <label for="harness-path">${codex ? labels.codexExecutable : labels.piExecutable}</label>
      <input id="harness-path" type="text" value="${escapeHtml(codex ? currentDraft.codexPath : currentDraft.piPath)}" placeholder="auto" />
    </div>
    <p class="hint">${labels.harnessHelp}</p>
  </section>`;
}

function updateMessage(code: string): string {
  return Object.hasOwn(labels.updateMessages, code)
    ? labels.updateMessages[code as keyof typeof labels.updateMessages]
    : labels.updateMessages.installationFailed;
}

function renderUpdates(current: AppState): string {
  const checking = updateAction === 'checking';
  const installing = updateAction === 'installing';
  const stagedVersion = installedUpdate?.installedVersion
    ?? (updateCheck?.pendingReload ? updateCheck.installedVersion : null);
  const available = updateCheck?.available && !stagedVersion;
  const block = updateCheck?.installBlock;
  let feedback = '';
  if (checking || installing) {
    feedback = `<p class="hint">${checking ? labels.checkingUpdates : labels.installingUpdate}</p>`;
  } else if (updateFailure) {
    feedback = `<p class="callout is-danger" title="${escapeHtml(updateFailure.detail)}">${updateMessage(updateFailure.code)}${updateFailure.code === 'rollbackFailed' ? ` ${escapeHtml(updateFailure.detail)}` : ''}</p>`;
  } else if (stagedVersion) {
    feedback = `<p class="callout is-success">${escapeHtml(labels.reloadPlugin(stagedVersion))}</p>`;
  } else if (updateCheck) {
    feedback = `<p class="hint">${available ? labels.updateAvailable : labels.upToDate}</p>`;
  }

  return `<section class="card settings-card update-card" aria-labelledby="plugin-updates-title">
    <div class="card-header">
      <h2 id="plugin-updates-title">${labels.pluginUpdates}</h2>
      <button type="button" class="btn" id="check-updates" ${updateAction ? 'disabled' : ''}>${labels.checkUpdates}</button>
    </div>
    <dl class="metadata update-versions">
      ${metadata(labels.currentVersion, `v${current.pluginVersion || pluginManifest.version}`)}
      ${updateCheck ? metadata(labels.latestVersion, `v${updateCheck.latestVersion}`) : ''}
    </dl>
    <div aria-live="polite">${feedback}</div>
    ${available && block ? `<p class="hint">${updateMessage(block)}</p>` : ''}
    ${installedUpdate ? `<p class="hint">${labels.previousVersionBackup} <code>${escapeHtml(installedUpdate.backupPath)}</code></p>` : ''}
    ${confirmUpdate && updateCheck ? `
      <div class="callout is-warning">
        <p>${escapeHtml(labels.confirmInstall(updateCheck.latestVersion, updateCheck.openBoards))}</p>
        <div class="update-actions">
          <button type="button" class="btn" id="cancel-update">${labels.cancel}</button>
          <button type="button" class="btn primary" id="apply-update">${labels.installUpdate}</button>
        </div>
      </div>` : ''}
    ${updateCheck ? `<div class="update-actions">
      ${available && !block && !confirmUpdate ? `<button type="button" class="btn primary" id="confirm-update" ${updateAction ? 'disabled' : ''}>${labels.installUpdate}</button>` : ''}
      <button type="button" class="btn" id="release-details">${labels.viewRelease}</button>
    </div>` : ''}
    ${releaseLinkFailed && updateCheck ? `<p class="hint">${labels.copyReleaseLink} <code>${escapeHtml(updateCheck.releaseUrl)}</code></p>` : ''}
  </section>`;
}

async function runUpdate(action: 'checking' | 'installing') {
  if (updateAction) return;
  if (action === 'installing' && (!confirmUpdate || !updateCheck?.available || updateCheck.installBlock)) return;
  updateAction = action;
  updateFailure = null;
  confirmUpdate = false;
  releaseLinkFailed = false;
  render();
  try {
    const result = await app.callServerTool(action === 'checking'
      ? { name: 'app_check_update', arguments: {} }
      : { name: 'app_install_update', arguments: { expectedVersion: updateCheck!.latestVersion, confirmed: true } },
      { timeout: action === 'checking' ? 15000 : 45000 });
    if (result.isError || !result.structuredContent) throw new Error('Update tool did not return a result');
    const payload = result.structuredContent as unknown as UpdateCheck | UpdateFailure | InstalledUpdate;
    if ('status' in payload && payload.status === 'error') {
      updateFailure = payload;
      if (action === 'checking' || ['versionChanged', 'activeWork', 'reloadRequired'].includes(payload.code)) {
        updateCheck = null;
      }
    } else if ('status' in payload) {
      installedUpdate = payload;
    } else {
      updateCheck = payload;
    }
  } catch (error) {
    if (action === 'checking') updateCheck = null;
    updateFailure = {
      status: 'error', code: action === 'checking' ? 'checkFailed' : 'installationFailed',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    updateAction = null;
    render();
  }
}

function renderSettingsTab(current: AppState, currentDraft: Settings): string {
  const models = current.modelsCache.models || [];
  const roleEntries = Object.entries(currentDraft.roles || {});
  const codex = currentDraft.harness === 'codex';

  return `
    <datalist id="pi-models-datalist">
      ${models.map((m) => `<option value="${escapeHtml(m.id)}"></option>`).join('')}
    </datalist>

    <h2>${labels.settings}</h2>
    ${renderHarnessPicker(current, currentDraft)}
    ${renderUpdates(current)}
    <section class="card settings-card">
      <h2>${labels.globalDefaults}</h2>
      <div class="grid-2">
      ${codex ? renderCodexFields(current, currentDraft.default) : `
        <div class="field">
          <label for="def-model">${labels.defaultModel}</label>
          <input id="def-model" type="text" list="pi-models-datalist" value="${escapeHtml(currentDraft.default.model)}" placeholder="${labels.exampleModel}" />
        </div>
      <div class="field">
        <span id="def-thinking-label">${labels.defaultThinking}</span>
        <div class="segmented" id="def-thinking-group" role="group" aria-labelledby="def-thinking-label">
          ${current.thinkingLevels
            .map(
              (lvl) => `
            <button type="button" class="seg-btn" aria-pressed="${currentDraft.default.thinking === lvl}" data-def-thinking="${lvl}">
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
    </section>

    <section class="card settings-card">
      <h2>${labels.roles}</h2>
      <p class="hint">${labels.roleHelp}</p>

      <div class="role-list">
      ${roleEntries
        .map(
          ([roleName, role]) => `
        <section class="role-card" data-role="${escapeHtml(roleName)}">
          <div class="card-header">
            <h3 class="role-badge">${escapeHtml(roleName)}</h3>
            <button type="button" class="btn sm danger" data-delete-role="${escapeHtml(roleName)}">${labels.deleteRole}</button>
          </div>
          <div class="grid-2">
            ${codex ? renderCodexFields(current, role, roleName) : `
            <div class="field">
              <label for="role-${escapeHtml(roleName)}-model">${labels.roleModel}</label>
              <input id="role-${escapeHtml(roleName)}-model" type="text" list="pi-models-datalist" data-role-field="model" data-role-name="${escapeHtml(roleName)}" value="${escapeHtml(role.model || '')}" placeholder="${labels.inheritDefault}" />
            </div>
            <div class="field">
              <label for="role-${escapeHtml(roleName)}-thinking">${labels.roleThinking}</label>
              <select id="role-${escapeHtml(roleName)}-thinking" data-role-field="thinking" data-role-name="${escapeHtml(roleName)}">
                ${current.roleThinkingOptions
                  .map(
                    (lvl) =>
                      `<option value="${lvl}" ${role.thinking === lvl ? 'selected' : ''}>${escapeHtml(thinkingLabel(language, lvl))}</option>`,
                  )
                  .join('')}
              </select>
            </div>
            <div class="field">
              <label for="role-${escapeHtml(roleName)}-tools">${labels.roleTools}</label>
              <input id="role-${escapeHtml(roleName)}-tools" type="text" data-role-field="tools" data-role-name="${escapeHtml(roleName)}" value="${escapeHtml(role.tools || '')}" placeholder="${labels.inheritDefault}" />
            </div>`}
            <div class="field">
              <label for="role-${escapeHtml(roleName)}-timeout">${labels.roleTimeout}</label>
              <input id="role-${escapeHtml(roleName)}-timeout" type="number" min="10" max="7200" data-role-field="timeoutSec" data-role-name="${escapeHtml(roleName)}" value="${role.timeoutSec ?? ''}" placeholder="${labels.inheritDefault}" />
            </div>
          </div>
        </section>`,
        )
        .join('')}
      </div>

      <div class="add-role-row">
        <input id="new-role-name" type="text" aria-label="${labels.roleName}" value="${escapeHtml(newRoleName)}" placeholder="${labels.roleName}" />
        <button id="btn-add-role" type="button" class="btn">${labels.addRole}</button>
      </div>
    </section>`;
}

function renderHeader(current: AppState): string {
  const codex = current.settings.harness === 'codex';
  const activeHarness = harnessName[current.settings.harness];
  const status = codex ? current.codexStatus : current.piStatus;
  const tabs = { board: labels.boardTab, tasks: labels.tasksTab, settings: labels.settingsTab };
  return `<header class="app-header">
    <div class="header">
      <div class="brand">${brand}<h1>Pi Swarm</h1></div>
      <button type="button" class="status-pill runtime-toggle ${status.found ? 'ok' : 'warn'}"
        aria-expanded="${runtimeOpen}" aria-controls="runtime-drawer">
        <span class="status-dot" aria-hidden="true"></span>${activeHarness} <span class="runtime-divider">·</span>
        ${status.found ? labels.found : labels.missing}${icon('chevron')}
      </button>
    </div>
    <section id="runtime-drawer" class="card runtime-drawer" ${runtimeOpen ? '' : 'hidden'} aria-label="${labels.environment}">
      <div class="card-header">
        <h2 class="card-title">${labels.environment}</h2>
        <button id="btn-refresh-models" class="btn sm" type="button" ${busy ? 'disabled' : ''}>
          ${busy ? labels.checkingHarness : codex ? labels.detectCodex : labels.detectPi}
        </button>
      </div>
      <dl class="metadata runtime-metadata">
        ${metadata(labels.binaryPath, status.path || labels.noBinaryPath)}
        ${metadata(labels.settingsFile, current.settingsPath)}
      </dl>
      ${status.found ? '' : `<p class="callout is-warning">${codex ? labels.installCodex : labels.installPi}</p>`}
      ${!codex && current.modelsCache.error ? `<p class="callout is-warning">${labels.modelRefresh} · ${escapeHtml(current.modelsCache.error)}</p>`
        : !codex && current.modelsCache.models.length ? `<p class="hint">${labels.cachedModels(current.modelsCache.models.length)}</p>` : ''}
    </section>
    <div class="navigation">
      <nav class="tabs" aria-label="${labels.tabs}">
        ${(Object.keys(tabs) as Tab[]).map((tab) => `<button type="button" class="tab-btn ${activeTab === tab ? 'active' : ''}"
          data-tab="${tab}" ${activeTab === tab ? 'aria-current="page"' : ''}>
          ${icon(tab)}<span>${tabs[tab]}</span>
          ${tab === 'settings' ? `<span class="unsaved-dot" aria-label="${labels.unsaved}" title="${labels.unsaved}" ${dirty ? '' : 'hidden'}></span>` : ''}
        </button>`).join('')}
      </nav>
      <span id="tab-activity" class="activity-indicator" role="status" hidden>
        <span class="status-dot running" aria-hidden="true"></span><span class="activity-title">${labels.activity}</span>
        <span class="sr-only">${labels.liveActivity}</span>
      </span>
      <label class="language-picker" for="panel-language">
        <span class="sr-only">${labels.language}</span>
        <select id="panel-language" title="${labels.language}" ${savingLanguage ? 'disabled' : ''}>
          <option value="en" lang="en" ${language === 'en' ? 'selected' : ''}>English</option>
          <option value="zh-CN" lang="zh-CN" ${language === 'zh-CN' ? 'selected' : ''}>简体中文</option>
        </select>
      </label>
    </div>
  </header>`;
}

function updateTabActivity() {
  const activity = document.getElementById('tab-activity');
  const running = state?.recentTasks.some((task) => task.status === 'running');
  const working = board?.members.some((member) => member.status === 'working');
  if (activity) activity.hidden = !running && !working;
}

function render() {
  if (!state || !draft) {
    root.innerHTML = `<div class="container"><div class="card loading-panel" role="status">${brand}${labels.loadingPanel}</div></div>`;
    return;
  }
  const sameTab = root.querySelector<HTMLElement>('main')?.dataset.view === activeTab;
  const sameBoard = activeTab === 'board' && root.querySelector<HTMLElement>('.board-view')?.dataset.boardId === boardId;
  const disclosure = new Map(Array.from(
    sameTab && (activeTab !== 'board' || sameBoard) ? root.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]') : [],
    (details) => [details.dataset.disclosure, details.open],
  ));
  const previousInput = sameBoard ? root.querySelector<HTMLTextAreaElement>('#board-instruction') : null;
  const previousFeed = sameBoard ? document.getElementById('board-feed') : null;
  const scrollTop = previousFeed?.scrollTop || 0;
  const follow = !previousFeed || previousFeed.scrollHeight - previousFeed.scrollTop - previousFeed.clientHeight < 30;
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusedId = sameTab ? focused?.id : undefined;
  const focusedDisclosure = sameTab ? focused?.closest<HTMLDetailsElement>('details[data-disclosure]')?.dataset.disclosure : undefined;
  root.innerHTML = `
    <div class="container">
      ${renderHeader(state)}
      ${banner ? `<p class="callout ${bannerKind === 'error' ? 'is-danger' : bannerKind === 'warn' ? 'is-warning' : 'is-success'}" role="status">${escapeHtml(banner)}</p>` : ''}
      <main class="main" data-view="${activeTab}">
        ${activeTab === 'board' ? renderBoardTab(state) : activeTab === 'tasks' ? renderTasksTab(state) : renderSettingsTab(state, draft)}
      </main>
      ${activeTab === 'settings' ? `<footer class="footer-bar">
        <span id="dirty-indicator" class="hint" role="status">${dirty ? labels.unsavedChanges : labels.settingsSynced}</span>
        <div class="footer-actions">
          <button id="btn-reset-defaults" type="button" class="btn" ${busy ? 'disabled' : ''}>${labels.resetDefaults}</button>
          <button id="btn-save" type="button" class="btn primary" ${busy ? 'disabled' : ''}>${labels.saveSettings}</button>
        </div>
      </footer>` : ''}
    </div>
  `;
  bindEvents();
  updateTabActivity();
  root.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]').forEach((details) => {
    const key = details.dataset.disclosure;
    details.open = disclosure.get(key) ?? details.open;
    if (key === focusedDisclosure) details.querySelector('summary')?.focus({ preventScroll: true });
  });
  const input = root.querySelector<HTMLTextAreaElement>('#board-instruction');
  const feed = document.getElementById('board-feed');
  if (input && previousInput && input.dataset.recipient === previousInput.dataset.recipient) {
    input.setSelectionRange(previousInput.selectionStart, previousInput.selectionEnd);
  }
  if (feed) feed.scrollTop = follow ? feed.scrollHeight : scrollTop;
  if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
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
    const focused = select.isConnected
      && (document.activeElement === select || document.activeElement === document.body);
    if (error) setBanner(`${labels.languageFailed}: ${error}`, 'error');
    else render();
    if (focused) document.getElementById('panel-language')?.focus();
  }
}

function pathToFileUri(path: string): string {
  const encodeParts = (value: string) => value.split('/').map(encodeURIComponent).join('/');
  if (/^[a-z]:[\\/]/i.test(path)) {
    return `file:///${path.slice(0, 2)}${encodeParts(path.slice(2).replaceAll('\\', '/'))}`;
  }
  if (path.startsWith('\\\\')) {
    const normalized = path.slice(2).replaceAll('\\', '/');
    const separator = normalized.indexOf('/');
    if (separator > 0) {
      const host = normalized.slice(0, separator);
      if (/^[a-z0-9_.-]+$/i.test(host)) return `file://${host}${encodeParts(normalized.slice(separator))}`;
    }
  }
  if (path.startsWith('/')) return `file://${encodeParts(path)}`;
  throw new Error('Expected an absolute log path');
}

async function openLog(button: HTMLButtonElement, path: string) {
  if (openingLogs.has(path)) return;
  openingLogs.add(path);
  button.setAttribute('aria-disabled', 'true');
  try {
    // The Antigravity method extends the SDK's standard request union.
    const request = {
      method: 'com.google.antigravity/toggle-aux-pane',
      params: { tabType: 'fileView', uri: pathToFileUri(path) },
    } as unknown as Parameters<App['request']>[0];
    const result = await app.request(request, z.unknown(), { timeout: 3500 });
    if (result && typeof result === 'object' && 'isError' in result && result.isError) {
      throw new Error('File viewer reported an error');
    }
    logFallbacks.delete(path);
  } catch {
    logFallbacks.add(path);
  } finally {
    openingLogs.delete(path);
    root.querySelectorAll<HTMLElement>('[data-log-path]').forEach((action) => {
      if (action.dataset.logPath !== path) return;
      action.querySelector('[data-open-log]')?.setAttribute('aria-disabled', 'false');
      const feedback = action.querySelector('.log-feedback');
      if (feedback) feedback.innerHTML = renderLogFallback(path);
    });
  }
}

async function copyLogPath(button: HTMLButtonElement, path: string) {
  try {
    await navigator.clipboard.writeText(path);
    button.textContent = labels.copiedPath;
  } catch {
    const element = button.parentElement?.querySelector('.log-path');
    const selection = window.getSelection();
    if (element && selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    button.textContent = labels.selectPath;
  }
}

root.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const runtime = event.target.closest<HTMLButtonElement>('.runtime-toggle');
  if (runtime) {
    runtimeOpen = !runtimeOpen;
    runtime.setAttribute('aria-expanded', String(runtimeOpen));
    const drawer = document.getElementById('runtime-drawer');
    if (drawer) drawer.hidden = !runtimeOpen;
    return;
  }
  const member = event.target.closest<HTMLButtonElement>('[data-member]');
  if (member) {
    const name = member.dataset.member || '';
    selectedMember = name === selectedMember ? '' : name;
    updateBoardFocus();
    return;
  }
  const message = event.target.closest<HTMLButtonElement>('[data-message-member]');
  if (message) {
    root.querySelector<HTMLTextAreaElement>('#board-instruction')?.focus();
    return;
  }
  const reply = event.target.closest<HTMLAnchorElement>('[data-reply]');
  if (reply) {
    event.preventDefault();
    const id = `board-message-${reply.dataset.reply}`;
    if (!document.getElementById(id) && selectedMember) {
      selectedMember = '';
      updateBoardFocus();
    }
    const target = document.getElementById(id);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
    return;
  }
  const logButton = event.target.closest<HTMLButtonElement>('[data-open-log], [data-copy-log]');
  const path = logButton?.closest<HTMLElement>('[data-log-path]')?.dataset.logPath;
  if (logButton && path) {
    if (logButton.hasAttribute('data-open-log')) void openLog(logButton, path);
    else void copyLogPath(logButton, path);
  }
});

function bindEvents() {
  document.getElementById('check-updates')?.addEventListener('click', () => void runUpdate('checking'));
  document.getElementById('confirm-update')?.addEventListener('click', () => {
    confirmUpdate = true;
    render();
    document.getElementById('cancel-update')?.focus();
  });
  document.getElementById('cancel-update')?.addEventListener('click', () => {
    confirmUpdate = false;
    render();
    document.getElementById('confirm-update')?.focus();
  });
  document.getElementById('apply-update')?.addEventListener('click', () => void runUpdate('installing'));
  document.getElementById('release-details')?.addEventListener('click', async () => {
    const url = updateCheck?.releaseUrl;
    if (!url) return;
    try {
      releaseLinkFailed = Boolean((await app.openLink({ url })).isError);
    } catch {
      releaseLinkFailed = true;
    }
    if (releaseLinkFailed) render();
  });
  const languageSelect = document.getElementById('panel-language') as HTMLSelectElement | null;
  languageSelect?.addEventListener('change', () => void changeLanguage(languageSelect));

  const boardSelect = document.getElementById('board-select') as HTMLSelectElement | null;
  boardSelect?.addEventListener('change', () => {
    selectBoard(boardSelect.value);
    render();
    void refreshBoard();
  });

  const form = document.getElementById('board-form') as HTMLFormElement | null;
  const input = form?.querySelector<HTMLTextAreaElement>('#board-instruction');
  const recipient = form?.querySelector<HTMLSelectElement>('#board-recipient');
  if (board && input && recipient) {
    updateComposerTarget(board);
    input.addEventListener('input', () => {
      const target = input.dataset.recipient;
      if (target) boardDrafts.set(target, input.value);
    });
    recipient.addEventListener('change', () => {
      if (!board) return;
      if (selectedMember) {
        selectedMember = recipient.value;
        updateBoardFocus();
      } else {
        overviewRecipient = recipient.value;
        updateComposerTarget(board);
      }
    });
  }
  input?.addEventListener('keydown', (event) => {
    const key = event as KeyboardEvent;
    if (key.key === 'Enter' && (key.ctrlKey || key.metaKey) && !key.isComposing) {
      key.preventDefault();
      if (!composing && !savingLanguage) form?.requestSubmit();
    }
  });
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (composing || savingLanguage || !input || !recipient) return;
    const text = input.value.trim();
    const id = boardId;
    const to = recipient.value;
    if (!text || !to) return;
    boardDrafts.set(to, input.value);
    composing = true;
    const submitButton = () => root.querySelector<HTMLButtonElement>('#board-form button[type=submit]');
    const setPostStatus = (value: string, failed = false) => {
      if (boardId !== id || !board) return;
      boardPostStatus = { recipient: to, text: value, failed };
      updateComposerTarget(board);
    };
    submitButton()!.disabled = true;
    setPostStatus(labels.sending);
    try {
      const result = await app.callServerTool({
        name: 'app_post_board', arguments: { boardId: id, to, text },
      });
      if (boardId !== id) return;
      if (result.isError) throw new Error(result.content.map((item) => 'text' in item ? item.text : '').join(' '));
      if (boardDrafts.get(to)?.trim() === text) boardDrafts.delete(to);
      const currentInput = root.querySelector<HTMLTextAreaElement>('#board-instruction');
      if (currentInput?.dataset.recipient === to && currentInput.value.trim() === text) currentInput.value = '';
      setPostStatus(labels.instructionPosted);
      await refreshBoard();
    } catch (error) {
      setPostStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      composing = false;
      const button = submitButton();
      if (button) button.disabled = savingLanguage;
    }
  });

  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.tab as Tab;
      if (next && next !== activeTab) {
        activeTab = next;
        render();
        window.scrollTo(0, 0);
        root.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus({ preventScroll: true });
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
        if (res.isError) throw new Error(res.content.map((item) => 'text' in item ? item.text : '').join(' '));
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
    root.querySelector<HTMLButtonElement>(`[data-harness="${draft.harness}"]`)?.focus({ preventScroll: true });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-harness]').forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.harness;
      if (!harnessSelect || !value || harnessSelect.value === value) return;
      harnessSelect.value = value;
      harnessSelect.dispatchEvent(new Event('change'));
    });
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
      markDirty();
      root.querySelectorAll<HTMLButtonElement>('[data-def-thinking]').forEach((option) => {
        option.setAttribute('aria-pressed', String(option === btn));
      });
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
