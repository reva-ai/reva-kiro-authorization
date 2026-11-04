export interface RevaConfig {
  pdpUrl: string;
  // Sent as the X-API-Token header on BOTH evaluation and ingestion calls —
  // one Reva auth token authenticates everything this plugin does.
  authorization: string;
  // The Cedar `Agent` entity's id: a stable id for the logged-in account.
  // Resolved from the logged-in Kiro account (its user UUID — see
  // src/deviceId.ts) or from REVA_AGENT_ID. No fallback to a machine or
  // random id: loadConfig() throws if neither is available, the same as a
  // missing auth token.
  agentId: string;
  timeoutMs: number;
  // Optional Reva policy-store id, sent as a request header on BOTH
  // evaluation and ingestion calls when set. Empty string when unset, in
  // which case no header is sent at all and the PDP resolves the store from
  // the auth token alone (which is how every confirmed deployment so far
  // has worked).
  //
  // TRANSPORT UNCONFIRMED — see config.ts's DEFAULT_POLICY_STORE_HEADER.
  policyStoreId: string;
  policyStoreHeader: string;
  // Ingestion API (registers User/Agent/MCPServer entities so they exist
  // before any evaluation request references them) — a separate base URL
  // and timeout from evaluation (best-effort, no user-facing value worth
  // waiting the same 25s default for), but the same `authorization` token.
  ingestionUrl: string;
  ingestionTimeoutMs: number;
}

// Which of Kiro's two hook systems this invocation came from. They are not
// variants of one mechanism — different registration files, trigger names,
// session-id transport, tool vocabulary, and enforcement. src/host.ts is the
// only file that has to care; see its header for the full comparison.
export type RevaHost = 'kiro-ide' | 'kiro-cli';

// The IDE's trigger names are used as the canonical vocabulary throughout
// this plugin; kiro-cli's camelCase names (`agentSpawn`, `userPromptSubmit`,
// `preToolUse`, `postToolUse`) are aliased onto these in host.ts.
export type CanonicalHookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionEnd';

// The one shape every entrypoint works from, produced by
// host.ts's normalizeInput() out of either host's raw payload.
export interface NormalizedHookInput {
  host: RevaHost;
  event: CanonicalHookEvent;
  // Resolved from `session_id` (IDE) or the KIRO_SESSION_ID env var (CLI —
  // it sends no session_id in the payload at all). Empty string when neither
  // is available, which every cache below treats as "don't persist."
  sessionId: string;
  cwd: string;
  promptId?: string;
  prompt?: string;
  toolName?: string;
  toolInput: Record<string, any>;
  toolResponse?: unknown;
  // Absent on both hosts today — see host.ts's normalizeInput comment.
  subAgentId?: string;
  subAgentType?: string;
  // The untouched payload, for debug logging and for reading a field neither
  // host documented yet without having to widen this interface first.
  raw: Record<string, any>;
}

// Raw per-host payload shapes, kept for documentation and for the tests that
// pin them down. Entrypoints consume NormalizedHookInput instead.
//
// Kiro IDE (confirmed by reading the payload builder `bor()` in the
// installed kiro.kiro-agent/dist/extension.js): every trigger sends
// `{session_id, hook_event_name, cwd}` plus its own fields.
export interface PreToolUseInput {
  session_id: string;
  prompt_id?: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, any>;
  // CONFIRMED ABSENT on both hosts — neither the IDE's payload builder nor
  // any captured kiro-cli payload carries a sub-agent marker, so
  // resolveAgentContext() always resolves isSubAgent: false today. Kept
  // optional so a future version that adds it under these names just works.
  agent_id?: string;
  agent_type?: string;
}

export interface PostToolUseInput extends PreToolUseInput {
  tool_response?: unknown;
  tool_use_id?: string;
  duration_ms?: number;
}

export interface PromptSubmitInput {
  session_id: string;
  prompt_id?: string;
  cwd: string;
  hook_event_name: string;
  prompt: string;
}

// kiro-cli (confirmed by capturing real payloads).
// Note what is NOT here: no `session_id`. The CLI passes it as the
// KIRO_SESSION_ID environment variable instead.
export interface KiroCliHookInput {
  hook_event_name: 'agentSpawn' | 'userPromptSubmit' | 'preToolUse' | 'postToolUse' | 'stop';
  cwd: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  tool_response?: unknown;
  assistant_response?: string;
}

// A bare reference to an entity — used for active-turn hops and as the base
// of direct-AI subject/principal/resource specs.
export interface CedarEntityRef {
  type: string;
  id: string;
}

// Canonical entity shape accepted by the direct AI evaluation endpoint.
// Request-local attributes ride in `properties`; the endpoint does not accept
// the classic evaluation API's top-level `entities` collection.
export interface DirectEvalEntitySpec extends CedarEntityRef {
  name?: string;
  properties?: Record<string, any>;
  // Request-local Cedar ancestry for ephemeral coding resources that are not
  // persisted in PDP (files, directories, tools, and subagents).
  parents?: CedarEntityRef[];
  tool?: string;
  origin?: string;
  endpoint?: string;
}

// Internal normalized entity description used by the mapping layer. Direct
// AI requests map attrs and optional ancestry onto the direct entity spec;
// PDP's stored bare User/Agent entities remain authoritative.
export interface CedarEntityDescriptor {
  uid: CedarEntityRef;
  attrs: Record<string, any>;
  parents: CedarEntityRef[];
}

// One step in the delegation chain leading up to (but not including) the
// current request's own action — see hopChain.ts for how this is tracked
// across the stateless per-hook-call processes.
export interface CedarHop {
  seq: number;
  subject: CedarEntityRef;
  action: { name: string };
  resource: CedarEntityRef;
  time: string;
}

export interface DirectEvalConversationMessage {
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  contentType: string;
  content: string;
  timestamp: string;
}

export interface DirectEvalTransmission {
  promptKey: 'userQuery';
  userQuery: string;
  role: 'user' | 'assistant' | 'tool';
  contentType: string;
  // PostToolUse only: the tool's result. userQuery stays the same current-hop
  // prompt PreToolUse sent, so the pre/post pair shows one prompt.
  response?: string;
}

// Metadata-only sessions are explicitly supported by the PDP. The plugin
// deliberately omits `messages`: its current hooks do not observe a reliable
// final assistant response for every completed turn, so adding history would
// fabricate evidence or create invalid request/response pairs.
export interface DirectEvalSession {
  id: string;
  turn: number;
  startedAt: string;
}

export interface CedarRequest {
  // subject: the entity directly performing this action (Agent/SubAgent
  // for tool calls, User for invokeAgent itself).
  subject: DirectEvalEntitySpec;
  // principal: the human who ultimately initiated this chain — always the
  // resolved user, even many hops/subagents deep. Equal to `subject` only
  // for invokeAgent, where the human IS the one directly acting.
  principal: DirectEvalEntitySpec;
  action: { name: string };
  resource: DirectEvalEntitySpec;
  context: Record<string, any>;
  transmission: DirectEvalTransmission;
  session: DirectEvalSession;
}

export type PdpDecision = 'allow' | 'deny' | 'ask';

export interface PdpResult {
  decision: PdpDecision;
  // A 401 or operational 5xx disables Reva enforcement for its cooldown.
  // Hook writers must emit no decision in this state: emitting an explicit
  // `allow` would bypass Kiro's own normal permission behavior.
  inactive?: boolean;
  reason?: string;
  raw?: any;
  // Opaque machine-readable error supplied by the PDP, or a synthetic
  // PDP_UNAVAILABLE/PDP_TIMEOUT for transport failures.
  errorType?: string;
  // The actual PDP HTTP status, or synthetic 503/504 for transport/timeout
  // inactivity. Kept separate from the hook decision.
  status?: number;
}

export type CedarActionName =
  | 'executeBash'
  | 'read'
  | 'write'
  | 'edit'
  | 'glob'
  | 'grep'
  | 'invokeTool'
  | 'spawn'
  | 'invokeAgent';

export interface CedarActionMapping {
  actionName: CedarActionName;
  resourceType: string;
  resourceId: string;
  resourceProperties?: Record<string, any>;
  resourceParents?: CedarEntityRef[];
  // Only set for executeBash: the literal, real shell command string.
  command?: string;
  // Only set for glob/grep: the search pattern (there's no shell command
  // for these, but the pattern itself is meaningful context).
  pattern?: string;
  // Original native tool name (e.g. a batched/notebook edit variant) for
  // actions that group multiple tools together (edit covers several
  // variants) — keeps audit fidelity without needing a separate action per
  // tool variant.
  tool?: string;
}

// Everything one tool call touches. Cedar takes one resource per request,
// but one Kiro tool call can touch many (a chained shell command, a batched
// fs_read, an MCP tool given several paths), so each becomes its own
// mapping and authorize.ts evaluates all of them, deny-if-any (see
// evaluateAll.ts).
export interface ToolMapping {
  mappings: CedarActionMapping[];
  // How many distinct paths the call appeared to touch, before any cap.
  candidateCount: number;
  // More paths than MAX_RESOURCES_PER_CALL: `mappings` is empty and the call
  // is denied outright rather than widened to a common ancestor.
  overCap?: boolean;
}

export interface SessionContext {
  id: string;
  traceId: string;
  spanId: string;
}
