import * as fs from 'node:fs';
import * as path from 'node:path';
import { debugLog } from './debug';

// A per-SESSION "stop calling the PDP, just allow" latch, opened after a 401
// and checked at the top of evaluate() before any network call. Once a
// session sees a 401 it is written off for that session: every later call in
// it short-circuits, and nothing re-checks. A NEW session always starts
// clean and makes a real PDP call, however many times an earlier session
// failed.
//
// State files live under REVA_DATA_DIR.
//
// 401 is the only status that opens this (see pdpClient.ts). Everything else
// operational — 403/404/424/429/5xx, transport failures, timeouts — already
// fails CLOSED on every call, so there is no "keep allowing" window to bound.

interface CircuitBreakerState {
  openedAt: number;
  triggeredStatus: number;
  errorType?: string;
}

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function cacheDir(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'pdp-circuit-breaker') : undefined;
}

function cacheFile(sessionId: string, pluginDataDir?: string): string | undefined {
  const dir = cacheDir(pluginDataDir);
  if (!dir || !sessionId) return undefined;
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safe}.json`);
}

export interface CircuitBreakerStatus {
  open: boolean;
  openedAt?: number;
  triggeredStatus?: number;
  errorType?: string;
}

export function isCircuitOpen(sessionId: string, pluginDataDir?: string): CircuitBreakerStatus {
  const file = cacheFile(sessionId, pluginDataDir);
  if (!file) return { open: false };
  try {
    const state: CircuitBreakerState = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      open: true,
      openedAt: state.openedAt,
      triggeredStatus: state.triggeredStatus,
      errorType: state.errorType,
    };
  } catch {
    return { open: false };
  }
}

export function openCircuit(
  sessionId: string,
  triggeredStatus: number,
  errorType: string | undefined,
  pluginDataDir?: string,
): void {
  const dir = cacheDir(pluginDataDir);
  const file = cacheFile(sessionId, pluginDataDir);
  if (!dir || !file) return;
  const state: CircuitBreakerState = { openedAt: Date.now(), triggeredStatus, errorType };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
    sweepStale(dir);
  } catch (err: any) {
    debugLog(
      `openCircuit: could not persist the latch for this session — every later call will re-hit the PDP (${err?.message || String(err)})`,
    );
  }
}

function sweepStale(dir: string): void {
  try {
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      } catch {
        // another process got there first
      }
    }
  } catch {
    // directory unreadable — the latch above still landed
  }
}
