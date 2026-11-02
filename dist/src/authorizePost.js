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
const context_1 = require("./context");
const config_1 = require("./config");
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const kiroSettings_1 = require("./kiroSettings");
const entity_1 = require("./entity");
const evaluateAll_1 = require("./evaluateAll");
const hopChain_1 = require("./hopChain");
const identity_1 = require("./identity");
const mapping_1 = require("./mapping");
const kiroSession_1 = require("./kiroSession");
const stdin_1 = require("./stdin");
const trace_1 = require("./trace");
const host_1 = require("./host");
const turnCache_1 = require("./turnCache");
// PostToolUse / postToolUse — audit only, on BOTH hosts.
//
// Kiro IDE: its dispatcher treats only PreToolUse/UserPromptSubmit/
// PreTaskExec as blockable, and runs no stdout parser for PostToolUse — so
// neither this hook's exit code nor its output reaches the agent.
// kiro-cli: same posture ("Tool already ran" in its own docs table).
//
// The value of running at all is that Reva's PDP still receives the call
// with the real tool RESULT attached, so a policy violation visible only in
// the output is still recorded server-side for audit. Nothing here can
// undo the action, and this file does not pretend otherwise: the decision
// is logged and the process exits 0 regardless.
let host = 'kiro-ide';
function writeDecision(result) {
    return (0, host_1.emitDecision)(host, 'PostToolUse', result);
}
async function main() {
    (0, kiroSettings_1.applyKiroCliEnv)();
    const raw = await (0, stdin_1.readStdin)();
    (0, debug_1.debugLog)(`raw PostToolUse stdin: ${raw}`);
    const input = (0, host_1.normalizeInput)(JSON.parse(raw), 'PostToolUse');
    host = input.host;
    (0, kiroSettings_1.applyKiroCliEnv)(process.env, { cwd: input.cwd });
    (0, debug_1.debugLog)(`host=${(0, host_1.hostLabel)(host)} (PostToolUse is audit-only on both hosts)`);
    const cfg = (0, config_1.loadConfig)();
    const pluginDataDir = (0, config_1.resolveDataDir)();
    // Read-only here, not a refresh — PreToolUse already marked this same
    // tool call's session active moments earlier in the same cycle.
    const activeSessionCount = (0, activeSessions_1.getActiveSessionCount)(cfg.agentId, pluginDataDir);
    const currentSession = (0, activeSessions_1.getSessionEntry)(cfg.agentId, input.sessionId, pluginDataDir);
    const agentCtx = (0, identity_1.resolveAgentContext)(cfg.agentId, input);
    const toolName = input.toolName || 'unknown-tool';
    const toolMapping = (0, mapping_1.mapToolCall)(toolName, input.toolInput, input.cwd);
    if (toolMapping.overCap) {
        // PreToolUse already denied this call; there is nothing bounded to audit.
        (0, debug_1.debugLog)(`post: ${toolName} touched ${toolMapping.candidateCount} paths, above the cap — not evaluated`);
        process.exit(0);
    }
    const mapping = toolMapping.mappings[0];
    const turn = (0, turnCache_1.loadOrStartTurn)(input.sessionId, pluginDataDir);
    const traceId = (0, turnCache_1.resolveTurnTraceId)(input.sessionId, turn);
    // Same per-resource span key PreToolUse used, so each resource's pre/post
    // pair meets on one span.
    const traceparentFor = (each) => (0, trace_1.traceparentHeader)(traceId, (0, trace_1.deriveSpanId)(traceId, (0, trace_1.toolSpanKey)(toolName, input.toolInput, each)));
    const userEmail = (0, identity_1.resolveUserEmail)();
    const userDescriptor = (0, entity_1.buildEntityDescriptor)('User', userEmail);
    const subjectDescriptor = agentCtx.isSubAgent
        ? (0, entity_1.buildEntityDescriptor)('SubAgent', `${agentCtx.agentId}:${agentCtx.subAgentId}`, {
            agentType: agentCtx.subAgentType || 'subagent',
        })
        : (0, entity_1.buildEntityDescriptor)('Agent', agentCtx.agentId);
    const hops = agentCtx.isSubAgent
        ? (0, hopChain_1.resolveSubAgentLineage)(input.sessionId, agentCtx.subAgentId, pluginDataDir)
        : (0, hopChain_1.loadAgentHops)(input.sessionId, pluginDataDir);
    // Same current-hop prompt PreToolUse puts in transmission.userQuery.
    const serializedInput = JSON.stringify(input.toolInput);
    const currentHopContent = mapping.command?.trim() || mapping.pattern?.trim() ||
        (serializedInput !== '{}' ? serializedInput : toolName);
    const resolvedModel = (0, kiroSession_1.resolveSessionModelWithSource)(input.sessionId, process.env, os.homedir(), pluginDataDir);
    const model = resolvedModel.model;
    (0, debug_1.debugLog)(`model=${(0, kiroSession_1.describeModel)(resolvedModel)}`);
    const machineId = (0, deviceId_1.resolveMachineId)(pluginDataDir);
    // userQuery matches PreToolUse; the tool result is transmission.response,
    // not closed Cedar context, so the evaluate payload carries it without a
    // schema change.
    const transmission = (0, context_1.buildToolResponseTransmission)(input.toolResponse, currentHopContent);
    const session = (0, turnCache_1.directSessionFromTurn)(input.sessionId, turn);
    // Same resources PreToolUse evaluated, one request each.
    const requests = toolMapping.mappings.map((each) => {
        const request = {
            subject: (0, entity_1.directSpecOf)(subjectDescriptor),
            principal: (0, entity_1.directSpecOf)(userDescriptor),
            action: { name: each.actionName },
            resource: (0, entity_1.directSpecOf)((0, entity_1.buildEntityDescriptor)(each.resourceType, each.resourceId, each.resourceProperties, each.resourceParents)),
            context: (0, context_1.buildActionContext)(each, {
                hops,
                conversationMessages: (0, turnCache_1.conversationFromTurn)(turn),
                activeSessionCount,
                currentSession,
                model,
                modelContext: cfg.modelContext,
                machineId,
            }),
            transmission,
            session,
        };
        return { mapping: each, request, traceparent: traceparentFor(each) };
    });
    (0, debug_1.debugLog)(`-> post ${toolName}: ${requests.map((r) => `${r.mapping.actionName}:${r.mapping.resourceId}`).join(', ')} (hops=${hops.length})`);
    const aggregate = await (0, evaluateAll_1.evaluateAll)(cfg, requests, pluginDataDir, input.sessionId);
    const result = aggregate.result;
    (0, debug_1.debugLog)(`<- post decision=${result.inactive ? 'inactive' : result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);
    writeDecision(result);
}
main().catch((err) => {
    // Logged here specifically — see authorizePrompt.ts's identical comment
    // on why writeDecision()'s own stdout isn't something you can read.
    (0, debug_1.debugLog)(`internal error — failing closed: ${err?.message || String(err)}`);
    writeDecision({
        decision: 'deny',
        reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
    });
});
