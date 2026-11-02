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
const mcpIngestionTrigger_1 = require("./mcpIngestionTrigger");
const subAgentPrompts_1 = require("./subAgentPrompts");
const kiroSession_1 = require("./kiroSession");
const stdin_1 = require("./stdin");
const spawnCounter_1 = require("./spawnCounter");
const trace_1 = require("./trace");
const host_1 = require("./host");
const turnCache_1 = require("./turnCache");
// PreToolUse / preToolUse — the one gate that can actually stop an action
// before it runs. All host-specific I/O (which trigger name arrived, where
// the session id lives, how a deny is signalled) is handled by src/host.ts;
// this file is host-agnostic below the normalizeInput() call.
//
// Set as soon as the payload is parsed, so the fail-closed handler at the
// bottom still emits the right host's deny signal even when the failure
// happened before or during normalization. Defaults to the enforcing host:
// if we cannot tell, behave as though the deny will be honored.
let host = 'kiro-ide';
function writeDecision(result) {
    return (0, host_1.emitDecision)(host, 'PreToolUse', result);
}
async function main() {
    (0, kiroSettings_1.applyKiroCliEnv)();
    const raw = await (0, stdin_1.readStdin)();
    // Logged before JSON.parse, deliberately: a payload that doesn't parse,
    // or that a host reshaped without warning, is exactly the failure this
    // needs to show. Goes to REVA_DEBUG_LOG_FILE when set — never to stderr
    // alongside a deny reason, since both hosts splice a hook's whole stderr
    // into the block message (see debug.ts).
    (0, debug_1.debugLog)(`raw PreToolUse stdin: ${raw}`);
    const input = (0, host_1.normalizeInput)(JSON.parse(raw), 'PreToolUse');
    host = input.host;
    (0, kiroSettings_1.applyKiroCliEnv)(process.env, { cwd: input.cwd });
    (0, debug_1.debugLog)(`host=${(0, host_1.hostLabel)(host)} enforcing=${(0, host_1.blocksAt)(host, 'PreToolUse')}`);
    const cfg = (0, config_1.loadConfig)();
    const pluginDataDir = (0, config_1.resolveDataDir)();
    // Refreshes lastSeen for this session_id — keeps the active-sessions
    // registry accurate for as long as the session keeps being used, since
    // there's no confirmed hook for a session actually closing. Same for a
    // subagent's own tool calls: cfg.agentId is always this same run's
    // configured id regardless of subagent status, so this still refreshes
    // the right entry (the registry itself stays local-machine-scoped
    // regardless of what agentId now represents — see deviceId.ts).
    const currentSession = (0, activeSessions_1.markSessionActive)(cfg.agentId, input.sessionId, (0, host_1.sessionEntrypoint)(input.host), pluginDataDir);
    const activeSessionCount = (0, activeSessions_1.getActiveSessionCount)(cfg.agentId, pluginDataDir);
    const agentCtx = (0, identity_1.resolveAgentContext)(cfg.agentId, input);
    // Both hosts always send tool_name on this trigger; the fallback only
    // guards against a malformed payload, which still gets evaluated rather
    // than skipped.
    const toolName = input.toolName || 'unknown-tool';
    // Every resource this call touches — several for a chained shell command,
    // a batched read, or an MCP tool given paths. All are evaluated below,
    // deny-if-any (see evaluateAll.ts).
    const toolMapping = (0, mapping_1.mapToolCall)(toolName, input.toolInput, input.cwd);
    (0, debug_1.debugLog)(`-> ${toolName} touches ${toolMapping.candidateCount} resource(s): ` +
        `${toolMapping.mappings.map((m) => `${m.actionName}:${m.resourceId}`).join(', ') || '(none)'}`);
    if (toolMapping.overCap) {
        writeDecision({
            decision: 'deny',
            reason: `Reva governance: this tool call touches ${toolMapping.candidateCount} distinct paths, above the ` +
                `limit of ${mapping_1.MAX_RESOURCES_PER_CALL} per call. Split it into narrower commands.`,
        });
    }
    // The first resource stands for the call wherever one is needed (span
    // derivation, transmission text); a spawn is always a single resource.
    const mapping = toolMapping.mappings[0];
    // Read back the TRACE id PromptSubmit recorded for this turn. If no
    // boundary exists, loadOrStartTurn records this first event as the
    // observed turn instead of inventing prior history. Span is derived per
    // RESOURCE of this tool call (toolSpanKey), so each resource's Pre/Post
    // pair shares one span without shared state.
    const turn = (0, turnCache_1.loadOrStartTurn)(input.sessionId, pluginDataDir);
    const traceId = (0, turnCache_1.resolveTurnTraceId)(input.sessionId, turn);
    const traceparentFor = (each) => (0, trace_1.traceparentHeader)(traceId, (0, trace_1.deriveSpanId)(traceId, (0, trace_1.toolSpanKey)(toolName, input.toolInput, each)));
    // Cumulative spawn count for this turn, one number PER sub-agent started.
    // A single kiro-cli use_subagent call can start several sub-agents (one
    // `spawn` mapping each — see mapping.ts), so all of this call's numbers
    // are claimed in one step and handed out in order: four sub-agents get
    // 1, 2, 3, 4 (or later numbers if this turn already spawned some).
    // Unrelated tool calls don't advance the counter.
    const spawnMappings = toolMapping.mappings.filter((m) => m.actionName === 'spawn');
    const spawnIndices = spawnMappings.length > 0 ? (0, spawnCounter_1.reserveSpawnIndices)(input.sessionId, spawnMappings.length, pluginDataDir) : [];
    const subagentIndexOf = new Map(spawnMappings.map((m, i) => [m, spawnIndices[i]]));
    // Remember what each new sub-agent was told: the IDE then submits that
    // same text as a prompt event, which must continue this turn (and its
    // count) rather than start a new one — see subAgentPrompts.ts.
    if (spawnMappings.length > 0) {
        (0, subAgentPrompts_1.recordSubAgentPrompts)(input.sessionId, (0, mapping_1.subAgentPrompts)(toolName, input.toolInput), pluginDataDir);
    }
    // principal: the human who ultimately initiated this chain — resolved
    // the same way regardless of who's directly acting (Agent or SubAgent).
    const userEmail = (0, identity_1.resolveUserEmail)();
    const userDescriptor = (0, entity_1.buildEntityDescriptor)('User', userEmail);
    // Ingest-on-invoke: a tool of an MCP server not yet registered for this
    // User gets a registration pass started now, not at the next session (see
    // mcpIngestionTrigger.ts). Contained in its own try/catch on purpose:
    // main()'s catch fails CLOSED, so a throw from this best-effort
    // bookkeeping would deny a legitimate tool call.
    try {
        const mcpServer = toolMapping.mappings
            .flatMap((m) => m.resourceParents || [])
            .find((parent) => parent.type === 'MCPServer');
        if (mcpServer)
            (0, mcpIngestionTrigger_1.triggerMcpIngestionForInvokedServer)(cfg, userEmail, mcpServer.id, input.cwd, pluginDataDir);
    }
    catch (err) {
        (0, debug_1.debugLog)(`authorize: ingest-on-invoke skipped — ${err?.message || String(err)}`);
    }
    // subject: no parents on SubAgent — the schema declares SubAgent's
    // memberOfTypes as [], so it isn't valid for a SubAgent to claim
    // membership in Agent (or anything else).
    const subjectDescriptor = agentCtx.isSubAgent
        ? (0, entity_1.buildEntityDescriptor)('SubAgent', `${agentCtx.agentId}:${agentCtx.subAgentId}`, {
            agentType: agentCtx.subAgentType || 'subagent',
        })
        : (0, entity_1.buildEntityDescriptor)('Agent', agentCtx.agentId);
    const subject = (0, entity_1.refOf)(subjectDescriptor);
    const hops = agentCtx.isSubAgent
        ? (0, hopChain_1.resolveSubAgentLineage)(input.sessionId, agentCtx.subAgentId, pluginDataDir)
        : (0, hopChain_1.loadAgentHops)(input.sessionId, pluginDataDir);
    // The direct endpoint's current transmission describes this tool hop; if
    // the host calls this hook without PromptSubmit, use only real action
    // data observed here because the endpoint rejects a blank current prompt.
    const serializedInput = JSON.stringify(input.toolInput);
    const currentHopContent = mapping.command?.trim() || mapping.pattern?.trim() ||
        (serializedInput !== '{}' ? serializedInput : toolName);
    const resolvedModel = (0, kiroSession_1.resolveSessionModelWithSource)(input.sessionId, process.env, os.homedir(), pluginDataDir);
    const model = resolvedModel.model;
    (0, debug_1.debugLog)(`model=${(0, kiroSession_1.describeModel)(resolvedModel)}`);
    const machineId = (0, deviceId_1.resolveMachineId)(pluginDataDir);
    const transmission = (0, context_1.buildTransmission)(currentHopContent, 'assistant', toolName);
    const session = (0, turnCache_1.directSessionFromTurn)(input.sessionId, turn);
    // One request per resource; everything but the resource (and its
    // action) is shared, because it is the same tool call.
    const requests = toolMapping.mappings.map((each) => {
        const resourceDescriptor = (0, entity_1.buildEntityDescriptor)(each.resourceType, each.resourceId, each.resourceProperties, each.resourceParents);
        const request = {
            subject: (0, entity_1.directSpecOf)(subjectDescriptor),
            principal: (0, entity_1.directSpecOf)(userDescriptor),
            action: { name: each.actionName },
            resource: (0, entity_1.directSpecOf)(resourceDescriptor),
            context: (0, context_1.buildActionContext)(each, {
                subagentIndex: subagentIndexOf.get(each),
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
        return { mapping: each, request, traceparent: traceparentFor(each), resource: (0, entity_1.refOf)(resourceDescriptor) };
    });
    // For each sub-agent this call starts, queue the lineage it should
    // inherit — its own id isn't known yet (most hosts only reveal it on that
    // subagent's own first tool call), so this is matched up later, in FIFO
    // order, by resolveSubAgentLineage above. One entry per sub-agent, so a
    // call that starts four leaves four lineages to bind.
    for (const spawnRequest of requests.filter((r) => r.mapping.actionName === 'spawn')) {
        const spawnHop = {
            seq: hops.length + 1,
            subject,
            action: { name: 'spawn' },
            resource: spawnRequest.resource,
            time: new Date().toISOString(),
        };
        (0, hopChain_1.enqueuePendingSpawnLineage)(input.sessionId, hops, spawnHop, pluginDataDir);
    }
    (0, debug_1.debugLog)(`-> evaluating ${requests.length} resource(s) (tool=${toolName}${spawnIndices.length ? `, subagentIndex=${spawnIndices.join(',')}` : ''}, hops=${hops.length})`);
    const aggregate = await (0, evaluateAll_1.evaluateAll)(cfg, requests, pluginDataDir, input.sessionId);
    const result = aggregate.result;
    (0, debug_1.debugLog)(`<- decision=${result.inactive ? 'inactive' : result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);
    writeDecision(result);
}
main().catch((err) => {
    // Any unexpected failure (bad stdin JSON, mapping bug, etc.) must still
    // fail closed rather than let an uncaught exception exit non-zero, which
    // could be treated as a non-blocking error and let the tool call through.
    // Logged here (not just via writeDecision's own stdout) since Kiro
    // consumes that stdout as its own decision contract, not a log you can
    // read — see authorizePrompt.ts's identical comment.
    (0, debug_1.debugLog)(`internal error — failing closed: ${err?.message || String(err)}`);
    writeDecision({
        decision: 'deny',
        reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
    });
});
