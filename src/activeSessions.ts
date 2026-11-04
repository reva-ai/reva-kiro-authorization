// Manages tracking of active sessions on this machine.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCircuitOpen } from './pdpCircuitBreaker';

// Tracks which session_ids are currently active on THIS machine, keyed by
// Agent id. SessionStart/PromptSubmit/PreToolUse register or refresh;
// Stop removes immediately. TTL is the fallback when Stop never fires.
// Sessions latched by a 401 circuit breaker are excluded from the count —
// they are no longer governed.
//
// A kiro-cli session also carries the id of its own kiro-cli process (found
// by surface.ts at session start) and stops counting as soon as that process
// has exited — Kiro sends no hook when a session closes (SessionEnd never
// fired when a kiro-cli V3 session closed, in testing), so without this a closed session
// stayed counted for the full TTL. A Kiro desktop chat has no process of its
// own and still relies on the TTL.

interface SessionEntry {
  entrypoint: string;
  lastSeen: number;
  pid?: number;
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

// Signal 0 tests for existence without touching the process. EPERM means it
// exists but belongs to someone else, so it still counts as running. A reused
// id can only keep a closed session counted until the TTL — never drop an
// open one.
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

function pruneInactive(state: ActiveSessionsState, pluginDataDir?: string): ActiveSessionsState {
  const now = Date.now();
  const sessions: Record<string, SessionEntry> = {};
  for (const [sessionId, entry] of Object.entries(state.sessions)) {
    if (entry.pid && !isProcessRunning(entry.pid)) continue;
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
  pid?: number;
}

export function markSessionActive(
  agentId: string,
  sessionId: string,
  entrypoint: string,
  pluginDataDir?: string,
  pid?: number,
): ActiveSession | undefined {
  if (!sessionId || isCircuitOpen(sessionId, pluginDataDir).open) return undefined;
  const state = pruneInactive(loadState(agentId, pluginDataDir), pluginDataDir);
  // Only the hook that looked the process up passes a pid; every later hook
  // of the session keeps the one already stored.
  const keptPid = pid ?? state.sessions[sessionId]?.pid;
  const entry: SessionEntry = { entrypoint, lastSeen: Date.now(), ...(keptPid ? { pid: keptPid } : {}) };
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

// End of a reply (Stop, see sessionEnd.ts): the session is still open, now
// idle at its prompt, so only its lastSeen moves. Never adds a session — the
// prompt and tool hooks register it with its entrypoint — and never removes
// one: closing is left to the TTL above.
export function touchSession(agentId: string, sessionId: string, pluginDataDir?: string): boolean {
  if (!sessionId) return false;
  const state = pruneInactive(loadState(agentId, pluginDataDir), pluginDataDir);
  const entry = state.sessions[sessionId];
  if (!entry) return false;
  entry.lastSeen = Date.now();
  saveState(agentId, state, pluginDataDir);
  return true;
}

// Explicit removal on SessionEnd (sessionEnd.ts) — the session is closing.
// Never on Stop: Kiro fires Stop at the end of every reply, and removing the
// session there dropped open, idle sessions from activeSessionCount (a
// ">= 3 sessions" policy never saw more than 2). The TTL above covers a
// session that is killed without running any hook.
export function markSessionInactive(agentId: string, sessionId: string, pluginDataDir?: string): void {
  if (!sessionId) return;
  const state = pruneInactive(loadState(agentId, pluginDataDir), pluginDataDir);
  if (sessionId in state.sessions) {
    delete state.sessions[sessionId];
    saveState(agentId, state, pluginDataDir);
  }
}
