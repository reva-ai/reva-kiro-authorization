import * as fs from 'node:fs';
import * as path from 'node:path';
import { deriveTraceId, mintTraceId } from './trace';
import { DirectEvalSession } from './types';

// Each hook invocation is a separate stateless process, so there's no
// in-memory way to share state between them. This cache is how they agree on
// which turn they are in.
//
// It never stores the user's prompt text: the prompt goes to Reva (see
// authorizePrompt.ts) and nothing on this machine keeps a copy.
//
// Used to pin the TRACE id for an entire turn: rather than trusting a
// host-supplied id to reliably distinguish turns in every mode, PromptSubmit
// mints its own fresh id here and every PreToolUse call in that turn reads
// the same value back — the plugin owns the turn boundary itself instead of
// relying on an upstream field it doesn't fully control. Span ids are no
// longer stored: they are derived per operation from this trace id (see
// trace.ts).
//
// Best-effort throughout: if the cache can't be written or read, actions
// just proceed without turn-scoped context rather than failing.

export interface TurnCacheEntry {
  // W3C trace id for THIS turn — one user prompt. Minted here and read back
  // by every hook in the turn, so a prompt that fans out into many tool
  // calls keeps a single trace across all of them. The next prompt mints a
  // new one. Optional only because entries written before this field
  // existed will not have it; see resolveTurnTraceId for that fallback.
  traceId?: string;
  promptTimestamp: string;
  turn: number;
  startedAt: string;
}

// No fallback: only ever writes inside REVA_DATA_DIR — a plugin-owned env
// var (see src/config.ts and deviceId.ts's resolveDataDir for why this isn't
// a Kiro-provided path). Without it, there is nothing honest to write to.
function cacheDir(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'turns') : undefined;
}

function cacheFile(sessionId: string, pluginDataDir?: string): string | undefined {
  const dir = cacheDir(pluginDataDir);
  if (!dir) return undefined;
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safe}.json`);
}

// Call once per turn, from PromptSubmit. Mints a fresh trace id and
// persists it (overwriting any previous turn's entry for this session) so
// this turn's PreToolUse calls can read it back. Returns the full turn entry.
function saveTurn(sessionId: string, entry: TurnCacheEntry, pluginDataDir?: string): void {
  const dir = cacheDir(pluginDataDir);
  const file = cacheFile(sessionId, pluginDataDir);
  if (!dir || !file) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
  } catch {
    // best effort — later hooks can reconstruct metadata from what they see
  }
}

export function startTurn(sessionId: string, pluginDataDir?: string): TurnCacheEntry {
  const previous = loadTurn(sessionId, pluginDataDir);
  const observedAt = new Date().toISOString();
  const turn = (previous?.turn || 0) + 1;
  // A minted trace id only works if it can be PERSISTED — every later hook in
  // this turn is a separate process and reads it back from the cache. With no
  // pluginDataDir there is nowhere to write it, so minting would hand each
  // process a different random id and the turn would fragment into one trace
  // per PDP call. Derive deterministically in that case instead: every
  // process computes the same value from (session, turn) with no shared
  // state, which is the same guarantee the cache would have provided.
  const traceId = cacheFile(sessionId, pluginDataDir) ? mintTraceId() : deriveTraceId(sessionId, turn);
  const entry: TurnCacheEntry = {
    traceId,
    promptTimestamp: observedAt,
    turn,
    startedAt: previous?.startedAt || observedAt,
  };
  saveTurn(sessionId, entry, pluginDataDir);
  return entry;
}

export function loadTurn(sessionId: string, pluginDataDir?: string): TurnCacheEntry | undefined {
  const file = cacheFile(sessionId, pluginDataDir);
  if (!file) return undefined;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as TurnCacheEntry;
  } catch {
    return undefined;
  }
}

// Pre/Post hooks normally follow PromptSubmit. If a host invokes them
// without that boundary, record the first event we genuinely observed rather
// than fabricating session metadata or sending an invalid direct-AI request.
// An entry written by an earlier version may still carry a `prompt` field; it
// is read past and never written back, because startTurn builds a fresh entry.
export function loadOrStartTurn(sessionId: string, pluginDataDir?: string): TurnCacheEntry {
  const existing = loadTurn(sessionId, pluginDataDir);
  if (existing?.turn && existing.startedAt && existing.promptTimestamp) return existing;
  return startTurn(sessionId, pluginDataDir);
}

// Reva only needs the session id on the evaluate body; the turn number and
// start time are local, and Reva tracks its own.
export function directSessionFromTurn(sessionId: string): DirectEvalSession {
  return { id: sessionId };
}

// The trace id every hook in this turn must agree on. Normally read straight
// from the cache entry PromptSubmit wrote. The fallback covers an entry
// written before traceId existed, or a turn whose cache write failed: it is
// derived from (session, turn number), so separate hook processes still
// compute the SAME value for the same turn without needing the cache.
export function resolveTurnTraceId(sessionId: string, turn: TurnCacheEntry): string {
  return turn.traceId || deriveTraceId(sessionId, turn.turn);
}
