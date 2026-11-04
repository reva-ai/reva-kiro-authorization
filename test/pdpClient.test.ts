import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { evaluate, ORIGIN_APP } from '../src/pdpClient';
import { CedarRequest, RevaConfig } from '../src/types';

const baseCfg: RevaConfig = {
  pdpUrl: 'https://pdp.test/pdp/v2/ai/evaluation',
  authorization: 'test-token',
  agentId: 'agent-a',
  timeoutMs: 1000,
  ingestionUrl: 'https://pdp.test/ingestion/v2',
  policyStoreId: '',
  policyStoreHeader: 'policyStoreId',
  ingestionTimeoutMs: 1000,
};

const baseRequest: CedarRequest = {
  subject: { type: 'Agent', id: 'agent-a' },
  principal: { type: 'User', id: 'alice@example.com' },
  action: { name: 'invokeTool' },
  resource: { type: 'Tool', id: 'WebFetch', properties: { name: 'WebFetch' } },
  context: {
    timestamp: 1,
    prompt: 'find docs',
    hops: [
      {
        seq: 1,
        subject: { type: 'User', id: 'alice@example.com' },
        action: { name: 'invokeAgent' },
        resource: { type: 'Agent', id: 'agent-a' },
        time: '2026-08-19T10:00:00Z',
      },
    ],
  },
  transmission: {
    promptKey: 'userQuery',
    userQuery: 'WebFetch',
    role: 'assistant',
    contentType: 'text/plain',
  },
  session: { id: 'sess-1', turn: 1, startedAt: '2026-08-19T10:00:00Z' },
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
