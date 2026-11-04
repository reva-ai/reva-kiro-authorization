import * as os from 'node:os';
import { getActiveSessionCount, markSessionActive } from './activeSessions';
import { buildActionContext, buildTransmission } from './context';
import { loadConfig, resolveDataDir } from './config';
import { debugLog } from './debug';
import { resolveMachineId } from './deviceId';
import { applyKiroCliEnv } from './kiroSettings';
import { buildEntityDescriptor, directSpecOf, refOf } from './entity';
import { evaluateAll } from './evaluateAll';
import { enqueuePendingSpawnLineage, loadAgentHops, resolveSubAgentLineage } from './hopChain';
import { resolveAgentContext, resolveUserEmail } from './identity';
import { MAX_RESOURCES_PER_CALL, mapToolCall, subAgentPrompts } from './mapping';
import { triggerMcpIngestionForInvokedServer } from './mcpIngestionTrigger';
import { recordSubAgentPrompts } from './subAgentPrompts';
import { describeModel, resolveSessionModelWithSource } from './kiroSession';
import { readStdin } from './stdin';
import { reserveSpawnIndices } from './spawnCounter';
import { deriveSpanId, toolSpanKey, traceparentHeader } from './trace';
import { emitDecision, hostLabel, normalizeInput, blocksAt } from './host';
import { resolveSessionSurface } from './surface';
import { CedarActionMapping, CedarEntityDescriptor, CedarHop, CedarRequest, PdpResult, RevaHost } from './types';
import { conversationFromTurn, directSessionFromTurn, loadOrStartTurn, resolveTurnTraceId } from './turnCache';

// PreToolUse / preToolUse — the one gate that can actually stop an action
// before it runs. All host-specific I/O (which trigger name arrived, where
// the session id lives, how a deny is signalled) is handled by src/host.ts;
// this file is host-agnostic below the normalizeInput() call.
//
// Set as soon as the payload is parsed, so the fail-closed handler at the
// bottom still emits the right host's deny signal even when the failure
// happened before or during normalization. Defaults to the enforcing host:
// if we cannot tell, behave as though the deny will be honored.
let host: RevaHost = 'kiro-ide';

function writeDecision(result: PdpResult): never {
  return emitDecision(host, 'PreToolUse', result);
}

async function main(): Promise<void> {
  applyKiroCliEnv();
  const raw = await readStdin();
  // Logged before JSON.parse, deliberately: a payload that doesn't parse,
  // or that a host reshaped without warning, is exactly the failure this
  // needs to show. Goes to REVA_DEBUG_LOG_FILE when set — never to stderr
  // alongside a deny reason, since both hosts splice a hook's whole stderr
  // into the block message (see debug.ts).
  debugLog(`raw PreToolUse stdin: ${raw}`);
  const input = normalizeInput(JSON.parse(raw), 'PreToolUse');
  host = input.host;
  applyKiroCliEnv(process.env, { cwd: input.cwd });
  debugLog(`host=${hostLabel(host)} enforcing=${blocksAt(host, 'PreToolUse')}`);
  const cfg = loadConfig();
  const pluginDataDir = resolveDataDir();

  // Refreshes lastSeen for this session_id — keeps the active-sessions
  // registry accurate for as long as the session keeps being used, since
  // there's no confirmed hook for a session actually closing. Same for a
  // subagent's own tool calls: cfg.agentId is always this same run's
  // configured id regardless of subagent status, so this still refreshes
  // the right entry (the registry itself stays local-machine-scoped
  // regardless of what agentId now represents — see deviceId.ts).
  const surface = resolveSessionSurface({ host: input.host, agentId: cfg.agentId, sessionId: input.sessionId, pluginDataDir });
  const currentSession = markSessionActive(cfg.agentId, input.sessionId, surface.entrypoint, pluginDataDir, surface.pid);
  const activeSessionCount = getActiveSessionCount(cfg.agentId, pluginDataDir);

  const agentCtx = resolveAgentContext(cfg.agentId, input);
  // Both hosts always send tool_name on this trigger; the fallback only
  // guards against a malformed payload, which still gets evaluated rather
  // than skipped.
  const toolName: string = input.toolName || 'unknown-tool';
  // Every resource this call touches — several for a chained shell command,
  // a batched read, or an MCP tool given paths. All are evaluated below,
  // deny-if-any (see evaluateAll.ts).
  const toolMapping = mapToolCall(toolName, input.toolInput, input.cwd);
  debugLog(
    `-> ${toolName} touches ${toolMapping.candidateCount} resource(s): ` +
      `${toolMapping.mappings.map((m) => `${m.actionName}:${m.resourceId}`).join(', ') || '(none)'}`,
  );
  if (toolMapping.overCap) {
    writeDecision({
      decision: 'deny',
      reason:
        `Reva governance: this tool call touches ${toolMapping.candidateCount} distinct paths, above the ` +
        `limit of ${MAX_RESOURCES_PER_CALL} per call. Split it into narrower commands.`,
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
  const turn = loadOrStartTurn(input.sessionId, pluginDataDir);
  const traceId = resolveTurnTraceId(input.sessionId, turn);
  const traceparentFor = (each: { actionName: string; resourceId: string }): string =>
    traceparentHeader(traceId, deriveSpanId(traceId, toolSpanKey(toolName, input.toolInput, each)));

  // Cumulative spawn count for this turn, one number PER sub-agent started.
  // A single kiro-cli use_subagent call can start several sub-agents (one
  // `spawn` mapping each — see mapping.ts), so all of this call's numbers
  // are claimed in one step and handed out in order: four sub-agents get
  // 1, 2, 3, 4 (or later numbers if this turn already spawned some).
  // Unrelated tool calls don't advance the counter.
  const spawnMappings = toolMapping.mappings.filter((m) => m.actionName === 'spawn');
  const spawnIndices =
    spawnMappings.length > 0 ? reserveSpawnIndices(input.sessionId, spawnMappings.length, pluginDataDir) : [];
  const subagentIndexOf = new Map<CedarActionMapping, number>(
    spawnMappings.map((m, i) => [m, spawnIndices[i]] as [CedarActionMapping, number]),
  );
  // Remember what each new sub-agent was told: the IDE then submits that
  // same text as a prompt event, which must continue this turn (and its
  // count) rather than start a new one — see subAgentPrompts.ts.
  if (spawnMappings.length > 0) {
    recordSubAgentPrompts(input.sessionId, subAgentPrompts(toolName, input.toolInput), pluginDataDir);
  }

  // principal: the human who ultimately initiated this chain — resolved
  // the same way regardless of who's directly acting (Agent or SubAgent).
  const userEmail = resolveUserEmail();
  const userDescriptor = buildEntityDescriptor('User', userEmail);

  // Ingest-on-invoke: a tool of an MCP server not yet registered for this
  // User gets a registration pass started now, not at the next session (see
  // mcpIngestionTrigger.ts). Contained in its own try/catch on purpose:
  // main()'s catch fails CLOSED, so a throw from this best-effort
  // bookkeeping would deny a legitimate tool call.
  // Every distinct server, since a tool_load can name several.
  try {
    const mcpServers = new Set(
      toolMapping.mappings
        .flatMap((m) => m.resourceParents || [])
        .filter((parent) => parent.type === 'MCPServer')
        .map((parent) => parent.id),
    );
    for (const server of mcpServers) {
      triggerMcpIngestionForInvokedServer(cfg, userEmail, server, input.cwd, pluginDataDir);
    }
  } catch (err: any) {
    debugLog(`authorize: ingest-on-invoke skipped — ${err?.message || String(err)}`);
  }

  // subject: no parents on SubAgent — the schema declares SubAgent's
  // memberOfTypes as [], so it isn't valid for a SubAgent to claim
  // membership in Agent (or anything else).
  const subjectDescriptor: CedarEntityDescriptor = agentCtx.isSubAgent
    ? buildEntityDescriptor('SubAgent', `${agentCtx.agentId}:${agentCtx.subAgentId}`, {
        agentType: agentCtx.subAgentType || 'subagent',
      })
    : buildEntityDescriptor('Agent', agentCtx.agentId);
  const subject = refOf(subjectDescriptor);

  const hops: CedarHop[] = agentCtx.isSubAgent
    ? resolveSubAgentLineage(input.sessionId, agentCtx.subAgentId!, pluginDataDir)
    : loadAgentHops(input.sessionId, pluginDataDir);

  // The direct endpoint's current transmission describes this tool hop; if
  // the host calls this hook without PromptSubmit, use only real action
  // data observed here because the endpoint rejects a blank current prompt.
  const serializedInput = JSON.stringify(input.toolInput);
  const currentHopContent =
    mapping.command?.trim() || mapping.pattern?.trim() ||
    (serializedInput !== '{}' ? serializedInput : toolName);

  const resolvedModel = resolveSessionModelWithSource(input.sessionId, process.env, os.homedir(), pluginDataDir);
  const model = resolvedModel.model;
  debugLog(`model=${describeModel(resolvedModel)}`);
  const machineId = resolveMachineId(pluginDataDir);
  const transmission = buildTransmission(currentHopContent, 'assistant', toolName);
  const session = directSessionFromTurn(input.sessionId, turn);

  // One request per resource; everything but the resource (and its
  // action) is shared, because it is the same tool call.
  const requests = toolMapping.mappings.map((each) => {
    const resourceDescriptor = buildEntityDescriptor(
      each.resourceType,
      each.resourceId,
      each.resourceProperties,
      each.resourceParents,
    );
    const request: CedarRequest = {
      subject: directSpecOf(subjectDescriptor),
      principal: directSpecOf(userDescriptor),
      action: { name: each.actionName },
      resource: directSpecOf(resourceDescriptor),
      context: buildActionContext(each, {
        subagentIndex: subagentIndexOf.get(each),
        hops,
        conversationMessages: conversationFromTurn(turn),
        activeSessionCount,
        currentSession,
        model,
        machineId,
      }),
      transmission,
      session,
    };
    return { mapping: each, request, traceparent: traceparentFor(each), resource: refOf(resourceDescriptor) };
  });

  // For each sub-agent this call starts, queue the lineage it should
  // inherit — its own id isn't known yet (most hosts only reveal it on that
  // subagent's own first tool call), so this is matched up later, in FIFO
  // order, by resolveSubAgentLineage above. One entry per sub-agent, so a
  // call that starts four leaves four lineages to bind.
  for (const spawnRequest of requests.filter((r) => r.mapping.actionName === 'spawn')) {
    const spawnHop: CedarHop = {
      seq: hops.length + 1,
      subject,
      action: { name: 'spawn' },
      resource: spawnRequest.resource,
      time: new Date().toISOString(),
    };
    enqueuePendingSpawnLineage(input.sessionId, hops, spawnHop, pluginDataDir);
  }

  debugLog(
    `-> evaluating ${requests.length} resource(s) (tool=${toolName}${
      spawnIndices.length ? `, subagentIndex=${spawnIndices.join(',')}` : ''
    }, hops=${hops.length})`,
  );
  const aggregate = await evaluateAll(cfg, requests, pluginDataDir, input.sessionId);
  const result = aggregate.result;
  debugLog(`<- decision=${result.inactive ? 'inactive' : result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);
  writeDecision(result);
}

main().catch((err: any) => {
  // Any unexpected failure (bad stdin JSON, mapping bug, etc.) must still
  // fail closed rather than let an uncaught exception exit non-zero, which
  // could be treated as a non-blocking error and let the tool call through.
  // Logged here (not just via writeDecision's own stdout) since Kiro
  // consumes that stdout as its own decision contract, not a log you can
  // read — see authorizePrompt.ts's identical comment.
  debugLog(`internal error — failing closed: ${err?.message || String(err)}`);
  writeDecision({
    decision: 'deny',
    reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
  });
});
