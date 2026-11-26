import fs from 'node:fs/promises';
import path from 'node:path';

export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export const ROLE_THINKING_OPTIONS = ['inherit', ...THINKING_LEVELS];
export const HARNESSES = ['pi', 'codex'];
export const CODEX_THINKING_LEVELS = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
];
export const TASK_THINKING_LEVELS = [...new Set([...THINKING_LEVELS, ...CODEX_THINKING_LEVELS])];
export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write'];
const INHERITED_HARNESS_SETTINGS = {
  codexModel: '', codexThinking: '', codexSandbox: 'inherit',
};

export const DEFAULT_SETTINGS = {
  version: 1,
  harness: 'pi',
  piPath: 'auto',
  codexPath: 'auto',
  default: {
    codexModel: '',
    codexThinking: '',
    codexSandbox: 'read-only',
    model: '',
    thinking: 'medium',
    tools: 'read,write,edit,bash',
    timeoutSec: 900,
  },
  roles: {
    coder: {
      ...INHERITED_HARNESS_SETTINGS,
      codexSandbox: 'workspace-write',
      model: '',
      thinking: 'medium',
      tools: 'read,write,edit,bash',
      timeoutSec: 900,
    },
    verifier: {
      ...INHERITED_HARNESS_SETTINGS,
      model: '',
      thinking: 'high',
      tools: 'read,grep,find,ls,bash',
      timeoutSec: 600,
    },
    researcher: {
      ...INHERITED_HARNESS_SETTINGS,
      model: '',
      thinking: 'low',
      tools: 'read,grep,find,ls',
      timeoutSec: 300,
    },
  },
};

function normalizeChoice(value, choices, fallback, field) {
  if (value === undefined || value === null) return fallback;
  const choice = String(value).trim().toLowerCase();
  if (!choices.includes(choice)) {
    throw new Error(`Invalid ${field} "${value}". Allowed: ${choices.join(', ')}`);
  }
  return choice;
}

function normalizeCodexSettings(input, fallback = {}, isRole = false) {
  return {
    codexModel: String(input?.codexModel ?? fallback.codexModel ?? '').trim(),
    codexThinking: normalizeChoice(input?.codexThinking, ['', ...CODEX_THINKING_LEVELS],
      fallback.codexThinking ?? '', 'Codex reasoning effort'),
    codexSandbox: normalizeChoice(input?.codexSandbox,
      isRole ? ['inherit', ...CODEX_SANDBOX_MODES] : CODEX_SANDBOX_MODES,
      fallback.codexSandbox ?? 'inherit', 'Codex sandbox mode'),
  };
}

function cloneDefaults() {
  return structuredClone(DEFAULT_SETTINGS);
}

function clampTimeout(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid timeoutSec: ${value}`);
  }
  const rounded = Math.round(num);
  if (rounded < 10 || rounded > 7200) {
    throw new Error(`timeoutSec must be between 10 and 7200 (got ${rounded})`);
  }
  return rounded;
}

function normalizeThinking(value, allowInherit, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  const valid = allowInherit ? ROLE_THINKING_OPTIONS : THINKING_LEVELS;
  if (!valid.includes(normalized)) {
    throw new Error(
      `Invalid thinking level "${value}". Allowed: ${valid.join(', ')}`,
    );
  }
  return normalized;
}

function normalizeTools(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(',');
}

function normalizeRoleName(name) {
  const clean = String(name || '')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(clean)) {
    throw new Error(
      `Invalid role name "${name}". Use 1-32 chars of [a-z0-9_-].`,
    );
  }
  return clean;
}

function normalizeRolePreset(input, fallbackPreset = {}) {
  return {
    ...normalizeCodexSettings(input, fallbackPreset, true),
    model:
      input?.model !== undefined
        ? String(input.model).trim()
        : (fallbackPreset.model ?? ''),
    thinking: normalizeThinking(
      input?.thinking,
      true,
      fallbackPreset.thinking ?? 'inherit',
    ),
    tools: normalizeTools(input?.tools, fallbackPreset.tools ?? ''),
    timeoutSec:
      input?.timeoutSec === '' || input?.timeoutSec === null
        ? null
        : input?.timeoutSec !== undefined
          ? clampTimeout(input.timeoutSec, null)
          : (fallbackPreset.timeoutSec ?? null),
  };
}

export function normalizeSettings(raw) {
  const base = cloneDefaults();
  if (!raw || typeof raw !== 'object') return base;

  const piPath =
    raw.piPath !== undefined && String(raw.piPath).trim() !== ''
      ? String(raw.piPath).trim()
      : base.piPath;

  const defRaw = raw.default && typeof raw.default === 'object' ? raw.default : {};
  const normalizedDefault = {
    ...normalizeCodexSettings(defRaw, base.default),
    model:
      defRaw.model !== undefined
        ? String(defRaw.model).trim()
        : base.default.model,
    thinking: normalizeThinking(defRaw.thinking, false, base.default.thinking),
    tools: normalizeTools(defRaw.tools, base.default.tools),
    timeoutSec: clampTimeout(defRaw.timeoutSec, base.default.timeoutSec),
  };

  const roles = {};
  if (raw.roles && typeof raw.roles === 'object') {
    for (const [key, val] of Object.entries(raw.roles)) {
      if (!val || typeof val !== 'object') continue;
      const roleKey = normalizeRoleName(key);
      roles[roleKey] = normalizeRolePreset(val, base.roles[roleKey]);
    }
  } else {
    Object.assign(roles, base.roles);
  }

  return {
    version: 1,
    harness: normalizeChoice(raw.harness, HARNESSES, base.harness, 'harness'),
    piPath,
    codexPath: String(raw.codexPath ?? '').trim() || base.codexPath,
    default: normalizedDefault,
    roles,
  };
}

export function resolveEffectiveProfile(settings, overrides = {}) {
  const roleName = overrides.role ? normalizeRoleName(overrides.role) : null;
  const rolePreset = roleName ? settings.roles?.[roleName] : undefined;
  const harness = settings.harness ?? 'pi';
  let timeoutSec = rolePreset?.timeoutSec ?? settings.default.timeoutSec;
  if (overrides.timeoutSec !== undefined && overrides.timeoutSec !== null) {
    timeoutSec = clampTimeout(overrides.timeoutSec, timeoutSec);
  }
  const common = { role: roleName, roleFound: Boolean(rolePreset), harness, timeoutSec };

  if (harness === 'codex') {
    if (overrides.tools?.trim()) {
      throw new Error('The tools allowlist is supported by Pi only. Set the Codex sandbox in the role or global settings.');
    }
    const sandbox = rolePreset?.codexSandbox;
    const thinking = overrides.thinking ? normalizeChoice(overrides.thinking, CODEX_THINKING_LEVELS,
      '', 'Codex reasoning effort') : (rolePreset?.codexThinking || settings.default.codexThinking);
    return {
      ...common,
      model: String(overrides.model ?? '').trim() || rolePreset?.codexModel || settings.default.codexModel,
      thinking,
      tools: '',
      sandbox: sandbox && sandbox !== 'inherit' ? sandbox : settings.default.codexSandbox,
    };
  }

  const model =
    overrides.model !== undefined && String(overrides.model).trim() !== ''
      ? String(overrides.model).trim()
      : rolePreset?.model
        ? rolePreset.model
        : settings.default.model;

  let thinking = settings.default.thinking;
  if (rolePreset?.thinking && rolePreset.thinking !== 'inherit') {
    thinking = rolePreset.thinking;
  }
  if (
    overrides.thinking !== undefined &&
    overrides.thinking !== null &&
    String(overrides.thinking).trim() !== ''
  ) {
    thinking = normalizeThinking(overrides.thinking, false, thinking);
  }

  let tools = settings.default.tools;
  if (rolePreset && rolePreset.tools !== '') {
    tools = rolePreset.tools;
  }
  if (overrides.tools !== undefined && overrides.tools !== null) {
    tools = normalizeTools(overrides.tools, tools);
  }

  return {
    ...common,
    model,
    thinking,
    tools,
  };
}

export class SettingsStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'settings.json');
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return normalizeSettings(JSON.parse(raw));
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const defaults = cloneDefaults();
        await this.save(defaults);
        return defaults;
      }
      throw err;
    }
  }

  async save(nextSettings) {
    const normalized = normalizeSettings(nextSettings);
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmpPath = path.join(
      this.dataDir,
      `.settings.${process.pid}.${Date.now()}.tmp`,
    );
    await fs.writeFile(
      tmpPath,
      `${JSON.stringify(normalized, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await fs.rename(tmpPath, this.filePath);
    return normalized;
  }

  async patch(patchInput = {}) {
    const current = await this.load();
    const merged = structuredClone(current);

    if (patchInput.piPath !== undefined) {
      merged.piPath = patchInput.piPath;
    }
    if (patchInput.codexPath !== undefined) {
      merged.codexPath = patchInput.codexPath;
    }
    if (patchInput.default && typeof patchInput.default === 'object') {
      merged.default = {
        ...merged.default,
        ...patchInput.default,
      };
    }
    if (patchInput.roles && typeof patchInput.roles === 'object') {
      for (const [key, val] of Object.entries(patchInput.roles)) {
        const roleKey = normalizeRoleName(key);
        if (val === null) {
          delete merged.roles[roleKey];
        } else if (typeof val === 'object') {
          merged.roles[roleKey] = {
            ...(merged.roles[roleKey] || {}),
            ...val,
          };
        }
      }
    }
    if (Array.isArray(patchInput.deleteRoles)) {
      for (const key of patchInput.deleteRoles) {
        const roleKey = normalizeRoleName(key);
        delete merged.roles[roleKey];
      }
    }

    return this.save(merged);
  }
}
