import * as fs from 'node:fs';
import * as path from 'node:path';
import { debugLog } from './debug';
import {
  ERROR_TYPE_PLUGIN_VERSION_UNSUPPORTED,
  isPluginVersionSupported,
  PluginVersionWindow,
  PLUGIN_VERSION,
  unsupportedPluginVersionReason,
} from './pluginVersion';

export type PluginVersionGateStatus =
  | { status: 'ok' }
  | { status: 'blocked'; reason: string; errorType: string }
  | { status: 'unknown' };

interface GateFile {
  status: 'ok' | 'blocked';
  pluginVersion: string;
  minimumSupportedVersion?: string;
  currentVersion?: string;
  reason?: string;
  errorType?: string;
  checkedAt: number;
}

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function cacheDir(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'plugin-version-gate') : undefined;
}

function cacheFile(sessionId: string, pluginDataDir?: string): string | undefined {
  const dir = cacheDir(pluginDataDir);
  if (!dir || !sessionId) return undefined;
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safe}.json`);
}

function sweepStale(dir: string): void {
  try {
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

export function readPluginVersionGate(
  sessionId: string | undefined,
  pluginDataDir?: string,
): PluginVersionGateStatus {
  if (!sessionId || !pluginDataDir) return { status: 'unknown' };
  const file = cacheFile(sessionId, pluginDataDir);
  if (!file) return { status: 'unknown' };
  try {
    const state: GateFile = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.status === 'blocked') {
      return {
        status: 'blocked',
        reason: state.reason || unsupportedPluginVersionReason(state.pluginVersion || PLUGIN_VERSION),
        errorType: state.errorType || ERROR_TYPE_PLUGIN_VERSION_UNSUPPORTED,
      };
    }
    if (state.status === 'ok') return { status: 'ok' };
  } catch {
    // missing/corrupt → re-check
  }
  return { status: 'unknown' };
}

export function markPluginVersionBlocked(
  sessionId: string,
  pluginDataDir: string | undefined,
  reason: string,
  errorType: string,
  window?: PluginVersionWindow,
): void {
  const file = cacheFile(sessionId, pluginDataDir);
  if (!file) return;
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    sweepStale(dir);
    const state: GateFile = {
      status: 'blocked',
      pluginVersion: PLUGIN_VERSION,
      minimumSupportedVersion: window?.minimumSupportedVersion,
      currentVersion: window?.currentVersion,
      reason,
      errorType,
      checkedAt: Date.now(),
    };
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch (err: any) {
    debugLog(`pluginVersionGate: failed to write blocked latch — ${err?.message || String(err)}`);
  }
}

function markOk(sessionId: string, pluginDataDir: string | undefined, window: PluginVersionWindow): void {
  const file = cacheFile(sessionId, pluginDataDir);
  if (!file) return;
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    sweepStale(dir);
    const state: GateFile = {
      status: 'ok',
      pluginVersion: PLUGIN_VERSION,
      minimumSupportedVersion: window.minimumSupportedVersion,
      currentVersion: window.currentVersion,
      checkedAt: Date.now(),
    };
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch (err: any) {
    debugLog(`pluginVersionGate: failed to write ok latch — ${err?.message || String(err)}`);
  }
}

/**
 * Session-scoped plugin version gate. PromptSubmit may call this; SessionStart does not call getVersion;
 * evaluate calls it lazily when the gate file is missing. Failures to reach
 * getVersion leave the gate unknown so evaluate can still send pluginVersion
 * and let RTG enforce.
 */
export async function ensurePluginVersionGate(
  sessionId: string | undefined,
  pluginDataDir: string | undefined,
  fetchWindow: () => Promise<PluginVersionWindow | null>,
): Promise<PluginVersionGateStatus> {
  if (!sessionId || !pluginDataDir) return { status: 'unknown' };

  const existing = readPluginVersionGate(sessionId, pluginDataDir);
  if (existing.status !== 'unknown') return existing;

  try {
    const window = await fetchWindow();
    if (!window) return { status: 'unknown' };
    if (!isPluginVersionSupported(PLUGIN_VERSION, window)) {
      const reason = unsupportedPluginVersionReason(PLUGIN_VERSION, window);
      markPluginVersionBlocked(sessionId, pluginDataDir, reason, ERROR_TYPE_PLUGIN_VERSION_UNSUPPORTED, window);
      debugLog(`pluginVersionGate: blocked — ${reason}`);
      return { status: 'blocked', reason, errorType: ERROR_TYPE_PLUGIN_VERSION_UNSUPPORTED };
    }
    markOk(sessionId, pluginDataDir, window);
    debugLog(
      `pluginVersionGate: ok — plugin=${PLUGIN_VERSION} window=${window.minimumSupportedVersion}..${window.currentVersion}`,
    );
    return { status: 'ok' };
  } catch (err: any) {
    debugLog(`pluginVersionGate: getVersion failed — continuing (${err?.message || String(err)})`);
    return { status: 'unknown' };
  }
}
