import * as os from 'node:os';
import { getActiveSessionCount, markSessionActive } from './activeSessions';
import { loadConfig, resolveDataDir } from './config';
import { debugLog } from './debug';
import { resolveMachineId } from './deviceId';
import { applyKiroCliEnv } from './kiroSettings';
import { startTurnHops } from './hopChain';
import { resolveUserEmail } from './identity';
import { buildInvokeAgentRequest } from './invokeAgent';
import { evaluate } from './pdpClient';
import { resetSpawnCounter } from './spawnCounter';
import { claimSubAgentPrompt } from './subAgentPrompts';
import { describeModel, resolveSessionModelWithSource } from './kiroSession';
import { ensureSessionIngested } from './sessionIngestion';
import { triggerMcpDiscoveryIfDue } from './mcpIngestionTrigger';
import { readStdin } from './stdin';
import { buildSessionContext, deriveSpanId, traceparentHeader } from './trace';
import { emitDecision, hostLabel, blocksAt } from './host';
import { normalizeInput, sessionEntrypoint } from './host';
import { CedarHop, PdpResult, RevaHost } from './types';
import { directSessionFromTurn, loadOrStartTurn, resolveTurnTraceId, startTurn, truncatePrompt } from './turnCache';

// UserPromptSubmit (IDE) / userPromptSubmit (kiro-cli) — the top-level
// "a human handed the agent an instruction" gate, evaluated as invokeAgent.
//
// Deny is exit 2 + reason on stderr on both hosts (host.ts emits it). The
// IDE honors that; kiro-cli documents it but does not honor it yet, so
// there this is audit-only — blocksAt() reports which, and it is logged
// rather than assumed. There is no structured "ask" at this trigger on
// either host, so host.ts surfaces an ask as plain context text at exit 0,
// which both hosts do inject into the agent's context.
let host: RevaHost = 'kiro-ide';

function writeDecision(result: PdpResult): never {
  return emitDecision(host, 'UserPromptSubmit', result);
}

async function main(): Promise<void> {
  // Fill REVA_* gaps from ~/.kiro/settings/cli.json before anything reads
  // process.env (including debug.ts). process.env still wins when set.
  applyKiroCliEnv();
  const raw = await readStdin();
  // Logged before JSON.parse, deliberately: a payload that fails to parse,
  // or one a host reshaped without warning, is exactly the failure this
  // needs to surface. Written to REVA_DEBUG_LOG_FILE when set, never to
  // stderr alongside a deny reason (see debug.ts).
  debugLog(`raw UserPromptSubmit stdin: ${raw}`);
  const input = normalizeInput(JSON.parse(raw), 'UserPromptSubmit');
  host = input.host;
  // Workspace cli.json (if any) can override global now that cwd is known.
  applyKiroCliEnv(process.env, { cwd: input.cwd });
  debugLog(`host=${hostLabel(host)} enforcing=${blocksAt(host, 'UserPromptSubmit')}`);
  const cfg = loadConfig();
  const pluginDataDir = resolveDataDir();

  const userEmail = resolveUserEmail();
  const prompt = input.prompt ? truncatePrompt(input.prompt) : '';

  // PromptSubmit fires every turn, unlike SessionStart (once per session) —
  // a good second place to keep this session's lastSeen fresh.
  const currentSession = markSessionActive(
    cfg.agentId,
    input.sessionId,
    sessionEntrypoint(input.host),
    pluginDataDir,
  );
  const activeSessionCount = getActiveSessionCount(cfg.agentId, pluginDataDir);

  // Register User/Agent/MCPServer in Reva's directory, once per session.
  // Fires from HERE rather than only from session start because kiro-cli
  // 2.21.3 stopped firing `agentSpawn` — see sessionIngestion.ts. This
  // returns immediately: the work happens in a detached child process, so
  // nothing about it can delay or fail this prompt's decision.
  const ingestionStarted = ensureSessionIngested(input.sessionId, input.cwd, pluginDataDir, input.host);

  // Re-reads Kiro's mcp.json files at most every 15 minutes, so a server
  // added mid-session reaches "Linked MCP Servers" without waiting for the
  // next session (mcpIngestionTrigger.ts). Skipped on the prompt that just
  // started the session pass — that pass already covers MCP servers.
  // Contained for the same reason as authorize.ts's ingest-on-invoke: this
  // file's main() fails closed.
  try {
    if (!ingestionStarted) triggerMcpDiscoveryIfDue(cfg, input.cwd, pluginDataDir);
  } catch (err: any) {
    debugLog(`authorizePrompt: MCP recheck skipped — ${err?.message || String(err)}`);
  }

  // A prompt event can be a SUB-AGENT starting rather than the user: the
  // Kiro IDE submits each invoke_sub_agent's instructions as a prompt of its
  // own, in this session. That is part of the current turn — it must not
  // reset the sub-agent count (the 4th sub-agent would come out as #1) or
  // start a new trace. Recognized by matching the text PreToolUse recorded
  // when the sub-agent was spawned (subAgentPrompts.ts).
  const isSubAgentPrompt = claimSubAgentPrompt(input.sessionId, input.prompt, pluginDataDir);

  // Otherwise this plugin owns the turn boundary itself: mint a fresh TRACE
  // id here and persist it (with the prompt text) so every PreToolUse call
  // this turn produces — separate, stateless hook processes — reads the
  // same value back instead of each rolling its own. Spans are derived per
  // operation from that trace (see trace.ts).
  const turn = isSubAgentPrompt
    ? loadOrStartTurn(input.sessionId, pluginDataDir)
    : startTurn(input.sessionId, input.prompt, pluginDataDir);
  if (isSubAgentPrompt) {
    debugLog('prompt is a sub-agent\'s instructions — same turn, sub-agent count and trace kept');
  } else {
    // A real new turn resets the subagent spawn counter — each turn's first
    // spawn is #1 again, not a continuation of every prior turn's count
    // (see spawnCounter.ts's own comment on why).
    resetSpawnCounter(input.sessionId, pluginDataDir);
  }
  const traceId = resolveTurnTraceId(input.sessionId, turn);
  const spanId = deriveSpanId(traceId, 'user-prompt');
  const traceSession = buildSessionContext(input.sessionId, spanId, traceId, input.promptId);
  const traceparent = traceparentHeader(traceSession.traceId, traceSession.spanId);

  // Resolved once and logged: `model` comes from a file Kiro writes on its
  // own schedule, so "why is model missing from this decision" is a real
  // question the debug trail has to be able to answer.
  const resolvedModel = resolveSessionModelWithSource(input.sessionId, process.env, os.homedir(), pluginDataDir);
  const model = resolvedModel.model;
  debugLog(`model=${describeModel(resolvedModel)} modelContext=${cfg.modelContext}`);

  const request = buildInvokeAgentRequest(
    userEmail,
    cfg.agentId,
    prompt,
    directSessionFromTurn(input.sessionId, turn),
    activeSessionCount,
    currentSession,
    model,
    cfg.modelContext,
    resolveMachineId(pluginDataDir),
  );

  debugLog(`-> invokeAgent as ${userEmail} on Agent:${cfg.agentId} trace=${traceId}`);
  const result = await evaluate(cfg, request, traceparent, pluginDataDir, input.sessionId);
  debugLog(`<- decision=${result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);

  // Record this invokeAgent as the base of this turn's hop chain regardless
  // of the decision, so a subsequent tool call (if the turn proceeds) has
  // it to build on — mirrors how the spawn counter also advances on every
  // attempt, not just approved ones.
  // A sub-agent's prompt keeps the turn's existing chain (which already
  // holds the user's invokeAgent and the spawns) instead of restarting it.
  const invokeAgentHop: CedarHop = {
    seq: 1,
    subject: request.subject,
    action: { name: 'invokeAgent' },
    resource: request.resource,
    time: new Date().toISOString(),
  };
  if (!isSubAgentPrompt) startTurnHops(input.sessionId, invokeAgentHop, pluginDataDir);

  writeDecision(result);
}

main().catch((err: any) => {
  // Logged here specifically because this is the one failure path
  // writeDecision()'s own output never reaches you directly — Kiro consumes
  // the hook's stdout as its own decision contract, not a log you can read.
  // Without this, an internal failure (e.g. a real Kiro payload not
  // actually shaping up the way types.ts assumed) would look identical to
  // "the hook silently never ran at all" from the outside.
  debugLog(`internal error — failing closed: ${err?.message || String(err)}`);
  writeDecision({
    decision: 'deny',
    reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
  });
});
