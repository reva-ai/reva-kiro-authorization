import { truncateAssistantOutput } from './assistantOutput';
import { loadConfig, resolveDataDir } from './config';
import { debugLog } from './debug';
import { hostLabel, normalizeInput } from './host';
import { applyKiroCliEnv } from './kiroSettings';
import { summarizeTrace } from './pdpClient';
import { readStdin } from './stdin';
import { loadTurn, resolveTurnTraceId } from './turnCache';

// Stop (IDE) / stop (kiro-cli) fires when Kiro finishes a reply, which is the
// natural close of one prompt trace: every evaluation already recorded its
// part of the trace, and summarize asks Reva to write the trace summary from
// them. The assistant's final reply, when the host provides it, rides along
// as `output`.
//
// Best-effort and silent. It must exit 0 and print nothing on every path: a
// kiro-cli V3 Stop hook that exits 1 or prints a block decision makes Kiro
// carry on for another turn, and a failed summarize must never do that.

async function main(): Promise<void> {
  applyKiroCliEnv();
  const raw = await readStdin();
  debugLog(`raw Stop stdin: ${raw}`);
  const input = normalizeInput(JSON.parse(raw || '{}'), 'Stop');
  applyKiroCliEnv(process.env, { cwd: input.cwd });
  debugLog(`host=${hostLabel(input.host)} event=${input.event}`);

  try {
    if (!input.sessionId) {
      debugLog('stop: skip summarize — no session id');
      process.exit(0);
    }
    const cfg = loadConfig();
    const pluginDataDir = resolveDataDir();
    const turn = loadTurn(input.sessionId, pluginDataDir);
    if (!turn) {
      debugLog('stop: skip summarize — no turn cache entry');
      process.exit(0);
    }

    const output = truncateAssistantOutput(input.assistantResponse);
    if (!output) debugLog('stop: no assistant output available for summarize');

    const traceId = resolveTurnTraceId(input.sessionId, turn);
    const result = await summarizeTrace(cfg, {
      trace_id: traceId,
      thread_id: input.sessionId,
      ...(output ? { output } : {}),
    });
    if (result.ok) {
      debugLog(`stop: summarize accepted for trace_id=${traceId} output_bytes=${Buffer.byteLength(output, 'utf8')}`);
    } else {
      debugLog(`stop: summarize failed status=${result.status ?? 'n/a'} reason=${result.reason || 'unknown'}`);
    }
  } catch (err: any) {
    debugLog(`stop: unexpected error — continuing (${err?.message || String(err)})`);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
