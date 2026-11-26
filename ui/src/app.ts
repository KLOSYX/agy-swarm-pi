import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

interface Profile {
  model: string;
  thinking: string;
  tools: string;
  timeoutSec: number | null;
}

interface Settings {
  version: number;
  piPath: string;
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

interface AppState {
  settings: Settings;
  defaults: Settings;
  thinkingLevels: string[];
  roleThinkingOptions: string[];
  piStatus: { found: boolean; path: string | null; searched: string[] };
  modelsCache: {
    updatedAt: string | null;
    models: Array<{ id: string; raw: string }>;
    error: string | null;
  };
  recentTasks: TaskSnapshot[];
  settingsPath: string;
  initialTab?: 'tasks' | 'settings' | null;
}

const root = document.getElementById('app') as HTMLElement;
const app = new App({ name: 'Pi Swarm', version: '0.2.0' }, {});

let state: AppState | null = null;
let draft: Settings | null = null;
let activeTab: 'tasks' | 'settings' = 'settings';
let tabInitialized = false;
let dirty = false;
let busy = false;
let banner = '';
let bannerKind: 'ok' | 'warn' | 'error' = 'ok';
let newRoleName = '';
let pollTimer: number | null = null;

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
  state = nextState;
  if (!draft || resetDraft) {
    draft = structuredClone(nextState.settings);
    dirty = false;
  }
  if (nextState.initialTab) {
    activeTab = nextState.initialTab;
    tabInitialized = true;
  } else if (!tabInitialized) {
    activeTab = nextState.recentTasks.length > 0 ? 'tasks' : 'settings';
    tabInitialized = true;
  }
  render();
  scheduleAutoRefresh();
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
  if (indicator) indicator.textContent = '有未保存的更改';
}

function renderTasksTab(current: AppState): string {
  const tasks = current.recentTasks || [];
  if (tasks.length === 0) {
    return `
      <div class="card">
        <div class="empty-state">
          <div style="font-weight:600;margin-bottom:6px;">暂无 Pi 任务</div>
          <div class="hint">在对话中输入 <span class="mono">/swarm_pi &lt;任务&gt;</span> 后，所有并行运行的 Pi 任务、实际模型、工具调用与 Worktree 变更会实时显示在这里。</div>
        </div>
      </div>`;
  }

  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Pi 并发任务看板（共 ${tasks.length} 条）</span>
        <button id="btn-refresh-tasks" type="button" class="btn sm" ${busy ? 'disabled' : ''}>刷新状态</button>
      </div>
      ${tasks
        .map((t) => {
          const displayTitle = t.label || t.task_id;
          const configuredModel = t.profile.model || '(pi default)';
          const actualModel = t.actual_model || (t.status === 'running' ? '启动中...' : '未上报');
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
                  <span class="role-badge">${escapeHtml(t.profile.role || 'default')}</span>
                  <strong>${escapeHtml(displayTitle)}</strong>
                  <span class="hint mono">${escapeHtml(t.task_id)}</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                  <span class="status-pill ${escapeHtml(t.status)}">${escapeHtml(t.status)} · ${formatDuration(t.elapsed_ms)}</span>
                  ${
                    t.status === 'running'
                      ? `<button type="button" class="btn sm danger" data-cancel-task="${escapeHtml(t.task_id)}" ${busy ? 'disabled' : ''}>中止</button>`
                      : ''
                  }
                  ${
                    t.status !== 'running' && t.worktree?.enabled && !t.worktree.cleaned
                      ? `<button type="button" class="btn sm" data-cleanup-wt="${escapeHtml(t.task_id)}" ${busy ? 'disabled' : ''}>清理 Worktree</button>`
                      : ''
                  }
                </div>
              </div>

              <div class="meta-row">
                <span>配置模型：<span class="mono">${escapeHtml(configuredModel)}</span></span>
                <span>实际模型：<strong class="mono">${escapeHtml(actualModel)}</strong></span>
                <span>思考：<span class="mono">${escapeHtml(t.profile.thinking)}</span></span>
              </div>

              ${
                t.prompt_preview
                  ? `<div class="hint">${escapeHtml(t.prompt_preview)}${t.prompt_preview.length >= 180 ? '…' : ''}</div>`
                  : ''
              }

              ${toolChips ? `<div class="meta-row">工具调用：${toolChips}</div>` : ''}

              ${
                t.worktree?.enabled
                  ? `<div class="hint">
                      Worktree 分支：<span class="mono">${escapeHtml(t.worktree.branch)}</span>
                      ${t.worktree.cleaned ? '（已清理）' : `· 路径：<span class="mono">${escapeHtml(t.worktree.path)}</span>`}
                    </div>`
                  : ''
              }

              ${
                t.worktree?.diff_stat
                  ? `<details><summary>Worktree Diff 概览</summary><pre class="output-box">${escapeHtml(t.worktree.diff_stat)}</pre></details>`
                  : ''
              }

              ${
                t.error_text
                  ? `<pre class="output-box" style="color:var(--danger)">${escapeHtml(t.error_text)}</pre>`
                  : t.result_text
                    ? `<details ${t.status === 'completed' ? 'open' : ''}><summary>输出结果</summary><pre class="output-box">${escapeHtml(t.result_text)}</pre></details>`
                    : ''
              }
            </div>`;
        })
        .join('')}
    </div>`;
}

function renderSettingsTab(current: AppState, currentDraft: Settings): string {
  const models = current.modelsCache.models || [];
  const roleEntries = Object.entries(currentDraft.roles || {});

  return `
    <datalist id="pi-models-datalist">
      ${models.map((m) => `<option value="${escapeHtml(m.id)}"></option>`).join('')}
    </datalist>

    <div class="card">
      <div class="card-header">
        <span class="card-title">全局默认配置（Default）</span>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="pi-path">pi 可执行路径（auto 或绝对路径）</label>
          <input id="pi-path" type="text" value="${escapeHtml(currentDraft.piPath)}" placeholder="auto" />
        </div>
        <div class="field">
          <label for="def-model">默认模型（留空则沿用 pi 默认模型）</label>
          <input id="def-model" type="text" list="pi-models-datalist" value="${escapeHtml(currentDraft.default.model)}" placeholder="例如 anthropic/claude-sonnet-4-5" />
        </div>
      </div>
      <div class="field">
        <label>默认思考档位（--thinking）</label>
        <div class="segmented" id="def-thinking-group">
          ${current.thinkingLevels
            .map(
              (lvl) => `
            <button type="button" class="seg-btn ${currentDraft.default.thinking === lvl ? 'active' : ''}" data-def-thinking="${lvl}">
              ${lvl}
            </button>`,
            )
            .join('')}
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="def-tools">默认工具白名单（--tools）</label>
          <input id="def-tools" type="text" value="${escapeHtml(currentDraft.default.tools)}" placeholder="read,write,edit,bash" />
        </div>
        <div class="field">
          <label for="def-timeout">默认超时（秒，10–7200）</label>
          <input id="def-timeout" type="number" min="10" max="7200" value="${currentDraft.default.timeoutSec ?? 900}" />
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">按角色预设覆盖（Roles）</span>
        <span class="hint">留空模型或选 inherit 时继承全局默认</span>
      </div>

      ${roleEntries
        .map(
          ([roleName, role]) => `
        <div class="role-card" data-role="${escapeHtml(roleName)}">
          <div class="card-header">
            <span class="role-badge">${escapeHtml(roleName)}</span>
            <button type="button" class="btn sm danger" data-delete-role="${escapeHtml(roleName)}">删除角色</button>
          </div>
          <div class="grid-2">
            <div class="field">
              <label>模型（覆盖全局）</label>
              <input type="text" list="pi-models-datalist" data-role-field="model" data-role-name="${escapeHtml(roleName)}" value="${escapeHtml(role.model || '')}" placeholder="留空继承全局默认" />
            </div>
            <div class="field">
              <label>思考档位（--thinking）</label>
              <select data-role-field="thinking" data-role-name="${escapeHtml(roleName)}">
                ${current.roleThinkingOptions
                  .map(
                    (lvl) =>
                      `<option value="${lvl}" ${role.thinking === lvl ? 'selected' : ''}>${lvl}</option>`,
                  )
                  .join('')}
              </select>
            </div>
            <div class="field">
              <label>工具白名单（--tools）</label>
              <input type="text" data-role-field="tools" data-role-name="${escapeHtml(roleName)}" value="${escapeHtml(role.tools || '')}" placeholder="留空继承全局默认" />
            </div>
            <div class="field">
              <label>超时（秒，留空继承）</label>
              <input type="number" min="10" max="7200" data-role-field="timeoutSec" data-role-name="${escapeHtml(roleName)}" value="${role.timeoutSec ?? ''}" placeholder="继承全局" />
            </div>
          </div>
        </div>`,
        )
        .join('')}

      <div class="add-role-row">
        <input id="new-role-name" type="text" value="${escapeHtml(newRoleName)}" placeholder="新增角色名（小写字母/数字/_/-，如 architect）" />
        <button id="btn-add-role" type="button" class="btn">新增角色</button>
      </div>
    </div>`;
}

function render() {
  if (!state || !draft) {
    root.innerHTML = `<div class="container"><div class="card">正在加载 Pi Swarm 面板...</div></div>`;
    return;
  }

  const piOk = state.piStatus.found;
  const models = state.modelsCache.models || [];
  const runningCount = state.recentTasks.filter((t) => t.status === 'running').length;

  root.innerHTML = `
    <div class="container">
      <div class="header">
        <div class="title-group">
          <h1>Pi Swarm（/swarm_pi）</h1>
          <p class="subtitle">MCP 直调外部 Pi · 零中间代理 · 支持独立 Worktree 与角色预设</p>
        </div>
        <button id="btn-refresh-models" class="btn sm" ${busy ? 'disabled' : ''}>
          ${busy ? '处理中...' : '检测 Pi / 刷新模型'}
        </button>
      </div>

      <div class="tabs">
        <button type="button" class="tab-btn ${activeTab === 'tasks' ? 'active' : ''}" data-tab="tasks">
          任务看板
          <span class="badge ${runningCount > 0 ? 'running' : ''}">
            ${runningCount > 0 ? `${runningCount} 运行中` : state.recentTasks.length}
          </span>
        </button>
        <button type="button" class="tab-btn ${activeTab === 'settings' ? 'active' : ''}" data-tab="settings">
          模型与角色设置
          ${dirty ? '<span class="badge">未保存</span>' : ''}
        </button>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">运行环境</span>
          <span class="status-pill ${piOk ? 'ok' : 'warn'}">
            ${piOk ? `pi: <span class="mono">${escapeHtml(state.piStatus.path || '')}</span>` : '未检测到 pi 可执行文件'}
          </span>
        </div>
        ${
          !piOk
            ? `<div class="hint">请先安装 <span class="mono">npm i -g @mariozechner/pi-coding-agent</span> 或在设置中填写 <span class="mono">piPath</span>。</div>`
            : ''
        }
        ${
          state.modelsCache.error
            ? `<div class="hint" style="color:var(--warn)">模型列表刷新提示：${escapeHtml(state.modelsCache.error)}</div>`
            : models.length > 0
              ? `<div class="hint">已缓存 ${models.length} 个可用模型 · 配置文件：<span class="mono">${escapeHtml(state.settingsPath)}</span></div>`
              : `<div class="hint">配置文件：<span class="mono">${escapeHtml(state.settingsPath)}</span></div>`
        }
        ${
          banner
            ? `<div class="hint" style="color:var(--${bannerKind === 'error' ? 'danger' : bannerKind})">${escapeHtml(banner)}</div>`
            : ''
        }
      </div>

      ${activeTab === 'tasks' ? renderTasksTab(state) : renderSettingsTab(state, draft)}
    </div>

    ${
      activeTab === 'settings'
        ? `<div class="footer-bar">
            <span id="dirty-indicator" class="hint">${dirty ? '有未保存的更改' : '配置已同步'}</span>
            <div class="footer-actions">
              <button id="btn-reset-defaults" type="button" class="btn" ${busy ? 'disabled' : ''}>恢复默认</button>
              <button id="btn-save" type="button" class="btn primary" ${busy ? 'disabled' : ''}>保存设置</button>
            </div>
          </div>`
        : ''
    }
  `;

  bindEvents();
}

function bindEvents() {
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.tab as 'tasks' | 'settings';
      if (next && next !== activeTab) {
        activeTab = next;
        render();
        scheduleAutoRefresh();
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

  document.getElementById('btn-refresh-tasks')?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    render();
    try {
      const res = await app.callServerTool({ name: 'app_get_state', arguments: {} });
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
          setBanner(`已中止任务 ${taskId}。`, 'warn');
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
        if (res.structuredContent) {
          applyIncomingState(res.structuredContent as unknown as AppState, false);
          setBanner(`已清理任务 ${taskId} 的 Worktree 目录（分支已保留）。`, 'ok');
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

  const piPathInput = document.getElementById('pi-path') as HTMLInputElement | null;
  const defModelInput = document.getElementById('def-model') as HTMLInputElement | null;
  const defToolsInput = document.getElementById('def-tools') as HTMLInputElement | null;
  const defTimeoutInput = document.getElementById('def-timeout') as HTMLInputElement | null;
  const newRoleInput = document.getElementById('new-role-name') as HTMLInputElement | null;

  piPathInput?.addEventListener('input', () => {
    if (draft) {
      draft.piPath = piPathInput.value;
      markDirty();
    }
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
      setBanner('角色名需为 1-32 位小写字母、数字、下划线或连字符。', 'error');
      return;
    }
    if (draft.roles[clean]) {
      setBanner(`角色 "${clean}" 已存在。`, 'warn');
      return;
    }
    draft.roles[clean] = {
      model: '',
      thinking: 'inherit',
      tools: '',
      timeoutSec: null,
    };
    newRoleName = '';
    dirty = true;
    banner = '';
    render();
  });

  document.getElementById('btn-reset-defaults')?.addEventListener('click', () => {
    if (!state) return;
    draft = structuredClone(state.defaults);
    dirty = true;
    setBanner('已恢复为默认模板，点击“保存设置”后生效。', 'warn');
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
        const msg = res.content?.map((c) => ('text' in c ? c.text : '')).join('\n') || '保存失败';
        setBanner(msg, 'error');
      } else if (res.structuredContent) {
        applyIncomingState(res.structuredContent as unknown as AppState, true);
        setBanner('设置已保存并立即生效。', 'ok');
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
  if (result?.structuredContent) {
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
  root.innerHTML = `<div class="container"><div class="card">初始化失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
});
