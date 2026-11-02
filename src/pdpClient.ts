import { debugLog } from './debug';
import { isCircuitOpen, openCircuit } from './pdpCircuitBreaker';
import { CedarRequest, PdpResult, RevaConfig } from './types';

const PDP_UNAVAILABLE = 'PDP_UNAVAILABLE';
const PDP_TIMEOUT = 'PDP_TIMEOUT';
const UNAUTHORIZED = 'UNAUTHORIZED';
const PDP_SERVER_ERROR = 'PDP_SERVER_ERROR';
const PDP_FAILED_DEPENDENCY = 'PDP_FAILED_DEPENDENCY';
const PDP_PAYLOAD_TOO_LARGE = 'PDP_PAYLOAD_TOO_LARGE';
const PDP_NOT_FOUND = 'PDP_NOT_FOUND';

// Wire value for X-API-Origin-App — must match the enum Reva expects for this
// host, which is KIRO.
export const ORIGIN_APP = 'KIRO';

class PdpTimeoutError extends Error {}

interface PdpHttpResponse {
  status: number;
  text: string;
  json: any;
}

function parseJson(text: string): any {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorTypeOf(json: any): string | undefined {
  const value = json != null && typeof json === 'object' && !Array.isArray(json) ? json.error_type : undefined;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function errorMessageOf(json: any): string | undefined {
  if (json == null || typeof json !== 'object' || Array.isArray(json)) return undefined;
  const contextReason = json.context?.reason;
  if (typeof contextReason === 'string' && contextReason.trim()) return contextReason;
  for (const key of ['message', 'error', 'reason']) {
    const value = json[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function guardrailsOutcomeOf(json: any): { outcome?: string; reason?: string } {
  const guardrails = json != null && typeof json === 'object' && !Array.isArray(json) ? json.guardrails : undefined;
  if (guardrails == null || typeof guardrails !== 'object' || Array.isArray(guardrails)) return {};
  return {
    outcome: typeof guardrails.outcome === 'string' ? guardrails.outcome : undefined,
    reason: typeof guardrails.reason === 'string' ? guardrails.reason : undefined,
  };
}

async function postJson(
  cfg: RevaConfig,
  url: string,
  body: unknown,
  traceparent?: string,
  threadId?: string,
): Promise<PdpHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Origin-App': ORIGIN_APP,
          'X-Reva-Verification-Codes': 'CODE_USER_SCOPE',
          ...(cfg.authorization ? { 'X-API-Token': cfg.authorization } : {}),
          ...(cfg.policyStoreId ? { [cfg.policyStoreHeader]: cfg.policyStoreId } : {}),
          ...(traceparent ? { traceparent } : {}),
          ...(threadId ? { 'X-Reva-Thread-Id': threadId } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: any) {
      if (controller.signal.aborted) {
        throw new PdpTimeoutError(err?.message || 'PDP request timed out');
      }
      throw err;
    }

    const text = await res.text().catch(() => '');
    return { status: res.status, text, json: parseJson(text) };
  } finally {
    clearTimeout(timer);
  }
}

async function postToPdp(
  cfg: RevaConfig,
  request: CedarRequest,
  traceparent: string,
  threadId?: string,
): Promise<PdpHttpResponse> {
  return postJson(cfg, cfg.pdpUrl, request, traceparent, threadId);
}

// Only 401 and 413 fail open — everything else operational (404, 424, 5xx)
// fails CLOSED. `inactive: true` is only set on the 401/413 branches. 401
// additionally latches the per-session circuit (pdpCircuitBreaker.ts).
function handleOperationalStatuses(
  res: PdpHttpResponse,
  pluginDataDir: string | undefined,
  sessionId: string | undefined,
): PdpResult | undefined {
  if (res.status === 401) {
    const errorType = errorTypeOf(res.json) || UNAUTHORIZED;
    if (sessionId) openCircuit(sessionId, res.status, errorType, pluginDataDir);
    return {
      decision: 'deny',
      inactive: true,
      reason: `Reva authorization unavailable${errorType ? ` (${errorType})` : ''} — failing open for this request`,
      errorType,
      status: 401,
      raw: res.json ?? res.text,
    };
  }

  if (res.status === 413) {
    const errorType = errorTypeOf(res.json) || PDP_PAYLOAD_TOO_LARGE;
    return {
      decision: 'allow',
      inactive: true,
      reason: `Reva PDP rejected the request as too large (HTTP 413${errorType ? ` ${errorType}` : ''}) — failing open for this request`,
      errorType,
      status: 413,
      raw: res.json ?? res.text,
    };
  }

  if (res.status === 404) {
    const errorType = errorTypeOf(res.json) || PDP_NOT_FOUND;
    return {
      decision: 'deny',
      reason:
        errorMessageOf(res.json) ||
        `Reva PDP could not resolve this request (HTTP 404${errorType ? ` ${errorType}` : ''}) — blocked while Reva is unavailable`,
      errorType,
      status: 404,
      raw: res.json ?? res.text,
    };
  }

  if (res.status === 424) {
    const errorType = errorTypeOf(res.json) || PDP_FAILED_DEPENDENCY;
    return {
      decision: 'deny',
      reason: `Reva PDP error (HTTP 424${errorType ? ` ${errorType}` : ''}) — blocked while Reva is unavailable`,
      errorType,
      status: 424,
      raw: res.json ?? res.text,
    };
  }

  if (res.status >= 500 && res.status < 600) {
    const errorType = errorTypeOf(res.json) || PDP_SERVER_ERROR;
    return {
      decision: 'deny',
      reason: `Reva PDP error (HTTP ${res.status}${errorType ? ` ${errorType}` : ''}) — blocked while Reva is unavailable`,
      errorType,
      status: res.status,
      raw: res.json ?? res.text,
    };
  }

  return undefined;
}

function handleTransportFailure(err: any): PdpResult {
  const timedOut = err instanceof PdpTimeoutError;
  const errorType = timedOut ? PDP_TIMEOUT : PDP_UNAVAILABLE;
  const status = timedOut ? 504 : 503;
  return {
    decision: 'deny',
    reason: `Reva PDP ${errorType === PDP_TIMEOUT ? 'timed out' : 'is unavailable'} — blocked while Reva is unavailable`,
    errorType,
    status,
    raw: { error_type: errorType },
  };
}

export async function evaluate(
  cfg: RevaConfig,
  request: CedarRequest,
  traceparent: string,
  pluginDataDir?: string,
  threadId?: string,
): Promise<PdpResult> {
  const breaker = threadId ? isCircuitOpen(threadId, pluginDataDir) : { open: false as const };
  if (breaker.open) {
    debugLog(
      `evaluate: PDP not called — circuit open for this session since ${new Date(breaker.openedAt!).toISOString()} ` +
        `(HTTP ${breaker.triggeredStatus}${breaker.errorType ? ` ${breaker.errorType}` : ''}); a new session will call again`,
    );
    return {
      decision: 'allow',
      inactive: true,
      reason: `Reva PDP is unavailable for this session (HTTP ${breaker.triggeredStatus}${
        breaker.errorType ? ` ${breaker.errorType}` : ''
      } at ${new Date(breaker.openedAt!).toISOString()}) — failing open for this request`,
      errorType: breaker.errorType,
      status: breaker.triggeredStatus,
      raw: { circuitOpen: true, openedAt: breaker.openedAt },
    };
  }

  try {
    const res = await postToPdp(cfg, request, traceparent, threadId);
    debugLog(`evaluate: PDP responded HTTP ${res.status} ${JSON.stringify(res.json ?? res.text)}`);

    if (res.status === 200) {
      const guardrails = guardrailsOutcomeOf(res.json);
      if (guardrails.outcome === 'conditional_allow') {
        return {
          decision: 'ask',
          reason: guardrails.reason || 'Reva governance requires manual review for this request',
          status: 200,
          raw: res.json,
        };
      }
      return {
        decision: 'allow',
        status: 200,
        raw: res.json,
      };
    }

    if (res.status === 403) {
      return {
        decision: 'deny',
        reason: "Blocked by your organization's security policy.",
        errorType: errorTypeOf(res.json),
        status: 403,
        raw: res.json ?? res.text,
      };
    }

    const operational = handleOperationalStatuses(res, pluginDataDir, threadId);
    if (operational) return operational;

    return {
      decision: 'deny',
      reason: errorMessageOf(res.json) || `Reva PDP rejected the request (HTTP ${res.status}: ${res.text.slice(0, 300)})`,
      errorType: errorTypeOf(res.json),
      status: res.status,
      raw: res.json ?? res.text,
    };
  } catch (err: any) {
    debugLog(`evaluate: PDP request failed — ${err?.message || String(err)}`);
    return handleTransportFailure(err);
  }
}
