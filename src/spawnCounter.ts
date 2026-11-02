import * as fs from 'node:fs';
import * as path from 'node:path';

// Tracks how many subagents have been spawned so far *this turn*, so a
// Cedar policy can see "this is spawn #4" and enforce a per-turn cap (e.g.
// deny when subagentIndex > 5). Resets to 0 at the start of every new turn
// (see resetSpawnCounter, called from authorizePrompt.ts's startTurn) —
// deliberately NOT a running total for the whole session, since a cap meant
// to bound one turn's fan-out would otherwise keep tightening across a long
// session until every later turn's first spawn was already over the limit.
// Persisted per session_id since each hook invocation is a separate,
// stateless process — a simple read-increment-write on a small file, not
// safe against truly concurrent writers, but a session's own hooks are
// expected to run sequentially, so this is safe in practice.

// No fallback: only ever writes inside REVA_DATA_DIR — a plugin-owned env
// var (see src/config.ts and hopChain.ts's comment on why this isn't a
// Kiro-provided path). Without it, there is nothing honest to write to —
// nextSpawnIndex still returns a value (every call is index 1, since
// nothing persists), it just can't actually count across calls.
function cacheDir(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'spawns') : undefined;
}

function cacheFile(sessionId: string, pluginDataDir?: string): string | undefined {
  const dir = cacheDir(pluginDataDir);
  if (!dir) return undefined;
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safe}.count`);
}

export function nextSpawnIndex(sessionId: string, pluginDataDir?: string): number {
  return reserveSpawnIndices(sessionId, 1, pluginDataDir)[0];
}

// Claims `count` consecutive spawn numbers for this turn in ONE read and
// one write — for a single tool call that starts several sub-agents at once
// (kiro-cli's use_subagent with InvokeSubagents). Returns e.g. [3, 4, 5]
// when two spawns were already counted this turn. Claiming them together
// means the sub-agents of one call can never be handed the same number.
export function reserveSpawnIndices(sessionId: string, count: number, pluginDataDir?: string): number[] {
  const n = Math.max(0, Math.floor(count));
  const dir = cacheDir(pluginDataDir);
  const file = cacheFile(sessionId, pluginDataDir);
  if (!dir || !file) return Array.from({ length: n }, (_, i) => i + 1);

  let current = 0;
  try {
    current = Number(fs.readFileSync(file, 'utf8').trim()) || 0;
  } catch {
    current = 0;
  }
  if (n > 0) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, String(current + n), 'utf8');
    } catch {
      // best effort — if persistence fails, this call still gets values,
      // just not guaranteed to continue correctly on the next spawn
    }
  }
  return Array.from({ length: n }, (_, i) => current + i + 1);
}

// Called once per turn, from PromptSubmit (authorizePrompt.ts), right
// alongside startTurn() — so this turn's first spawn is #1 again, not a
// continuation of every prior turn's count.
export function resetSpawnCounter(sessionId: string, pluginDataDir?: string): void {
  const file = cacheFile(sessionId, pluginDataDir);
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    // already absent (first turn ever, or already reset) — nothing to do
  }
}
