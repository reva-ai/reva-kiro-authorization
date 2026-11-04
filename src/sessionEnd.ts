import { markSessionInactive, touchSession } from './activeSessions';
import { resolveDataDir } from './config';
import { debugLog } from './debug';
import { resolveAgentId } from './deviceId';
import { applyKiroCliEnv } from './kiroSettings';
import { describeModel, resolveSessionModelWithSource } from './kiroSession';
import { hostLabel, normalizeInput } from './host';
import { readStdin } from './stdin';

// Wired to `SessionEnd` (install-hooks.mjs), which the Kiro desktop app and
// kiro-cli V3 define for a session being torn down: the session is removed
// from the active-sessions registry. Kiro does not reliably fire it, so this
// is not what normally ends a session's count — a kiro-cli session stops
// counting once its own kiro-cli process exits, and anything else after the
// registry's 10-minute idle TTL (see activeSessions.ts).
//
// Earlier versions were wired to `Stop`, which Kiro fires after every reply,
// not when a session closes — so removing the session there dropped open,
// idle sessions from the count. A `Stop` still arriving from such an install
// (until the installer is re-run) only refreshes the session.
//
// No blocking/decision control and no PDP call. Kiro gives SessionEnd hooks
// 5 seconds in total, so the removal runs before anything optional.

async function main(): Promise<void> {
  applyKiroCliEnv();
  const raw = await readStdin();
  debugLog(`raw SessionEnd/Stop stdin: ${raw}`);
  const input = normalizeInput(JSON.parse(raw || '{}'), 'SessionEnd');
  applyKiroCliEnv(process.env, { cwd: input.cwd });
  debugLog(`host=${hostLabel(input.host)} event=${input.event}`);
  const pluginDataDir = resolveDataDir();
  const closing = input.event === 'SessionEnd';

  const agentId = process.env.REVA_AGENT_ID || resolveAgentId();
  if (!agentId) {
    debugLog('sessionEnd: skipped — no Kiro account logged in and REVA_AGENT_ID not set');
  } else if (!input.sessionId) {
    debugLog('sessionEnd: skipped — no session id');
  } else if (closing) {
    try {
      markSessionInactive(agentId, input.sessionId, pluginDataDir);
      debugLog(`sessionEnd: session closed, removed from active sessions session=${input.sessionId}`);
    } catch (err: any) {
      debugLog(`sessionEnd: markSessionInactive failed — ${err?.message || String(err)}`);
    }
  } else {
    try {
      const known = touchSession(agentId, input.sessionId, pluginDataDir);
      debugLog(`sessionEnd: reply finished, session stays active session=${input.sessionId}${known ? '' : ' (not tracked)'}`);
    } catch (err: any) {
      debugLog(`sessionEnd: touchSession failed — ${err?.message || String(err)}`);
    }
  }

  // After a reply, Kiro has written the model into its session record, so
  // this names the model that actually answered. Local log only.
  if (!closing) {
    try {
      const resolved = resolveSessionModelWithSource(input.sessionId, process.env, undefined, pluginDataDir);
      debugLog(`turn finished — session=${input.sessionId} model=${describeModel(resolved)}`);
    } catch {
      // best effort
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
