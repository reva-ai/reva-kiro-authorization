import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { debugLog } from './debug';
import { RevaHost } from './types';

// Kicks off the best-effort ingestion pass exactly once per session, from
// whichever hook happens to observe the session first.
//
// WHY THIS EXISTS: ingestion used to run only from the `agentSpawn` /
// `SessionStart` hook. After kiro-cli auto-updated from 2.21.2 to 2.21.3,
// `agentSpawn` stopped firing — verified against a brand-new agent config,
// so it was neither caching nor a hook timeout, and `agentSpawn` is still a
// recognized trigger name inside the binary.
// The result was that nothing was ever registered in Reva's directory, and
// the failure was invisible: a session-start hook that never runs looks
// exactly like one that had nothing to do.
//
// Hanging the only ingestion path off a single trigger was the real
// mistake. `userPromptSubmit` fires on every turn of every session on both
// hosts, so claiming the session there removes the dependency entirely.
// `sessionStart` still claims it too, so whichever fires first wins and the
// other becomes a no-op.
//
// WHY A SEPARATE PROCESS, not an inline call: the two paths have opposite
// postures and must not share one.
// authorizePrompt is an ENFORCEMENT entrypoint — it fails closed, and its
// latency sits in front of a real user action. Ingestion is best-effort,
// must never block, and on a cold run takes several seconds (it shells out
// to `kiro-cli whoami`). Running it inline would put that stall in front of
// every first prompt, and an ingestion bug could deny a prompt. A detached
// child keeps the postures in genuinely separate processes.

function markerDir(pluginDataDir: string): string {
  return path.join(pluginDataDir, 'ingested');
}

// Per-SESSION, deliberately — not a "already ingested this account" flag.
// Ingestion must re-run its live GET every session so a record deleted on
// the Reva side is recreated by the next one. This marker only stops the same session from starting the
// pass twice; a new session id is a new file and a fresh run.
function markerFile(pluginDataDir: string, sessionId: string): string {
  return path.join(markerDir(pluginDataDir), `${sessionId}.json`);
}

// Atomically claims this session's ingestion. Returns true for exactly one
// caller per session; every later caller gets false.
//
// The atomicity matters: `userPromptSubmit` and `agentSpawn` can both fire
// for the same session, and on a multi-tool turn several hooks run
// concurrently as separate processes. `wx` fails if the file already
// exists, so the claim is decided by the filesystem rather than by a
// read-then-write race that would let two processes both think they won.
export function claimSessionIngestion(sessionId: string, pluginDataDir?: string): boolean {
  if (!sessionId) return false;
  // Without a data dir there is nowhere to record the claim. Returning
  // false is the safe answer: ingestion is best-effort and skipping it
  // costs one session's directory pre-registration, whereas returning true
  // would re-spawn the pass on every single prompt.
  if (!pluginDataDir) return false;

  try {
    fs.mkdirSync(markerDir(pluginDataDir), { recursive: true });
    fs.writeFileSync(markerFile(pluginDataDir, sessionId), JSON.stringify({ claimedAt: Date.now() }), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return true;
  } catch {
    // EEXIST (someone else claimed it) or an unwritable directory — both
    // mean "don't start a pass", and neither is worth logging on every turn.
    return false;
  }
}

// Launches sessionStart.js as a detached child that outlives this hook.
//
// stdin is a PIPE, not 'ignore', and is written with a real payload. That
// is not incidental: sessionStart.js begins with `JSON.parse(await
// readStdin())`, so a child with stdin at /dev/null reads an empty string,
// throws on parse, and exits having done nothing — which is exactly how
// the first version of this failed, silently, while still logging that it
// had "spawned" the pass.
//
// stdout and stderr stay 'ignore' for the reason `detached` exists at all:
// a child sharing this process's stdout would write into Kiro's decision
// channel (the same hazard that made runKiroMcpList pin its stdio).
// unref() lets this hook exit immediately, however long ingestion takes.
export function spawnSessionIngestion(
  sessionId: string,
  cwd: string,
  entrypointDir: string,
  host: RevaHost = 'kiro-cli',
): void {
  const script = path.join(entrypointDir, 'sessionStart.js');
  try {
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      // Inherits REVA_* config, and carries the session id the way
      // kiro-cli itself does so host.ts resolves it identically.
      // REVA_INGESTION_SPAWNED tells the child that the claim was already
      // made on its behalf — without it the child would re-check, find the
      // marker this process just wrote, and exit having done nothing.
      env: { ...process.env, KIRO_SESSION_ID: sessionId, REVA_INGESTION_SPAWNED: '1' },
      windowsHide: true,
    });
    // The same shape kiro-cli's own agentSpawn hook delivers, so the child
    // takes the identical code path rather than a special-cased one.
    // In the PARENT host's own shape, so the child detects the same host
    // (src/host.ts reads it from the trigger name). An earlier version always
    // sent kiro-cli's `agentSpawn`, so a Kiro IDE session's pass ran as
    // kiro-cli and briefly recorded the session's entrypoint as `cli`.
    child.stdin?.end(
      JSON.stringify(
        host === 'kiro-ide'
          ? { hook_event_name: 'SessionStart', session_id: sessionId, cwd }
          : { hook_event_name: 'agentSpawn', cwd },
      ),
    );
    child.unref();
    debugLog(`ingestion: spawned a detached session-start pass for ${sessionId}`);
  } catch (err: any) {
    // Best-effort by definition — a session that cannot pre-register its
    // entities still evaluates normally.
    debugLog(`ingestion: could not spawn the session-start pass — ${err?.message || String(err)}`);
  }
}

// The one call an enforcement entrypoint makes. Claims the session and, if
// it won, launches the pass. Never throws: an ingestion problem must not be
// able to affect the decision this hook is really here to make. Returns
// whether THIS call started the pass (the prompt hook then skips its own
// MCP recheck, which the pass already covers).
export function ensureSessionIngested(
  sessionId: string,
  cwd: string,
  pluginDataDir?: string,
  host: RevaHost = 'kiro-cli',
): boolean {
  try {
    if (!claimSessionIngestion(sessionId, pluginDataDir)) return false;
    spawnSessionIngestion(sessionId, cwd, __dirname, host);
    return true;
  } catch (err: any) {
    debugLog(`ingestion: claim failed — ${err?.message || String(err)}`);
    return false;
  }
}
