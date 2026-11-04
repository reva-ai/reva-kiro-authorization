import * as os from 'node:os';
import { getActiveSessionCount, getSessionEntry } from './activeSessions';
import { buildActionContext, buildToolResponseTransmission } from './context';
import { loadConfig, resolveDataDir } from './config';
import { debugLog } from './debug';
import { resolveMachineId } from './deviceId';
import { applyKiroCliEnv } from './kiroSettings';
import { buildEntityDescriptor, directSpecOf } from './entity';
import { evaluateAll } from './evaluateAll';
import { loadAgentHops, resolveSubAgentLineage } from './hopChain';
import { resolveAgentContext, resolveUserEmail } from './identity';
import { mapToolCall } from './mapping';
import { describeModel, resolveSessionModelWithSource } from './kiroSession';
import { readStdin } from './stdin';
import { deriveSpanId, toolSpanKey, traceparentHeader } from './trace';
import { emitDecision, hostLabel, normalizeInput } from './host';
import { CedarEntityDescriptor, CedarRequest, PdpResult, RevaHost } from './types';
import { conversationFromTurn, directSessionFromTurn, loadOrStartTurn, resolveTurnTraceId } from './turnCache';

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
let host: RevaHost = 'kiro-ide';

function writeDecision(result: PdpResult): never {
  return emitDecision(host, 'PostToolUse', result);
}

async function main(): Promise<void> {
  applyKiroCliEnv();
  const raw = await readStdin();
  debugLog(`raw PostToolUse stdin: ${raw}`);
  const input = normalizeInput(JSON.parse(raw), 'PostToolUse');
  host = input.host;
  applyKiroCliEnv(process.env, { cwd: input.cwd });
  debugLog(`host=${hostLabel(host)} (PostToolUse is audit-only on both hosts)`);
  const cfg = loadConfig();
  const pluginDataDir = resolveDataDir();

  // Read-only here, not a refresh — PreToolUse already marked this same
  // tool call's session active moments earlier in the same cycle.
  const activeSessionCount = getActiveSessionCount(cfg.agentId, pluginDataDir);
  const currentSession = getSessionEntry(cfg.agentId, input.sessionId, pluginDataDir);

  const agentCtx = resolveAgentContext(cfg.agentId, input);
  const toolName: string = input.toolName || 'unknown-tool';
  const toolMapping = mapToolCall(toolName, input.toolInput, input.cwd);
  if (toolMapping.overCap) {
    // PreToolUse already denied this call; there is nothing bounded to audit.
    debugLog(`post: ${toolName} touched ${toolMapping.candidateCount} paths, above the cap — not evaluated`);
    process.exit(0);
  }
  const mapping = toolMapping.mappings[0];

  const turn = loadOrStartTurn(input.sessionId, pluginDataDir);
  const traceId = resolveTurnTraceId(input.sessionId, turn);
  // Same per-resource span key PreToolUse used, so each resource's pre/post
  // pair meets on one span.
  const traceparentFor = (each: { actionName: string; resourceId: string }): string =>
    traceparentHeader(traceId, deriveSpanId(traceId, toolSpanKey(toolName, input.toolInput, each)));

  const userEmail = resolveUserEmail();
  const userDescriptor = buildEntityDescriptor('User', userEmail);

  const subjectDescriptor: CedarEntityDescriptor = agentCtx.isSubAgent
    ? buildEntityDescriptor('SubAgent', `${agentCtx.agentId}:${agentCtx.subAgentId}`, {
        agentType: agentCtx.subAgentType || 'subagent',
      })
    : buildEntityDescriptor('Agent', agentCtx.agentId);

  const hops = agentCtx.isSubAgent
    ? resolveSubAgentLineage(input.sessionId, agentCtx.subAgentId!, pluginDataDir)
    : loadAgentHops(input.sessionId, pluginDataDir);

  // Same current-hop prompt PreToolUse puts in transmission.userQuery.
  const serializedInput = JSON.stringify(input.toolInput);
  const currentHopContent =
    mapping.command?.trim() || mapping.pattern?.trim() ||
    (serializedInput !== '{}' ? serializedInput : toolName);

  const resolvedModel = resolveSessionModelWithSource(input.sessionId, process.env, os.homedir(), pluginDataDir);
  const model = resolvedModel.model;
  debugLog(`model=${describeModel(resolvedModel)}`);
  const machineId = resolveMachineId(pluginDataDir);
  // userQuery matches PreToolUse; the tool result is transmission.response,
  // not closed Cedar context, so the evaluate payload carries it without a
  // schema change.
  const transmission = buildToolResponseTransmission(input.toolResponse, currentHopContent);
  const session = directSessionFromTurn(input.sessionId, turn);

  // Same resources PreToolUse evaluated, one request each.
  const requests = toolMapping.mappings.map((each) => {
    const request: CedarRequest = {
      subject: directSpecOf(subjectDescriptor),
      principal: directSpecOf(userDescriptor),
      action: { name: each.actionName },
      resource: directSpecOf(
        buildEntityDescriptor(each.resourceType, each.resourceId, each.resourceProperties, each.resourceParents),
      ),
      context: buildActionContext(each, {
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
    return { mapping: each, request, traceparent: traceparentFor(each) };
  });

  debugLog(
    `-> post ${toolName}: ${requests.map((r) => `${r.mapping.actionName}:${r.mapping.resourceId}`).join(', ')} (hops=${hops.length})`,
  );
  const aggregate = await evaluateAll(cfg, requests, pluginDataDir, input.sessionId);
  const result = aggregate.result;
  debugLog(`<- post decision=${result.inactive ? 'inactive' : result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);
  writeDecision(result);
}

main().catch((err: any) => {
  // Logged here specifically — see authorizePrompt.ts's identical comment
  // on why writeDecision()'s own stdout isn't something you can read.
  debugLog(`internal error — failing closed: ${err?.message || String(err)}`);
  writeDecision({
    decision: 'deny',
    reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
  });
});
