"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const os = __importStar(require("node:os"));
const activeSessions_1 = require("./activeSessions");
const config_1 = require("./config");
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const kiroSettings_1 = require("./kiroSettings");
const hopChain_1 = require("./hopChain");
const identity_1 = require("./identity");
const invokeAgent_1 = require("./invokeAgent");
const pdpClient_1 = require("./pdpClient");
const spawnCounter_1 = require("./spawnCounter");
const subAgentPrompts_1 = require("./subAgentPrompts");
const kiroSession_1 = require("./kiroSession");
const sessionIngestion_1 = require("./sessionIngestion");
const mcpIngestionTrigger_1 = require("./mcpIngestionTrigger");
const stdin_1 = require("./stdin");
const trace_1 = require("./trace");
const host_1 = require("./host");
const host_2 = require("./host");
const turnCache_1 = require("./turnCache");
// UserPromptSubmit (IDE) / userPromptSubmit (kiro-cli) — the top-level
// "a human handed the agent an instruction" gate, evaluated as invokeAgent.
//
// Deny is exit 2 + reason on stderr on both hosts (host.ts emits it). The
// IDE honors that; kiro-cli documents it but does not honor it yet, so
// there this is audit-only — blocksAt() reports which, and it is logged
// rather than assumed. There is no structured "ask" at this trigger on
// either host, so host.ts surfaces an ask as plain context text at exit 0,
// which both hosts do inject into the agent's context.
let host = 'kiro-ide';
function writeDecision(result) {
    return (0, host_1.emitDecision)(host, 'UserPromptSubmit', result);
}
async function main() {
    // Fill REVA_* gaps from ~/.kiro/settings/cli.json before anything reads
    // process.env (including debug.ts). process.env still wins when set.
    (0, kiroSettings_1.applyKiroCliEnv)();
    const raw = await (0, stdin_1.readStdin)();
    // Logged before JSON.parse, deliberately: a payload that fails to parse,
    // or one a host reshaped without warning, is exactly the failure this
    // needs to surface. Written to REVA_DEBUG_LOG_FILE when set, never to
    // stderr alongside a deny reason (see debug.ts).
    (0, debug_1.debugLog)(`raw UserPromptSubmit stdin: ${raw}`);
    const input = (0, host_2.normalizeInput)(JSON.parse(raw), 'UserPromptSubmit');
    host = input.host;
    // Workspace cli.json (if any) can override global now that cwd is known.
    (0, kiroSettings_1.applyKiroCliEnv)(process.env, { cwd: input.cwd });
    (0, debug_1.debugLog)(`host=${(0, host_1.hostLabel)(host)} enforcing=${(0, host_1.blocksAt)(host, 'UserPromptSubmit')}`);
    const cfg = (0, config_1.loadConfig)();
    const pluginDataDir = (0, config_1.resolveDataDir)();
    const userEmail = (0, identity_1.resolveUserEmail)();
    const prompt = input.prompt ? (0, turnCache_1.truncatePrompt)(input.prompt) : '';
    // PromptSubmit fires every turn, unlike SessionStart (once per session) —
    // a good second place to keep this session's lastSeen fresh.
    const currentSession = (0, activeSessions_1.markSessionActive)(cfg.agentId, input.sessionId, (0, host_2.sessionEntrypoint)(input.host), pluginDataDir);
    const activeSessionCount = (0, activeSessions_1.getActiveSessionCount)(cfg.agentId, pluginDataDir);
    // Register User/Agent/MCPServer in Reva's directory, once per session.
    // Fires from HERE rather than only from session start because kiro-cli
    // 2.21.3 stopped firing `agentSpawn` — see sessionIngestion.ts. This
    // returns immediately: the work happens in a detached child process, so
    // nothing about it can delay or fail this prompt's decision.
    const ingestionStarted = (0, sessionIngestion_1.ensureSessionIngested)(input.sessionId, input.cwd, pluginDataDir, input.host);
    // Re-reads Kiro's mcp.json files at most every 15 minutes, so a server
    // added mid-session reaches "Linked MCP Servers" without waiting for the
    // next session (mcpIngestionTrigger.ts). Skipped on the prompt that just
    // started the session pass — that pass already covers MCP servers.
    // Contained for the same reason as authorize.ts's ingest-on-invoke: this
    // file's main() fails closed.
    try {
        if (!ingestionStarted)
            (0, mcpIngestionTrigger_1.triggerMcpDiscoveryIfDue)(cfg, input.cwd, pluginDataDir);
    }
    catch (err) {
        (0, debug_1.debugLog)(`authorizePrompt: MCP recheck skipped — ${err?.message || String(err)}`);
    }
    // A prompt event can be a SUB-AGENT starting rather than the user: the
    // Kiro IDE submits each invoke_sub_agent's instructions as a prompt of its
    // own, in this session. That is part of the current turn — it must not
    // reset the sub-agent count (the 4th sub-agent would come out as #1) or
    // start a new trace. Recognized by matching the text PreToolUse recorded
    // when the sub-agent was spawned (subAgentPrompts.ts).
    const isSubAgentPrompt = (0, subAgentPrompts_1.claimSubAgentPrompt)(input.sessionId, input.prompt, pluginDataDir);
    // Otherwise this plugin owns the turn boundary itself: mint a fresh TRACE
    // id here and persist it (with the prompt text) so every PreToolUse call
    // this turn produces — separate, stateless hook processes — reads the
    // same value back instead of each rolling its own. Spans are derived per
    // operation from that trace (see trace.ts).
    const turn = isSubAgentPrompt
        ? (0, turnCache_1.loadOrStartTurn)(input.sessionId, pluginDataDir)
        : (0, turnCache_1.startTurn)(input.sessionId, input.prompt, pluginDataDir);
    if (isSubAgentPrompt) {
        (0, debug_1.debugLog)('prompt is a sub-agent\'s instructions — same turn, sub-agent count and trace kept');
    }
    else {
        // A real new turn resets the subagent spawn counter — each turn's first
        // spawn is #1 again, not a continuation of every prior turn's count
        // (see spawnCounter.ts's own comment on why).
        (0, spawnCounter_1.resetSpawnCounter)(input.sessionId, pluginDataDir);
    }
    const traceId = (0, turnCache_1.resolveTurnTraceId)(input.sessionId, turn);
    const spanId = (0, trace_1.deriveSpanId)(traceId, 'user-prompt');
    const traceSession = (0, trace_1.buildSessionContext)(input.sessionId, spanId, traceId, input.promptId);
    const traceparent = (0, trace_1.traceparentHeader)(traceSession.traceId, traceSession.spanId);
    // Resolved once and logged: `model` comes from a file Kiro writes on its
    // own schedule, so "why is model missing from this decision" is a real
    // question the debug trail has to be able to answer.
    const resolvedModel = (0, kiroSession_1.resolveSessionModelWithSource)(input.sessionId, process.env, os.homedir(), pluginDataDir);
    const model = resolvedModel.model;
    (0, debug_1.debugLog)(`model=${(0, kiroSession_1.describeModel)(resolvedModel)} modelContext=${cfg.modelContext}`);
    const request = (0, invokeAgent_1.buildInvokeAgentRequest)(userEmail, cfg.agentId, prompt, (0, turnCache_1.directSessionFromTurn)(input.sessionId, turn), activeSessionCount, currentSession, model, cfg.modelContext, (0, deviceId_1.resolveMachineId)(pluginDataDir));
    (0, debug_1.debugLog)(`-> invokeAgent as ${userEmail} on Agent:${cfg.agentId} trace=${traceId}`);
    const result = await (0, pdpClient_1.evaluate)(cfg, request, traceparent, pluginDataDir, input.sessionId);
    (0, debug_1.debugLog)(`<- decision=${result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);
    // Record this invokeAgent as the base of this turn's hop chain regardless
    // of the decision, so a subsequent tool call (if the turn proceeds) has
    // it to build on — mirrors how the spawn counter also advances on every
    // attempt, not just approved ones.
    // A sub-agent's prompt keeps the turn's existing chain (which already
    // holds the user's invokeAgent and the spawns) instead of restarting it.
    const invokeAgentHop = {
        seq: 1,
        subject: request.subject,
        action: { name: 'invokeAgent' },
        resource: request.resource,
        time: new Date().toISOString(),
    };
    if (!isSubAgentPrompt)
        (0, hopChain_1.startTurnHops)(input.sessionId, invokeAgentHop, pluginDataDir);
    writeDecision(result);
}
main().catch((err) => {
    // Logged here specifically because this is the one failure path
    // writeDecision()'s own output never reaches you directly — Kiro consumes
    // the hook's stdout as its own decision contract, not a log you can read.
    // Without this, an internal failure (e.g. a real Kiro payload not
    // actually shaping up the way types.ts assumed) would look identical to
    // "the hook silently never ran at all" from the outside.
    (0, debug_1.debugLog)(`internal error — failing closed: ${err?.message || String(err)}`);
    writeDecision({
        decision: 'deny',
        reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
    });
});
