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
async function main() {
    (0, kiroSettings_1.applyKiroCliEnv)();
    const raw = await (0, stdin_1.readStdin)();
    (0, debug_1.debugLog)(`raw SessionEnd/Stop stdin: ${raw}`);
    const input = (0, host_1.normalizeInput)(JSON.parse(raw || '{}'), 'SessionEnd');
    (0, kiroSettings_1.applyKiroCliEnv)(process.env, { cwd: input.cwd });
    (0, debug_1.debugLog)(`host=${(0, host_1.hostLabel)(input.host)} event=${input.event}`);
    const pluginDataDir = (0, config_1.resolveDataDir)();
    const closing = input.event === 'SessionEnd';
    const agentId = process.env.REVA_AGENT_ID || (0, deviceId_1.resolveAgentId)();
    if (!agentId) {
        (0, debug_1.debugLog)('sessionEnd: skipped — no Kiro account logged in and REVA_AGENT_ID not set');
    }
    else if (!input.sessionId) {
        (0, debug_1.debugLog)('sessionEnd: skipped — no session id');
    }
    else if (closing) {
        try {
            (0, activeSessions_1.markSessionInactive)(agentId, input.sessionId, pluginDataDir);
            (0, debug_1.debugLog)(`sessionEnd: session closed, removed from active sessions session=${input.sessionId}`);
        }
        catch (err) {
            (0, debug_1.debugLog)(`sessionEnd: markSessionInactive failed — ${err?.message || String(err)}`);
        }
    }
    else {
        try {
            const known = (0, activeSessions_1.touchSession)(agentId, input.sessionId, pluginDataDir);
            (0, debug_1.debugLog)(`sessionEnd: reply finished, session stays active session=${input.sessionId}${known ? '' : ' (not tracked)'}`);
        }
        catch (err) {
            (0, debug_1.debugLog)(`sessionEnd: touchSession failed — ${err?.message || String(err)}`);
        }
    }
    // After a reply, Kiro has written the model into its session record, so
    // this names the model that actually answered. Local log only.
    if (!closing) {
        try {
            const resolved = (0, kiroSession_1.resolveSessionModelWithSource)(input.sessionId, process.env, undefined, pluginDataDir);
            (0, debug_1.debugLog)(`turn finished — session=${input.sessionId} model=${(0, kiroSession_1.describeModel)(resolved)}`);
        }
        catch {
            // best effort
        }
    }
    process.exit(0);
}
main().catch(() => process.exit(0));
