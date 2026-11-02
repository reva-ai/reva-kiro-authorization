// Manages tracking of active sessions on this machine.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCircuitOpen } from './pdpCircuitBreaker';

// Tracks which session_ids are currently active on THIS machine, keyed by
// Agent id. SessionStart/PromptSubmit/PreToolUse register or refresh;
// Stop removes immediately. TTL is the fallback when Stop never fires.
// Sessions latched by a 401 circuit breaker are excluded from the count —
// they are no longer governed.

interface SessionEntry {
  entrypoint: string;
  lastSeen: number;
}

interface ActiveSessionsState {
  sessions: Record<string, SessionEntry>;
}

const ACTIVE_TTL_MS = 10 * 60 * 1000;

function cacheDir(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'active-sessions') : undefined;
}

function cacheFile(agentId: string, pluginDataDir?: string): string | undefined {
  const dir = cacheDir(pluginDataDir);
  if (!dir) return undefined;
  const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safe}.json`);
}

function loadState(agentId: string, pluginDataDir?: string): ActiveSessionsState {
  const file = cacheFile(agentId, pluginDataDir);
  if (!file) return { sessions: {} };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { sessions: parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {} };
  } catch {
    return { sessions: {} };
  }
}

function saveState(agentId: string, state: ActiveSessionsState, pluginDataDir?: string): void {
  const dir = cacheDir(pluginDataDir);
  const file = cacheFile(agentId, pluginDataDir);
  if (!dir || !file) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch {
    // best effort
  }
}

function pruneInactive(state: ActiveSessionsState, pluginDataDir?: string): ActiveSessionsState {
  const now = Date.now();
  const sessions: Record<string, SessionEntry> = {};
  for (const [sessionId, entry] of Object.entries(state.sessions)) {
    if (now - entry.lastSeen < ACTIVE_TTL_MS && !isCircuitOpen(sessionId, pluginDataDir).open) {
      sessions[sessionId] = entry;
    }
  }
  return { sessions };
}

export interface ActiveSession {
  sessionId: string;
  entrypoint: string;
  lastSeen: number;
}

export function markSessionActive(
  agentId: string,
  sessionId: string,
  entrypoint: string,
  pluginDataDir?: string,
): ActiveSession | undefined {
  if (!sessionId || isCircuitOpen(sessionId, pluginDataDir).open) return undefined;
  const state = pruneInactive(loadState(agentId, pluginDataDir), pluginDataDir);
  const entry: SessionEntry = { entrypoint, lastSeen: Date.now() };
  state.sessions[sessionId] = entry;
  saveState(agentId, state, pluginDataDir);
  return { sessionId, ...entry };
}

export function getActiveSessions(agentId: string, pluginDataDir?: string): ActiveSession[] {
  const state = pruneInactive(loadState(agentId, pluginDataDir), pluginDataDir);
  return Object.entries(state.sessions).map(([sessionId, entry]) => ({ sessionId, ...entry }));
}

export function getActiveSessionCount(agentId: string, pluginDataDir?: string): number {
  return getActiveSessions(agentId, pluginDataDir).length;
}

export function getSessionEntry(agentId: string, sessionId: string, pluginDataDir?: string): ActiveSession | undefined {
  return getActiveSessions(agentId, pluginDataDir).find((s) => s.sessionId === sessionId);
}

// Explicit removal from Stop (sessionEnd.ts). TTL above stays as the fallback
// when Stop never fires (killed process, closed terminal).
export function markSessionInactive(agentId: string, sessionId: string, pluginDataDir?: string): void {
  if (!sessionId) return;
  const state = pruneInactive(loadState(agentId, pluginDataDir), pluginDataDir);
  if (sessionId in state.sessions) {
    delete state.sessions[sessionId];
    saveState(agentId, state, pluginDataDir);
  }
}
