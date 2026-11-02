import { markSessionInactive } from './activeSessions';
import { resolveDataDir } from './config';
import { debugLog } from './debug';
import { resolveAgentId } from './deviceId';
import { applyKiroCliEnv } from './kiroSettings';
import { describeModel, resolveSessionModelWithSource } from './kiroSession';
import { hostLabel, normalizeInput } from './host';
import { readStdin } from './stdin';

// Wired to Kiro IDE `Stop` / kiro-cli `stop`, the closest thing to an
// end-of-session hook. No blocking/decision control: pure local cleanup,
// dropping this session from the active-sessions registry rather than
// waiting out that file's 10-minute TTL. Not guaranteed on abrupt kill —
// TTL stays as the fallback. No PDP call: nothing here is worth a network
// round-trip against the host's shared Stop budget.

async function main(): Promise<void> {
  applyKiroCliEnv();
  const raw = await readStdin();
  debugLog(`raw Stop stdin: ${raw}`);
  const input = normalizeInput(JSON.parse(raw || '{}'), 'Stop');
  applyKiroCliEnv(process.env, { cwd: input.cwd });
  debugLog(`host=${hostLabel(input.host)}`);
  const pluginDataDir = resolveDataDir();

  // By the end of a turn Kiro has written the model into its session record,
  // so this line names the model that actually answered — even for a turn
  // whose prompt check ran before Kiro recorded it. Local log only.
  try {
    const resolved = resolveSessionModelWithSource(input.sessionId, process.env, undefined, pluginDataDir);
    debugLog(`turn finished — session=${input.sessionId} model=${describeModel(resolved)}`);
  } catch {
    // best effort
  }

  const agentId = process.env.REVA_AGENT_ID || resolveAgentId();
  if (!agentId) {
    debugLog('sessionEnd: skipped — no Kiro account logged in and REVA_AGENT_ID not set');
  } else if (!input.sessionId) {
    debugLog('sessionEnd: skipped — no session id');
  } else {
    try {
      markSessionInactive(agentId, input.sessionId, pluginDataDir);
      debugLog(`sessionEnd: marked inactive session=${input.sessionId}`);
    } catch (err: any) {
      debugLog(`sessionEnd: markSessionInactive failed — ${err?.message || String(err)}`);
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
