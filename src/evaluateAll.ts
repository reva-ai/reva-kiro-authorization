import { debugLog } from './debug';
import { evaluate } from './pdpClient';
import { CedarActionMapping, CedarRequest, PdpResult, RevaConfig } from './types';

// ONE Kiro tool call can touch MANY resources (a chained shell command, a
// batched fs_read, an MCP tool given several paths). Cedar takes one
// resource per request and the hook answers once, so every resource is
// evaluated and the answers are composed.
//
// Composition is DENY-IF-ANY. It is the only rule under which a file-level
// policy means what it says: evaluating one resource and ignoring the rest
// would let `cat README.md; cat .env` pass on the strength of README.md, and
// evaluating a common-ancestor directory instead would widen the resource
// until Cedar's `in` no longer relates it to the forbidden path. Both fail
// toward SILENT PERMISSION; this fails toward a visible denial.
//
// Evaluated in PARALLEL, so wall-clock stays roughly one round trip
// rather than N x REVA_PDP_TIMEOUT_MS.

export interface EvaluatedResource {
  mapping: CedarActionMapping;
  result: PdpResult;
}

export interface AggregateResult {
  // The single decision to hand back to Kiro.
  result: PdpResult;
  evaluated: EvaluatedResource[];
}

export function describeMapping(mapping: CedarActionMapping): string {
  return `${mapping.actionName} on ${mapping.resourceType}:${mapping.resourceId}`;
}

// Each request carries its own traceparent: one span per resource (see
// trace.ts toolSpanKey), so each resource's pre/post pair meets on one span.
export async function evaluateAll(
  cfg: RevaConfig,
  requests: { mapping: CedarActionMapping; request: CedarRequest; traceparent: string }[],
  pluginDataDir?: string,
  threadId?: string,
): Promise<AggregateResult> {
  const evaluated: EvaluatedResource[] = await Promise.all(
    requests.map(async ({ mapping, request, traceparent }) => ({
      mapping,
      result: await evaluate(cfg, request, traceparent, pluginDataDir, threadId),
    })),
  );

  for (const { mapping, result } of evaluated) {
    debugLog(
      `<- ${describeMapping(mapping)} => ${result.inactive ? 'inactive' : result.decision}` +
        `${result.status ? ` (HTTP ${result.status})` : ''}${result.reason ? ` reason="${result.reason}"` : ''}`,
    );
  }

  // An inactive result is a PDP outage or auth failure, not a verdict: it
  // neither blocks nor satisfies. The batch is decided by the resources
  // that DID get a real answer; a wholly inactive batch passes through
  // inactive, exactly as a single inactive call does.
  const active = evaluated.filter((e) => !e.result.inactive);
  if (active.length === 0) {
    return { result: evaluated[0]?.result ?? { decision: 'allow', inactive: true }, evaluated };
  }

  // Naming the resource matters when there are several: a bare "denied by
  // policy" leaves no way to tell which path was the problem. A single-
  // resource call keeps the PDP's reason exactly as it came back.
  const multiple = evaluated.length > 1;

  const denied = active.find((e) => e.result.decision === 'deny');
  if (denied) {
    return {
      result: multiple
        ? {
            ...denied.result,
            reason:
              `${denied.result.reason || 'Blocked by Reva governance policy'} ` +
              `[resource: ${describeMapping(denied.mapping)}] (${evaluated.length} resources evaluated for this one tool call)`,
          }
        : denied.result,
      evaluated,
    };
  }

  const asked = active.find((e) => e.result.decision === 'ask');
  if (asked) {
    return {
      result: multiple
        ? {
            ...asked.result,
            reason: `${asked.result.reason || 'conditional policy match'} [resource: ${describeMapping(asked.mapping)}]`,
          }
        : asked.result,
      evaluated,
    };
  }

  return { result: active[0].result, evaluated };
}
