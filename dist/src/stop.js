"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assistantOutput_1 = require("./assistantOutput");
const config_1 = require("./config");
const debug_1 = require("./debug");
const host_1 = require("./host");
const kiroSettings_1 = require("./kiroSettings");
const pdpClient_1 = require("./pdpClient");
const stdin_1 = require("./stdin");
const turnCache_1 = require("./turnCache");
// Stop (IDE) / stop (kiro-cli) fires when Kiro finishes a reply, which is the
// natural close of one prompt trace: every evaluation already recorded its
// part of the trace, and summarize asks Reva to write the trace summary from
// them. The assistant's final reply, when the host provides it, rides along
// as `output`.
//
// Best-effort and silent. It must exit 0 and print nothing on every path: a
// kiro-cli V3 Stop hook that exits 1 or prints a block decision makes Kiro
// carry on for another turn, and a failed summarize must never do that.
async function main() {
    (0, kiroSettings_1.applyKiroCliEnv)();
    const raw = await (0, stdin_1.readStdin)();
    (0, debug_1.debugLog)(`raw Stop stdin: ${raw}`);
    const input = (0, host_1.normalizeInput)(JSON.parse(raw || '{}'), 'Stop');
    (0, kiroSettings_1.applyKiroCliEnv)(process.env, { cwd: input.cwd });
    (0, debug_1.debugLog)(`host=${(0, host_1.hostLabel)(input.host)} event=${input.event}`);
    try {
        if (!input.sessionId) {
            (0, debug_1.debugLog)('stop: skip summarize — no session id');
            process.exit(0);
        }
        const cfg = (0, config_1.loadConfig)();
        const pluginDataDir = (0, config_1.resolveDataDir)();
        const turn = (0, turnCache_1.loadTurn)(input.sessionId, pluginDataDir);
        if (!turn) {
            (0, debug_1.debugLog)('stop: skip summarize — no turn cache entry');
            process.exit(0);
        }
        const output = (0, assistantOutput_1.truncateAssistantOutput)(input.assistantResponse);
        if (!output)
            (0, debug_1.debugLog)('stop: no assistant output available for summarize');
        const traceId = (0, turnCache_1.resolveTurnTraceId)(input.sessionId, turn);
        const result = await (0, pdpClient_1.summarizeTrace)(cfg, {
            trace_id: traceId,
            thread_id: input.sessionId,
            ...(output ? { output } : {}),
        });
        if (result.ok) {
            (0, debug_1.debugLog)(`stop: summarize accepted for trace_id=${traceId} output_bytes=${Buffer.byteLength(output, 'utf8')}`);
        }
        else {
            (0, debug_1.debugLog)(`stop: summarize failed status=${result.status ?? 'n/a'} reason=${result.reason || 'unknown'}`);
        }
    }
    catch (err) {
        (0, debug_1.debugLog)(`stop: unexpected error — continuing (${err?.message || String(err)})`);
    }
    process.exit(0);
}
main().catch(() => process.exit(0));
