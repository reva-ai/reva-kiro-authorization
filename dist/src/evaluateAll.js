"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.describeMapping = describeMapping;
exports.evaluateAll = evaluateAll;
const debug_1 = require("./debug");
const pdpClient_1 = require("./pdpClient");
function describeMapping(mapping) {
    return `${mapping.actionName} on ${mapping.resourceType}:${mapping.resourceId}`;
}
// Each request carries its own traceparent: one span per resource (see
// trace.ts toolSpanKey), so each resource's pre/post pair meets on one span.
async function evaluateAll(cfg, requests, pluginDataDir, threadId) {
    const evaluated = await Promise.all(requests.map(async ({ mapping, request, traceparent }) => ({
        mapping,
        result: await (0, pdpClient_1.evaluate)(cfg, request, traceparent, pluginDataDir, threadId),
    })));
    for (const { mapping, result } of evaluated) {
        (0, debug_1.debugLog)(`<- ${describeMapping(mapping)} => ${result.inactive ? 'inactive' : result.decision}` +
            `${result.status ? ` (HTTP ${result.status})` : ''}${result.reason ? ` reason="${result.reason}"` : ''}`);
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
                    reason: `${denied.result.reason || 'Blocked by Reva governance policy'} ` +
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
