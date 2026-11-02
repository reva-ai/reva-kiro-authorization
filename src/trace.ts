import { createHash, randomUUID } from 'node:crypto';
import { SessionContext } from './types';

// Three distinct identifiers, one per level of the hierarchy. Getting the
// levels right is the whole point:
//
//   thread  — the chat. Kiro's own session_id (IDE payload / KIRO_SESSION_ID),
//             sent as X-Reva-Thread-Id on every PDP call. Constant from the
//             first prompt of a conversation to the last; changes only when
//             a new chat is started.
//   trace   — one user prompt. Minted per turn (turnCache.startTurn) and
//             read back by every hook in that turn, so a prompt that fans
//             out into many tool calls keeps one trace across all of them.
//             The next prompt gets a new one.
//   span    — one operation inside the turn. Derived, not random, so the
//             PreToolUse and PostToolUse halves of the SAME tool call land
//             on the same span: both hooks see identical tool_name and
//             tool_input, so both compute the same value with no shared
//             state. See deriveSpanId's own note on the collision this
//             accepts.
//
// Before this, traceId was a hash of session_id (constant for the entire
// session) and spanId was minted per turn — the levels were each one step
// too high, and there was no thread header at all. Reva decision logs key
// on trace_id, so the second prompt in a chat vanished behind the first.

// 32 hex chars, W3C traceparent trace-id. Random rather than derived: a turn
// has no natural stable key of its own (prompt_id is optional and not
// confirmed identical across every mode), so the plugin mints one and pins
// it in the turn cache, the same approach the span id used to take.
export function mintTraceId(): string {
  return randomUUID().replace(/-/g, '');
}

// Deterministic fallback for a turn whose cache entry predates traceId, or
// that could not be written. Stable for a given (session, turn) so every
// hook in that turn still agrees, without needing a cache write.
export function deriveTraceId(sessionId: string, turn: number): string {
  return createHash('sha256').update(`${sessionId}:turn:${turn}`).digest('hex').slice(0, 32);
}

// 16 hex chars, W3C traceparent parent-id (span). Derived from the trace plus
// a caller-supplied key describing the operation.
//
// The key for a tool call is tool_name + tool_input, which PreToolUse and
// PostToolUse both have and which are identical between them — that is what
// makes the pair share a span without any state passing between the two
// processes. tool_use_id would be the natural key, but hosts often only
// send it on PostToolUse, so it cannot pair the two.
//
// Accepted consequence: two genuinely separate calls with identical input in
// one turn (the same bash command run twice) collapse onto one span. They
// stay under the correct trace, so the turn is still whole; they just are not
// distinguishable from each other within it.
export function deriveSpanId(traceId: string, key: string): string {
  return createHash('sha256').update(`${traceId}:${key}`).digest('hex').slice(0, 16);
}

// Span key for ONE resource of a tool call. A shell command or an MCP tool
// given a path maps to several resources, each its own request; with one
// span per tool call those requests shared it, and Reva's Pre/Post view —
// which pairs records on a span — could pair a pre-tool request for one
// resource with the post-tool request for another. Adding action + resource
// gives each resource its own span, and PostToolUse maps the same input to
// the same resources, so each pre/post pair still meets on one span. Keyed
// on the id, not the type: a path deleted by the call can classify
// differently afterwards (File before, Directory after).
export function toolSpanKey(
  toolName: string,
  toolInput: Record<string, any> | undefined,
  mapping: { actionName: string; resourceId: string },
): string {
  return `tool:${toolName}:${JSON.stringify(toolInput || {})}:${mapping.actionName}:${mapping.resourceId}`;
}

export function buildSessionContext(sessionId: string, spanId: string, traceId: string, id?: string): SessionContext {
  return { id: id || sessionId, traceId, spanId };
}

export function traceparentHeader(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}
