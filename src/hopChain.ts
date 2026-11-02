import * as fs from 'node:fs';
import * as path from 'node:path';
import { CedarHop } from './types';

// Tracks the delegation chain ("how did the current subject get here")
// across the many separate, stateless hook processes that make up one
// session (Kiro's hooks docs describe command actions as spawned per
// invocation, so state lives in a file-backed cache rather than an in-memory
// map). `hops` on an outbound request is the chain BEFORE this request's own
// action — empty for the very first invokeAgent of a turn, [invokeAgentHop]
// for the main session's tool calls that turn, [invokeAgentHop, spawnHop]
// for a subagent's calls, one more spawnHop per level of nesting, and so on.
//
// The tricky part: most hosts never reveal a newly spawned subagent's real
// id at the moment it's spawned — only that subagent's OWN first subsequent
// tool call carries it (hookInput.agent_id — UNCONFIRMED field name for
// Kiro, see mapping.ts/identity.ts). So a spawn's resulting lineage can't be
// written keyed by the child's id yet; it's queued (FIFO, since spawns and
// their first tool calls happen in order) and bound to the real id the
// first time that subagent is seen.
//
// Best-effort throughout, same as turnCache/spawnCounter: if the cache
// can't be read or written, callers just get an empty chain rather than
// failing the request.

interface HopChainState {
  agentHops: CedarHop[];
  pendingSubAgentLineages: CedarHop[][];
  boundLineages: Record<string, CedarHop[]>;
}

const EMPTY_STATE: HopChainState = { agentHops: [], pendingSubAgentLineages: [], boundLineages: {} };

// No fallback: only ever writes inside REVA_DATA_DIR — a plugin-owned env
// var (see src/config.ts), not a host-provided one. Kiro has no confirmed
// durable, host-blessed per-plugin data directory, so rather than inventing
// a host-sanctioned-looking fallback location, this plugin defines and
// documents its own directory and requires the user to point REVA_DATA_DIR
// at it. Without it, there is nothing honest to write to, so load/save just
// no-op — turn/hop/spawn tracking degrades gracefully to "nothing persists
// across hook calls" rather than failing.
function cacheDir(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'hops') : undefined;
}

function cacheFile(sessionId: string, pluginDataDir?: string): string | undefined {
  const dir = cacheDir(pluginDataDir);
  if (!dir) return undefined;
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safe}.json`);
}

function loadState(sessionId: string, pluginDataDir?: string): HopChainState {
  const file = cacheFile(sessionId, pluginDataDir);
  if (!file) return EMPTY_STATE;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as HopChainState;
  } catch {
    return EMPTY_STATE;
  }
}

function saveState(sessionId: string, state: HopChainState, pluginDataDir?: string): void {
  const dir = cacheDir(pluginDataDir);
  const file = cacheFile(sessionId, pluginDataDir);
  if (!dir || !file) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch {
    // best effort — subsequent requests just see an empty chain
  }
}

// Called once per turn, from PromptSubmit, right after the invokeAgent
// decision is evaluated. Resets the chain for this session: a new user
// turn starts its own fresh lineage rather than accumulating across the
// whole session, and any subagents from a previous turn no longer apply.
export function startTurnHops(sessionId: string, invokeAgentHop: CedarHop, pluginDataDir?: string): void {
  saveState(sessionId, { agentHops: [invokeAgentHop], pendingSubAgentLineages: [], boundLineages: {} }, pluginDataDir);
}

// The lineage for the main session's own tool calls this turn.
export function loadAgentHops(sessionId: string, pluginDataDir?: string): CedarHop[] {
  return loadState(sessionId, pluginDataDir).agentHops;
}

// Called from a spawn action's authorization: queues the lineage the new
// subagent should inherit (the spawner's own current lineage, plus this
// spawn) for the next unbound subagent id seen this session.
export function enqueuePendingSpawnLineage(
  sessionId: string,
  parentLineage: CedarHop[],
  spawnHop: CedarHop,
  pluginDataDir?: string,
): void {
  const state = loadState(sessionId, pluginDataDir);
  state.pendingSubAgentLineages.push([...parentLineage, spawnHop]);
  saveState(sessionId, state, pluginDataDir);
}

// Called for every subagent tool call. Returns the subagent's own bound
// lineage if already resolved; otherwise binds the oldest still-pending
// spawn lineage to this subagent id (first subagent tool call this session
// ⇒ first pending spawn, in order) and persists the binding for its later
// calls. Returns [] if there's nothing pending (shouldn't normally happen —
// a subagent's own calls always follow its spawn — but keeps this from
// crashing if it does).
export function resolveSubAgentLineage(sessionId: string, subAgentId: string, pluginDataDir?: string): CedarHop[] {
  const state = loadState(sessionId, pluginDataDir);
  const existing = state.boundLineages[subAgentId];
  if (existing) return existing;

  const lineage = state.pendingSubAgentLineages.shift();
  if (!lineage) return [];

  state.boundLineages[subAgentId] = lineage;
  saveState(sessionId, state, pluginDataDir);
  return lineage;
}
