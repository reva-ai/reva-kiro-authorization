import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { evaluate, ORIGIN_APP, summarizeTrace } from '../src/pdpClient';
import { CedarRequest, RevaConfig } from '../src/types';

const baseCfg: RevaConfig = {
  pdpUrl: 'https://pdp.test/pdp/ai/access/v1/ai/evaluation',
  pluginVersionUrl: 'https://pdp.test/pdp/ai/access/v1/ai/plugin/version',
  authorization: 'test-token',
  agentId: 'agent-a',
  timeoutMs: 1000,
  ingestionUrl: 'https://pdp.test/ingestion/v2',
  policyStoreId: '',
  policyStoreHeader: 'policyStoreId',
  ingestionTimeoutMs: 1000,
  summarizeUrl: 'https://pdp.test/pdp/ai/access/v1/ai/trace/summarize',
};

const baseRequest: CedarRequest = {
  subject: { type: 'Agent', id: 'agent-a' },
  principal: { type: 'User', id: 'alice@example.com' },
  action: { name: 'invokeTool' },
  resource: { type: 'Tool', id: 'WebFetch', properties: { name: 'WebFetch' } },
  context: { timestamp: 1 },
  transmission: {
    promptKey: 'userQuery',
    userQuery: 'WebFetch',
    role: 'assistant',
    contentType: 'text/plain',
  },
  session: { id: 'sess-1' },
};

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-pdp-'));
  return Promise.resolve(fn(dir)).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('200 always allows by status, even with decision false or malformed JSON', async () => {
  for (const body of [JSON.stringify({ decision: false }), 'not-json']) {
    await withFetch(
      (async () => new Response(body, { status: 200 })) as any,
      async () => {
        const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        assert.equal(result.decision, 'allow');
        assert.equal(result.status, 200);
      },
    );
  }
});

test('200 with guardrails.outcome "conditional_allow" asks instead of allowing', async () => {
  await withFetch(
    (async () =>
      new Response(
        JSON.stringify({
          decision: true,
          guardrails: { outcome: 'conditional_allow', reason: 'needs review' },
        }),
        { status: 200 },
      )) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'ask');
      assert.equal(result.reason, 'needs review');
    },
  );
});

test('403 uses the fixed org-policy message regardless of context.reason', async () => {
  await withFetch(
    (async () => new Response(JSON.stringify({ context: { reason: 'policy denied' } }), { status: 403 })) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'deny');
      assert.equal(result.reason, "Blocked by your organization's security policy.");
    },
  );
});

test('401 fails open and latches the circuit for that session', async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        return new Response(JSON.stringify({ error_type: 'UNAUTHORIZED' }), { status: 401 });
      }) as any,
      async () => {
        const first = await evaluate(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-1');
        const second = await evaluate(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-1');
        assert.equal(first.inactive, true);
        assert.equal(second.inactive, true);
        assert.equal(second.raw?.circuitOpen, true);
        // First call hit the network; second short-circuited on the latch.
        assert.equal(calls, 1);
      },
    );
  });
});

test('every 500-599 response fails closed (deny)', async () => {
  for (const status of [500, 502, 503, 504, 599]) {
    await withFetch(
      (async () => new Response(JSON.stringify({ error_type: `ENGINE_${status}` }), { status })) as any,
      async () => {
        const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        assert.equal(result.decision, 'deny');
        assert.equal(result.inactive, undefined);
        assert.equal(result.status, status);
      },
    );
  }
});

test('404 and 424 fail closed', async () => {
  for (const status of [404, 424]) {
    await withFetch(
      (async () => new Response('', { status })) as any,
      async () => {
        const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        assert.equal(result.decision, 'deny');
        assert.equal(result.inactive, undefined);
        assert.equal(result.status, status);
      },
    );
  }
});

test('413 fails open without denying', async () => {
  await withFetch(
    (async () => new Response(JSON.stringify({ error_type: 'PAYLOAD_TOO_LARGE' }), { status: 413 })) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'allow');
      assert.equal(result.inactive, true);
      assert.equal(result.status, 413);
    },
  );
});

test('network failure synthesizes 503 and fails closed', async () => {
  await withFetch(
    (async () => {
      throw new Error('ECONNREFUSED');
    }) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'deny');
      assert.equal(result.status, 503);
      assert.equal(result.errorType, 'PDP_UNAVAILABLE');
    },
  );
});

test('timeout synthesizes 504 and fails closed', async () => {
  await withFetch(
    ((_url: any, opts: any) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      })) as any,
    async () => {
      const result = await evaluate({ ...baseCfg, timeoutMs: 10 }, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'deny');
      assert.equal(result.status, 504);
      assert.equal(result.errorType, 'PDP_TIMEOUT');
    },
  );
});

test('sends Origin-App KIRO, verification code, token, and thread id', async () => {
  let headers: Record<string, string> | undefined;
  await withFetch(
    (async (_url: any, opts: any) => {
      headers = opts.headers;
      return new Response(JSON.stringify({ decision: true }), { status: 200 });
    }) as any,
    async () => {
      await evaluate(baseCfg, baseRequest, '00-x-y-01', undefined, 'sess-thread-1');
    },
  );
  assert.equal(headers?.['X-API-Origin-App'], ORIGIN_APP);
  assert.equal(headers?.['X-API-Origin-App'], 'KIRO');
  assert.equal(headers?.['X-Reva-Verification-Codes'], 'CODE_USER_SCOPE');
  assert.equal(headers?.['X-API-Token'], 'test-token');
  assert.equal(headers?.['X-Reva-Thread-Id'], 'sess-thread-1');
});

test('X-Reva-Thread-Id is omitted when no thread id is passed', async () => {
  let headers: Record<string, string> | undefined;
  await withFetch(
    (async (_url: any, opts: any) => {
      headers = opts.headers;
      return new Response(JSON.stringify({ decision: true }), { status: 200 });
    }) as any,
    async () => {
      await evaluate(baseCfg, baseRequest, '00-x-y-01');
    },
  );
  assert.equal('X-Reva-Thread-Id' in (headers || {}), false);
});

test('a configured policy store id rides in the header on evaluation calls', async () => {
  let sent: Record<string, string> = {};
  await withFetch(
    (async (_url: any, opts: any) => {
      sent = opts.headers;
      return new Response(JSON.stringify({ decision: true }), { status: 200 });
    }) as any,
    () => evaluate({ ...baseCfg, policyStoreId: 'store-42' }, baseRequest, 'trace-1'),
  );
  assert.equal(sent['policyStoreId'], 'store-42');
  assert.equal(sent['X-API-Token'], baseCfg.authorization);
});

// --- summarizeTrace ----------------------------------------------------------

test('summarizeTrace POSTs trace_id/thread_id/output to the summarize URL; 202 is accepted', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  await withFetch(
    (async (url: any, init: any) => {
      seen = { url: String(url), init };
      return new Response('', { status: 202 });
    }) as any,
    async () => {
      const result = await summarizeTrace(baseCfg, { trace_id: 'a'.repeat(32), thread_id: 'sess-1', output: 'all done' });
      assert.deepEqual(result, { ok: true, status: 202 });
    },
  );
  assert.ok(seen);
  assert.equal(seen.url, baseCfg.summarizeUrl);
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(seen.init.body)), {
    trace_id: 'a'.repeat(32),
    thread_id: 'sess-1',
    output: 'all done',
  });
  const headers = seen.init.headers as Record<string, string>;
  assert.equal(headers['X-API-Origin-App'], ORIGIN_APP);
  assert.equal(headers['X-API-Token'], 'test-token');
  assert.equal(headers['X-Reva-Thread-Id'], 'sess-1');
  // Summarize has no principal in its body, so the user-scope verification
  // that evaluation sends cannot succeed on it.
  assert.equal('X-Reva-Verification-Codes' in headers, false);
});

test('summarizeTrace carries no hops, conversation or session history', async () => {
  let body: any;
  await withFetch(
    (async (_url: any, init: any) => {
      body = JSON.parse(String(init.body));
      return new Response('', { status: 202 });
    }) as any,
    async () => {
      await summarizeTrace(baseCfg, { trace_id: 'b'.repeat(32), thread_id: 'sess-1' });
    },
  );
  assert.deepEqual(Object.keys(body).sort(), ['thread_id', 'trace_id']);
});

test('summarizeTrace reports a non-202 as not ok, with the status and a trimmed reason', async () => {
  await withFetch(
    (async () => new Response('x'.repeat(1000), { status: 400 })) as any,
    async () => {
      const result = await summarizeTrace(baseCfg, { trace_id: 'c'.repeat(32) });
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
      assert.equal(result.reason?.length, 300);
    },
  );
});

test('summarizeTrace never throws: a network failure comes back as ok:false', async () => {
  await withFetch(
    (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as any,
    async () => {
      const result = await summarizeTrace(baseCfg, { trace_id: 'd'.repeat(32) });
      assert.equal(result.ok, false);
      assert.match(result.reason || '', /ECONNREFUSED/);
    },
  );
});

test('summarizeTrace gives up on a hung server instead of waiting out the evaluation timeout', async () => {
  const started = Date.now();
  await withFetch(
    ((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      })) as any,
    async () => {
      const result = await summarizeTrace({ ...baseCfg, timeoutMs: 50 }, { trace_id: 'e'.repeat(32) });
      assert.equal(result.ok, false);
    },
  );
  assert.ok(Date.now() - started < 2000);
});
