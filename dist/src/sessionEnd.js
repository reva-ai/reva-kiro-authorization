"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activeSessions_1 = require("./activeSessions");
const config_1 = require("./config");
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const kiroSettings_1 = require("./kiroSettings");
const kiroSession_1 = require("./kiroSession");
const host_1 = require("./host");
const stdin_1 = require("./stdin");
// Wired to Kiro IDE `Stop` / kiro-cli `stop`, the closest thing to an
// end-of-session hook. No blocking/decision control: pure local cleanup,
// dropping this session from the active-sessions registry rather than
// waiting out that file's 10-minute TTL. Not guaranteed on abrupt kill —
// TTL stays as the fallback. No PDP call: nothing here is worth a network
// round-trip against the host's shared Stop budget.
async function main() {
    (0, kiroSettings_1.applyKiroCliEnv)();
    const raw = await (0, stdin_1.readStdin)();
    (0, debug_1.debugLog)(`raw Stop stdin: ${raw}`);
    const input = (0, host_1.normalizeInput)(JSON.parse(raw || '{}'), 'Stop');
    (0, kiroSettings_1.applyKiroCliEnv)(process.env, { cwd: input.cwd });
    (0, debug_1.debugLog)(`host=${(0, host_1.hostLabel)(input.host)}`);
    const pluginDataDir = (0, config_1.resolveDataDir)();
    // By the end of a turn Kiro has written the model into its session record,
    // so this line names the model that actually answered — even for a turn
    // whose prompt check ran before Kiro recorded it. Local log only.
    try {
        const resolved = (0, kiroSession_1.resolveSessionModelWithSource)(input.sessionId, process.env, undefined, pluginDataDir);
        (0, debug_1.debugLog)(`turn finished — session=${input.sessionId} model=${(0, kiroSession_1.describeModel)(resolved)}`);
    }
    catch {
        // best effort
    }
    const agentId = process.env.REVA_AGENT_ID || (0, deviceId_1.resolveAgentId)();
    if (!agentId) {
        (0, debug_1.debugLog)('sessionEnd: skipped — no Kiro account logged in and REVA_AGENT_ID not set');
    }
    else if (!input.sessionId) {
        (0, debug_1.debugLog)('sessionEnd: skipped — no session id');
    }
    else {
        try {
            (0, activeSessions_1.markSessionInactive)(agentId, input.sessionId, pluginDataDir);
            (0, debug_1.debugLog)(`sessionEnd: marked inactive session=${input.sessionId}`);
        }
        catch (err) {
            (0, debug_1.debugLog)(`sessionEnd: markSessionInactive failed — ${err?.message || String(err)}`);
        }
    }
    process.exit(0);
}
main().catch(() => process.exit(0));
