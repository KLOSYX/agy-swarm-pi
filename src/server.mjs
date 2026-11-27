import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import {
  CODEX_SANDBOX_MODES,
  CODEX_THINKING_LEVELS,
  DEFAULT_SETTINGS,
  ROLE_THINKING_OPTIONS,
  SettingsStore,
  TASK_THINKING_LEVELS,
  THINKING_LEVELS,
} from './config.mjs';
import { SwarmBoards } from './board.mjs';
import { PiTaskManager, resolvePiExecutable } from './pi-runner.mjs';
import { resolveCodexExecutable } from './codex-runner.mjs';
import { PluginUpdates, updateError } from './plugin-updates.mjs';
import pluginManifest from '../plugin.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.PLUGIN_ROOT || path.resolve(__dirname, '..');
const SETTINGS_APP_URI = 'ui://swarm-pi/settings.html';
const memberName = z.string().regex(/^[a-z0-9_-]{1,32}$/);
const boardId = z.string().uuid();
const hostBinding = z.object({ conversationId: z.string().uuid(), proof: z.string().uuid() })
  .optional().describe('Injected by the Antigravity hook. Omit when calling this tool.');
const postShape = {
  boardId, to: memberName, text: z.string().trim().min(1),
};

function parseCliArgs(argv) {
  let dataDir =
    process.env.PLUGIN_DATA ||
    path.join(os.homedir(), '.gemini', 'config', 'plugins', 'swarm-pi', '.data');

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data-dir' && argv[i + 1]) {
      dataDir = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length);
    }
  }
  return { dataDir };
}

function jsonToolResult(payload, summaryText = null) {
  return {
    content: [
      {
        type: 'text',
        text: summaryText || JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function errorToolResult(err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

export function createSwarmPiServer({ dataDir, uiHtmlPath, pluginRoot = PLUGIN_ROOT, updateFetch } = {}) {
  const resolvedDataDir = dataDir || parseCliArgs(process.argv.slice(2)).dataDir;
  const resolvedUiPath =
    uiHtmlPath ||
    process.env.SWARM_PI_APP_HTML ||
    path.join(pluginRoot, 'ui', 'dist', 'settings.html');

  const settingsStore = new SettingsStore(resolvedDataDir);
  const languagePath = path.join(resolvedDataDir, 'ui-language');

  async function loadLanguage() {
    try {
      return (await fs.readFile(languagePath, 'utf8')).trim() === 'zh-CN' ? 'zh-CN' : 'en';
    } catch (err) {
      if (err.code === 'ENOENT') return 'en';
      throw err;
    }
  }
  const taskManager = new PiTaskManager({
    dataDir: resolvedDataDir,
    settingsStore,
    claimWork: () => updates.claimWork(),
  });

  const boards = new SwarmBoards(taskManager, settingsStore);
  const updates = new PluginUpdates({
    root: pluginRoot, dataDir: resolvedDataDir, version: pluginManifest.version, fetchRelease: updateFetch,
    hasActiveWork: () => taskManager.hasActiveWork() || boards.hasActiveWork(),
    openBoards: () => boards.list().filter((board) => !board.closed).length,
  });
  const server = new McpServer({
    name: 'swarm-pi',
    version: pluginManifest.version,
  });

  async function buildAppState(extra = {}) {
    const [settings, language] = await Promise.all([settingsStore.load(), loadLanguage()]);
    const [piStatus, codexStatus] = await Promise.all([
      resolvePiExecutable(settings.piPath),
      resolveCodexExecutable(settings.codexPath),
    ]);
    return {
      language,
      pluginVersion: pluginManifest.version,
      settings,
      defaults: DEFAULT_SETTINGS,
      thinkingLevels: THINKING_LEVELS,
      roleThinkingOptions: ROLE_THINKING_OPTIONS,
      codexThinkingLevels: CODEX_THINKING_LEVELS,
      codexSandboxModes: CODEX_SANDBOX_MODES,
      piStatus,
      codexStatus,
      modelsCache: taskManager.modelsCache,
      recentTasks: taskManager.listTasks({ limit: 25 }),
      settingsPath: settingsStore.filePath,
      boards: boards.list(),
      ...extra,
    };
  }

  registerAppResource(
    server,
    'Pi Swarm Panel',
    SETTINGS_APP_URI,
    {
      description: 'Shared Pi Swarm message board, task monitor, and Pi model settings',
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    async () => {
      let html;
      try {
        html = await fs.readFile(resolvedUiPath, 'utf8');
      } catch (err) {
        html = `<!doctype html><html><body><p>Failed to load Swarm Pi UI (${resolvedUiPath}): ${String(err.message || err)}</p></body></html>`;
      }
      return {
        contents: [
          {
            uri: SETTINGS_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                prefersBorder: false,
              },
            },
          },
        ],
      };
    },
  );

  registerAppTool(
    server,
    'open_pi_swarm_settings',
    {
      title: 'Pi Swarm',
      description:
        'Open the Pi Swarm panel. Pass tab="board" and boardId to focus a shared message board.',
      inputSchema: {
        tab: z
          .enum(['board', 'tasks', 'settings'])
          .optional()
          .describe('Which tab to focus'),
        boardId: boardId.optional().describe('Pi Swarm ID to focus'),
        focusRole: z
          .string()
          .optional()
          .describe('Optional role name to highlight in the settings UI'),
      },
      _meta: {
        ui: {
          resourceUri: SETTINGS_APP_URI,
        },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'Pi Swarm' },
            { type: 'global', title: 'Pi Swarm' },
          ],
        },
      },
    },
    async ({ tab, boardId: selectedBoardId } = {}) => {
      try {
        const state = await buildAppState({
          initialTab: tab || (selectedBoardId ? 'board' : null),
          initialBoard: selectedBoardId ? boards.read(selectedBoardId) : null,
        });
        const running = state.recentTasks.filter((t) => t.status === 'running').length;
        return jsonToolResult(
          state,
          `Opened Pi Swarm panel (tab=${tab || 'auto'}, runningTasks=${running}, harness=${state.settings.harness}).`,
        );
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  registerAppTool(
    server,
    'app_get_state',
    {
      title: 'Get Swarm Pi App State',
      description: 'App-only tool to fetch current settings, Pi binary status, and live task snapshots.',
      inputSchema: {},
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async () => {
      try {
        return jsonToolResult(await buildAppState());
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  registerAppTool(
    server,
    'app_set_language',
    {
      title: 'Set Pi Swarm Panel Language',
      description: 'Save the display language for the Pi Swarm panel.',
      inputSchema: { language: z.enum(['en', 'zh-CN']) },
      _meta: { ui: { visibility: ['app'] } },
    },
    async ({ language }) => {
      const temporaryPath = `${languagePath}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(resolvedDataDir, { recursive: true });
        await fs.writeFile(temporaryPath, `${language}\n`, { mode: 0o600 });
        await fs.rename(temporaryPath, languagePath);
        return jsonToolResult({ language });
      } catch (err) {
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
        return errorToolResult(err);
      }
    },
  );

  registerAppTool(
    server,
    'app_save_settings',
    {
      title: 'Save Swarm Pi Settings',
      description: 'App-only tool to persist updated Swarm Pi settings.',
      inputSchema: {
        settings: z.record(z.unknown()),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ settings }) => {
      try {
        await taskManager.updateSettings(settings, { fromPanel: true });
        const state = await buildAppState();
        return jsonToolResult(state, 'Settings saved.');
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  registerAppTool(
    server,
    'app_refresh_models',
    {
      title: 'Refresh Harness Availability',
      description: 'App-only tool to check executables and refresh the model list when Pi is selected.',
      inputSchema: {},
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async () => {
      try {
        if ((await settingsStore.load()).harness === 'pi') {
          await taskManager.listModels({ refresh: true });
        }
        return jsonToolResult(await buildAppState());
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  registerAppTool(
    server,
    'app_cancel_task',
    {
      title: 'Cancel Pi Task From App',
      description: 'App-only tool to cancel a running Pi task from the Tasks Monitor.',
      inputSchema: {
        taskId: z.string(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ taskId }) => {
      try {
        await taskManager.cancel(taskId);
        return jsonToolResult(await buildAppState());
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  registerAppTool(
    server,
    'app_cleanup_worktree',
    {
      title: 'Cleanup Worktree From App',
      description: 'App-only tool to remove a finished task git worktree from the Tasks Monitor.',
      inputSchema: {
        taskId: z.string(),
        deleteBranch: z.boolean().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ taskId, deleteBranch }) => {
      try {
        await taskManager.cleanupWorktree(taskId, {
          deleteBranch: Boolean(deleteBranch),
        });
        return jsonToolResult(await buildAppState());
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  function boardTool(name, description, inputSchema, handler, appOnly = false) {
    const config = { description, inputSchema };
    const call = async (args) => {
      try {
        return jsonToolResult(await handler(args));
      } catch (err) {
        return errorToolResult(err);
      }
    };
    if (appOnly) {
      registerAppTool(server, name, {
        ...config, _meta: { ui: { visibility: ['app'] } },
      }, call);
    } else {
      server.registerTool(name, config, call);
    }
  }

  // The App calls these tools only after a click. Expected version and
  // confirmation prevent installing a different release than the one shown.
  async function runUpdate(operation) {
    try {
      return await operation();
    } catch (err) {
      return updateError(err);
    }
  }

  boardTool('app_check_update', 'Check the latest published Swarm Pi release on GitHub.', {},
    () => runUpdate(() => updates.check()), true);
  boardTool('app_install_update', 'Install the selected Swarm Pi release after confirmation.', {
    expectedVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    confirmed: z.literal(true),
  }, ({ expectedVersion }) => runUpdate(() => updates.install(expectedVersion)), true);

  const readBoardShape = { boardId, after: z.number().int().nonnegative().optional() };
  const readAppBoard = ({ boardId, after }) => ({
    ...(boardId ? boards.read(boardId, after) : {}),
    boards: boards.list(),
  });
  boardTool('pi_create_swarm', 'Create a shared Pi Swarm board and its named worker roster.', {
    title: z.string().trim().min(1).max(120),
    cwd: z.string(), hostBinding,
    members: z.array(z.object({
      name: memberName,
      role: z.string().optional(),
      brief: z.string().max(4000).optional(),
      worktree: z.boolean().optional(),
      model: z.string().optional(),
      thinking: z.enum(TASK_THINKING_LEVELS).optional(),
      tools: z.string().optional().describe('Pi only. Omit when Codex is selected.'),
      timeoutSec: z.number().int().min(10).max(7200).optional(),
    })).min(1).max(12),
  }, (args) => boards.create(args));
  boardTool('pi_swarm_watch', 'Check coordinator wake readiness and queue any missed notification on an existing owned board. New owned boards subscribe automatically.', {
    ...readBoardShape, hostBinding,
  }, ({ boardId, after, hostBinding }) => boards.watch(boardId, after, hostBinding));
  boardTool('pi_swarm_post', 'Post as the coordinator and wake or queue the named worker. Returns the exact postedMessageNumber for matching replies.', postShape,
    ({ boardId, to, text }) => boards.post(boardId, 'coordinator', to, text));
  boardTool('pi_swarm_read', 'Read member status, latest task telemetry, and up to 50 messages after the cursor. With member and waitMs, wait for that worker to finish, a message involving that worker, or board closure. Returns the full board page.', {
    ...readBoardShape,
    waitMs: z.number().int().min(0).max(60000).optional(),
    member: memberName.optional(),
  }, ({ boardId, after, waitMs, member }) => boards.waitForMessages(boardId, after, waitMs, { member }));
  boardTool('pi_swarm_close', 'Close an idle Pi Swarm and release its worktrees for cleanup.', { boardId },
    ({ boardId }) => boards.close(boardId));
  boardTool('app_read_board', 'List swarms or read messages and member task telemetry for a selected board.',
    { ...readBoardShape, boardId: boardId.optional() }, readAppBoard, true);
  boardTool('app_post_board', 'Post a user message and wake or queue the named Pi worker.', postShape,
    ({ boardId, to, text }) => boards.post(boardId, 'user', to, text), true);

  server.registerTool(
    'pi_get_settings',
    {
      title: 'Get Pi Swarm Settings',
      description:
        'Inspect the selected external harness, Pi and Codex executable availability, and model and role settings. The harness is selected in the Pi Swarm panel.',
      inputSchema: {},
    },
    async () => {
      try {
        const state = await buildAppState();
        return jsonToolResult({
          piStatus: state.piStatus,
          codexStatus: state.codexStatus,
          settings: state.settings,
          settingsPath: state.settingsPath,
        });
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  server.registerTool(
    'pi_update_settings',
    {
      title: 'Update Pi Swarm Settings',
      description:
            'Update Swarm executable paths and model, reasoning, sandbox, tool, and timeout presets.',
      inputSchema: {
        piPath: z.string().optional().describe('Path to pi binary or "auto"'),
        codexPath: z.string().optional().describe('Path to the Codex CLI or "auto"'),
        default: z
          .object({
            model: z.string().optional(),
            thinking: z.enum(THINKING_LEVELS).optional(),
            tools: z.string().optional(),
            codexModel: z.string().optional(),
            codexThinking: z.enum(['', ...CODEX_THINKING_LEVELS]).optional(),
            codexSandbox: z.enum(CODEX_SANDBOX_MODES).optional(),
            timeoutSec: z.number().int().min(10).max(7200).optional(),
          })
          .optional(),
        roles: z
          .record(
            z
              .object({
                model: z.string().optional(),
                thinking: z.enum(ROLE_THINKING_OPTIONS).optional(),
                tools: z.string().optional(),
                codexModel: z.string().optional(),
                codexThinking: z.enum(['', ...CODEX_THINKING_LEVELS]).optional(),
                codexSandbox: z.enum(['inherit', ...CODEX_SANDBOX_MODES]).optional(),
                timeoutSec: z.number().int().min(10).max(7200).nullable().optional(),
              })
              .nullable(),
          )
          .optional(),
        deleteRoles: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      try {
        await taskManager.updateSettings(args);
        const { piStatus, codexStatus, settings } = await buildAppState();
        return jsonToolResult({ piStatus, codexStatus, settings });
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  server.registerTool(
    'pi_list_models',
    {
      title: 'List Pi Models',
      description: 'Run `pi --list-models` when Pi is the selected harness.',
      inputSchema: {
        refresh: z.boolean().optional().describe('Bypass cache and re-run pi --list-models'),
      },
    },
    async ({ refresh } = {}) => {
      try {
        const result = await taskManager.listModels({ refresh: Boolean(refresh) });
        return jsonToolResult(result);
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  server.registerTool(
    'pi_submit_task',
    {
      title: 'Submit Async Worker Task',
      description:
        'Start a task with the external harness selected in Settings. Use worktree=true for an isolated git worktree. The role and task overrides configure that harness.',
      inputSchema: {
        prompt: z.string().describe('Task prompt for the selected harness'),
        cwd: z.string().describe('Absolute path to the workspace directory'),
        label: z
          .string()
          .optional()
          .describe('Short human-readable task label shown in the Pi Swarm Tasks Monitor (e.g. parser-coder)'),
        role: z
          .string()
          .optional()
          .describe('Preset role name (e.g. coder, verifier, researcher)'),
        worktree: z
          .boolean()
          .optional()
          .describe('Set true to isolate concurrent editing tasks in a dedicated git worktree & branch'),
        model: z.string().optional().describe('Optional model override'),
        thinking: z
          .enum(TASK_THINKING_LEVELS)
          .optional()
          .describe('Optional thinking level override'),
        tools: z.string().optional().describe('Optional comma-separated tool allowlist for Pi. Omit when Codex is selected.'),
        timeoutSec: z.number().int().min(10).max(7200).optional(),
        sessionKey: z
          .string()
          .optional()
          .describe('Stable session key to continue the selected harness conversation. For a worktree, pass its effective cwd on follow-up turns.'),
      },
    },
    async (args) => {
      try {
        const result = await taskManager.submit(args);
        return jsonToolResult(result);
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  server.registerTool(
    'pi_poll_task',
    {
      title: 'Poll Async Worker Task',
      description:
        'Wait for or check the status and output of a submitted worker task. Uses long-polling up to waitMs (default 15000ms).',
      inputSchema: {
        taskId: z.string().describe('Task ID returned by pi_submit_task'),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(60000)
          .optional()
          .describe('Milliseconds to wait for completion before returning (default 15000)'),
      },
    },
    async ({ taskId, waitMs }) => {
      try {
        const result = await taskManager.poll(taskId, {
          waitMs: waitMs ?? 15000,
        });
        return jsonToolResult(result);
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  server.registerTool(
    'pi_wait_tasks',
    {
      title: 'Wait For Multiple Worker Tasks',
      description:
        'Wait on parallel worker tasks (mode="all" waits for all tasks or waitMs timeout; mode="any" wakes when any task finishes). Returns status, reported model, worktree diff stat, and results.',
      inputSchema: {
        taskIds: z
          .array(z.string())
          .min(1)
          .describe('Array of task IDs returned by pi_submit_task'),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(60000)
          .optional()
          .describe('Milliseconds to wait before returning current snapshots (default 20000)'),
        mode: z
          .enum(['all', 'any'])
          .optional()
          .describe('Whether to wait until all tasks finish or any task finishes (default "all")'),
      },
    },
    async ({ taskIds, waitMs, mode }) => {
      try {
        const result = await taskManager.waitTasks(taskIds, {
          waitMs: waitMs ?? 20000,
          mode: mode || 'all',
        });
        return jsonToolResult(result);
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  server.registerTool(
    'pi_cancel_task',
    {
      title: 'Cancel Async Worker Task',
      description: 'Terminate a running worker task by taskId.',
      inputSchema: {
        taskId: z.string(),
      },
    },
    async ({ taskId }) => {
      try {
        return jsonToolResult(await taskManager.cancel(taskId));
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  server.registerTool(
    'pi_cleanup_worktree',
    {
      title: 'Cleanup Task Git Worktree',
      description:
        'Remove the isolated git worktree directory created for a finished task (call after merging or discarding changes). Optionally deletes the temporary branch when deleteBranch=true.',
      inputSchema: {
        taskId: z.string().describe('Task ID whose worktree should be removed'),
        deleteBranch: z
          .boolean()
          .optional()
          .describe('Also delete the temporary swarm-pi/* branch (default false)'),
      },
    },
    async ({ taskId, deleteBranch }) => {
      try {
        return jsonToolResult(
          await taskManager.cleanupWorktree(taskId, {
            deleteBranch: Boolean(deleteBranch),
          }),
        );
      } catch (err) {
        return errorToolResult(err);
      }
    },
  );

  return { server, settingsStore, taskManager, boards, dataDir: resolvedDataDir };
}

async function main() {
  const { dataDir } = parseCliArgs(process.argv.slice(2));
  const pluginRoot = process.env.PLUGIN_ROOT || path.resolve(path.dirname(process.argv[1]), '..');
  const { server } = createSwarmPiServer({ dataDir, pluginRoot });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      fsSync.realpathSync(fileURLToPath(import.meta.url)) ===
      fsSync.realpathSync(process.argv[1])
    );
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
})();

if (isEntrypoint) {
  main().catch((err) => {
    console.error('swarm-pi server fatal error:', err);
    process.exit(1);
  });
}
