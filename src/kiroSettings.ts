import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Kiro's durable CLI settings live at ~/.kiro/settings/cli.json (or
// $KIRO_HOME/settings/cli.json). A top-level `env` object is how operators
// pin REVA_* without exporting them in every shell that launches Kiro —
// hooks inherit the parent process env, but neither host's hook config has
// an `env` field of its own (see README).
//
// Shape confirmed on a real install (`kiro-cli settings` / the file itself):
//
//   {
//     "env": {
//       "REVA_AUTH_TOKEN": "…",
//       "REVA_HOST": "api.example.reva.ai",
//       "REVA_DEBUG": "1"
//     }
//   }
//
// Workspace `<cwd>/.kiro/settings/cli.json` overrides the global file when
// present (Kiro's own settings merge rule). Missing/malformed files are
// silent — there is simply nothing to apply.

export function resolveKiroHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.KIRO_HOME?.trim();
  return fromEnv || path.join(os.homedir(), '.kiro');
}

export function resolveGlobalCliJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveKiroHome(env), 'settings', 'cli.json');
}

export function resolveWorkspaceCliJsonPath(cwd: string): string {
  return path.join(cwd, '.kiro', 'settings', 'cli.json');
}

function readEnvBlockFromFile(filePath: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};

  const out: Record<string, string> = {};
  const root = data as Record<string, unknown>;
  const envBlock = root.env;
  if (envBlock && typeof envBlock === 'object' && !Array.isArray(envBlock)) {
    for (const [key, value] of Object.entries(envBlock as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) out[key] = value;
    }
  }
  // Also accept top-level REVA_* — not the documented Kiro shape, but
  // harmless if someone puts them there by habit.
  for (const [key, value] of Object.entries(root)) {
    if (key.startsWith('REVA_') && typeof value === 'string' && value.length > 0 && out[key] === undefined) {
      out[key] = value;
    }
  }
  return out;
}

export interface ReadKiroCliEnvOptions {
  // Explicit path (tests). When set, only this file is read — no global /
  // workspace merge.
  settingsPath?: string;
  // Working directory used to look up `<cwd>/.kiro/settings/cli.json`.
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Returns the string map from Kiro cli.json `env` (global, then workspace
 * overrides). Empty object when nothing is configured.
 */
export function readKiroCliEnv(options: ReadKiroCliEnvOptions = {}): Record<string, string> {
  const env = options.env || process.env;

  if (options.settingsPath) {
    return readEnvBlockFromFile(options.settingsPath);
  }

  const overridePath = env.REVA_KIRO_SETTINGS_PATH?.trim();
  if (overridePath) {
    return readEnvBlockFromFile(overridePath);
  }

  const globalEnv = readEnvBlockFromFile(resolveGlobalCliJsonPath(env));
  const cwd = options.cwd || process.cwd();
  const workspaceEnv = readEnvBlockFromFile(resolveWorkspaceCliJsonPath(cwd));
  return { ...globalEnv, ...workspaceEnv };
}

/**
 * Fills gaps in `env` from cli.json. Existing non-empty process values win,
 * so a one-shot `export REVA_HOST=…` still overrides the durable file for
 * that session. Mutates `env` in place (normally `process.env`) so debug.ts
 * and anything else that reads process.env directly also sees the values.
 */
export function applyKiroCliEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<ReadKiroCliEnvOptions, 'env'> = {},
): void {
  const fromFile = readKiroCliEnv({ ...options, env });
  for (const [key, value] of Object.entries(fromFile)) {
    if (env[key] === undefined || env[key] === '') {
      env[key] = value;
    }
  }
}

/**
 * Merge for loadConfig: cli.json as base, then `env` overrides. Empty-string
 * process values do not wipe a file value — same rule as applyKiroCliEnv.
 */
export function mergeEnvWithKiroCli(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<ReadKiroCliEnvOptions, 'env'> = {},
): NodeJS.ProcessEnv {
  const fromFile = readKiroCliEnv({ ...options, env });
  const merged: NodeJS.ProcessEnv = { ...fromFile };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') merged[key] = value;
  }
  return merged;
}
