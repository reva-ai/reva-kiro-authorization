import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  ingestAgent,
  ingestMcpServers,
  ingestUser,
  cacheFile,
  resolveEntityTypeIds,
} from '../src/ingestionClient';
import { RevaConfig } from '../src/types';

const baseCfg: RevaConfig = {
  pdpUrl: 'https://pdp.test/evaluate',
  authorization: 'eval-token',
  agentId: 'aa-bb-cc-dd-ee-ff',
  timeoutMs: 1000,
  ingestionUrl: 'https://pdp.test/ingestion/v2',
  modelContext: false,
  policyStoreId: '',
  policyStoreHeader: 'policyStoreId',
  ingestionTimeoutMs: 1000,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-ingest-'));
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

// Matches the real entity-types response — every
// entity type shares schemaName "CodingAgent" (the single Cedar namespace),
// not the "Identity"/"AgenticAI" split originally guessed from the docs.
// resolveEntityTypeIds matches by `name` alone (see its own comment), so
// schemaName here is just realistic fixture data, not something asserted
// on. The unrelated "SubAgent" entry confirms matching-by-name doesn't grab
// the wrong id when other entity types are present in the response.
const entityTypesResponse = [
  { id: 'user-type-id', name: 'User', schemaName: 'CodingAgent' },
  { id: 'agent-type-id', name: 'Agent', schemaName: 'CodingAgent' },
  { id: 'mcp-type-id', name: 'MCPServer', schemaName: 'CodingAgent' },
  { id: 'subagent-type-id', name: 'SubAgent', schemaName: 'CodingAgent' },
];

test('resolveEntityTypeIds fetches and picks the right ids by name alone, including User', async () => {
  await withTempDir(async (dir) => {
    let requestedUrl: string | undefined;
    let headers: Record<string, string> | undefined;
    const ids = await withFetch(
      (async (url: any, opts: any) => {
        requestedUrl = url;
        headers = opts.headers;
        return new Response(JSON.stringify(entityTypesResponse), { status: 200 });
      }) as any,
      () => resolveEntityTypeIds(baseCfg, dir),
    );
    assert.equal(ids.userEntityTypeId, 'user-type-id');
    assert.equal(ids.agentEntityTypeId, 'agent-type-id');
    assert.equal(ids.mcpServerEntityTypeId, 'mcp-type-id');
    assert.equal(requestedUrl, 'https://pdp.test/ingestion/v2/policy-store/entity-types');
    assert.equal(headers?.['X-API-Token'], 'eval-token');
  });
});

test('resolveEntityTypeIds caches after the first successful fetch — no second network call', async () => {
  await withTempDir(async (dir) => {
    let fetchCount = 0;
    const fetchOnce = (async () => {
      fetchCount++;
      return new Response(JSON.stringify(entityTypesResponse), { status: 200 });
    }) as any;

    await withFetch(fetchOnce, () => resolveEntityTypeIds(baseCfg, dir));
    assert.equal(fetchCount, 1);

    // Second call should hit the cache, not fetch again — a fetch that
    // throws here would prove the cache wasn't used.
    const second = await withFetch(
      (async () => {
        throw new Error('should not be called — cache should have been used');
      }) as any,
      () => resolveEntityTypeIds(baseCfg, dir),
    );
    assert.equal(second.agentEntityTypeId, 'agent-type-id');
  });
});

test('resolveEntityTypeIds retries on the next call if MCPServer was missing from an earlier fetch', async () => {
  await withTempDir(async (dir) => {
    let fetchCount = 0;
    // First fetch's response is missing MCPServer entirely (e.g. not yet in
    // the catalog) — Agent resolves fine, but the cache must not be treated
    // as "done" just because that one is present.
    const responseWithoutMcpServer = entityTypesResponse.filter((t) => t.name !== 'MCPServer');

    await withFetch(
      (async () => {
        fetchCount++;
        return new Response(JSON.stringify(responseWithoutMcpServer), { status: 200 });
      }) as any,
      () => resolveEntityTypeIds(baseCfg, dir),
    );
    assert.equal(fetchCount, 1);

    // A later session, once MCPServer is actually in the catalog, must
    // re-fetch rather than getting stuck on the first, incomplete result.
    const second = await withFetch(
      (async () => {
        fetchCount++;
        return new Response(JSON.stringify(entityTypesResponse), { status: 200 });
      }) as any,
      () => resolveEntityTypeIds(baseCfg, dir),
    );
    assert.equal(fetchCount, 2);
    assert.equal(second.mcpServerEntityTypeId, 'mcp-type-id');

    // And now that MCPServer resolved, a third call should finally use the cache.
    const third = await withFetch(
      (async () => {
        throw new Error('should not be called — cache should now be complete');
      }) as any,
      () => resolveEntityTypeIds(baseCfg, dir),
    );
    assert.equal(third.mcpServerEntityTypeId, 'mcp-type-id');
  });
});

test('resolveEntityTypeIds falls back to cache when a later fetch would fail', async () => {
  await withTempDir(async (dir) => {
    await withFetch(
      (async () => new Response(JSON.stringify(entityTypesResponse), { status: 200 })) as any,
      () => resolveEntityTypeIds(baseCfg, dir),
    );

    // Cache is warm — a failing network must not throw; return the cached ids.
    const result = await withFetch(
      (async () => {
        throw new Error('ECONNREFUSED');
      }) as any,
      () => resolveEntityTypeIds(baseCfg, dir),
    );
    assert.equal(result.agentEntityTypeId, 'agent-type-id');
    assert.equal(result.mcpServerEntityTypeId, 'mcp-type-id');
  });
});

// Every mock fetch below dispatches on opts.method, since ingestUser() makes
// at most 3 calls in one run, all v2: not found -> GET + POST, with
// registeredMachineIds and agents both embedded directly in the create body
// (no follow-up PATCH needed — nothing to accumulate onto yet on a
// brand-new entity); found -> GET + PATCH (registeredMachineIds) + PATCH
// (agents), each on its own (must accumulate onto whatever that existing
// entity already has — one attributeValue per PATCH, so two Sets means two
// calls).
function methodOf(opts: any): string {
  return opts?.method || 'GET';
}

test('ingestUser: GET 404 (not found) creates the User with active, registeredMachineIds AND agents in one POST — no follow-up PATCH', async () => {
  await withTempDir(async () => {
    const calls: { method: string; url: string; body?: any }[] = [];
    await withFetch(
      (async (url: any, opts: any) => {
        const method = methodOf(opts);
        calls.push({ method, url, body: opts?.body ? JSON.parse(opts.body) : undefined });
        if (method === 'GET') return new Response(undefined, { status: 404 });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestUser(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'),
    );

    assert.equal(calls.length, 2); // GET + POST only — no separate PATCH
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, 'https://pdp.test/ingestion/v2/entity/alice%40example.com?entityTypeId=user-type-id');

    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url, 'https://pdp.test/ingestion/v2/entity?entityTypeId=user-type-id');
    assert.deepEqual(calls[1].body, {
      entityId: 'alice@example.com',
      attributes: [
        { name: 'active', value: 'false' },
        { name: 'registeredMachineIds', value: 'machine-123' },
        { name: 'agents', value: 'agent-abc' },
      ],
      parents: [],
      children: [],
    });
  });
});

test('ingestUser: GET 400 is also treated as not-found (creates the User), not just 404', async () => {
  await withTempDir(async () => {
    const calls: { method: string }[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        const method = methodOf(opts);
        if (method === 'GET') return new Response(undefined, { status: 400 });
        calls.push({ method });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestUser(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'),
    );

    assert.deepEqual(calls, [{ method: 'POST' }]); // POST only — no separate PATCH
  });
});

test('ingestUser: if the create POST itself fails after a confirmed not-found GET, there is no PATCH fallback — self-heals next session', async () => {
  await withTempDir(async () => {
    const calls: { method: string }[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        const method = methodOf(opts);
        if (method === 'GET') return new Response(undefined, { status: 404 });
        calls.push({ method });
        return new Response('conflict', { status: 409 });
      }) as any,
      () => ingestUser(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'),
    );
    // No fallback PATCH after a failed create — the next session's GET will
    // find the User still missing and retry the whole POST again.
    assert.deepEqual(calls, [{ method: 'POST' }]);
  });
});

test('ingestUser: GET 200 (already exists) skips creation — PATCHes registeredMachineIds and agents, never touches active', async () => {
  await withTempDir(async () => {
    const calls: { method: string; url: string; body?: any }[] = [];
    await withFetch(
      (async (url: any, opts: any) => {
        const method = methodOf(opts);
        calls.push({ method, url, body: opts?.body ? JSON.parse(opts.body) : undefined });
        if (method === 'GET') {
          return new Response(
            JSON.stringify({
              id: 'entity-1',
              entityType: null,
              source: 'API',
              ownerStoreId: 'store-1',
              entityAttributes: [{ name: 'active', value: 'false' }],
              createdOn: '2026-01-01T00:00:00Z',
              updatedOn: '2026-01-01T00:00:00Z',
              name: 'alice@example.com',
            }),
            { status: 200 },
          );
        }
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestUser(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'),
    );

    assert.equal(calls.length, 3); // GET + PATCH (registeredMachineIds) + PATCH (agents) — no POST
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[1].method, 'PATCH');
    assert.deepEqual(calls[1].body, {
      attributeValue: { name: 'registeredMachineIds', value: 'machine-123' },
      op: 'ADD',
      path: 'ATTRIBUTE',
    });
    assert.equal(calls[2].method, 'PATCH');
    assert.deepEqual(calls[2].body, {
      attributeValue: { name: 'agents', value: 'agent-abc' },
      op: 'ADD',
      path: 'ATTRIBUTE',
    });
    assert.ok(!calls.some((c) => c.body && JSON.stringify(c.body).includes('active')));
  });
});

test('ingestUser: an inconclusive existence check (network failure) skips creation but still attempts both PATCHes', async () => {
  await withTempDir(async () => {
    const calls: { method: string }[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        const method = methodOf(opts);
        if (method === 'GET') throw new Error('ECONNREFUSED');
        calls.push({ method });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestUser(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'),
    );

    assert.equal(calls.some((c) => c.method === 'POST'), false);
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 2);
  });
});

test('ingestUser: a real 500 from the existence check is also treated as inconclusive, not "not found"', async () => {
  await withTempDir(async () => {
    const calls: { method: string }[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        const method = methodOf(opts);
        if (method === 'GET') return new Response('server error', { status: 500 });
        calls.push({ method });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestUser(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'),
    );

    assert.equal(calls.some((c) => c.method === 'POST'), false);
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 2);
  });
});

test('ingestAgent: not found -> ONE POST carrying user, agentType and operatingSystems', async () => {
  await withTempDir(async (dir) => {
    const calls: { method: string; body: any }[] = [];
    await withFetch(
      (async (url: any, opts: any) => {
        if (opts?.method === 'GET') return new Response('not found', { status: 404 });
        calls.push({ method: opts.method, body: JSON.parse(opts.body) });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestAgent(baseCfg, 'agent-type-id', 'someone@example.com', 'someone@example.com'),
    );

    // Everything a brand-new entity needs goes in the creation POST — there
    // is nothing to accumulate onto yet, so a follow-up PATCH would be pure
    // redundancy.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].body.entityId, 'someone@example.com');
    const names = calls[0].body.attributes.map((a: any) => a.name);
    // SINGULAR. A policy written `agentType == "Kiro"` must match here, and
    // the Reva console reads this attribute for the User's "Coding agent" label.
    assert.deepEqual(names, ['user', 'agentType', 'operatingSystems']);
    assert.equal(calls[0].body.attributes.find((a: any) => a.name === 'agentType').value, 'Kiro');
  });
});

test('ingestAgent: a resolved model is added to the creation POST as `models`', async () => {
  await withTempDir(async (dir) => {
    const calls: any[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        if (opts?.method === 'GET') return new Response('not found', { status: 404 });
        calls.push(JSON.parse(opts.body));
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestAgent(baseCfg, 'agent-type-id', 'someone@example.com', 'someone@example.com', 'auto'),
    );
    assert.equal(calls[0].attributes.find((a: any) => a.name === 'models')?.value, 'auto');
  });
});

test('ingestAgent: no model resolved -> no `models` attribute, never a placeholder', async () => {
  await withTempDir(async (dir) => {
    const calls: any[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        if (opts?.method === 'GET') return new Response('not found', { status: 404 });
        calls.push(JSON.parse(opts.body));
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestAgent(baseCfg, 'agent-type-id', 'someone@example.com', 'someone@example.com', undefined),
    );
    // Kiro does not put the model on the wire, so this is the common case.
    // Sending "unknown" or "" would be inventing data.
    assert.equal(calls[0].attributes.some((a: any) => a.name === 'models'), false);
  });
});

test('ingestAgent: already exists -> no re-create, one PATCH per Set attribute', async () => {
  await withTempDir(async (dir) => {
    const calls: { method: string; body: any }[] = [];
    await withFetch(
      (async (url: any, opts: any) => {
        if (opts?.method === 'GET') return new Response(JSON.stringify({ id: 'someone@example.com' }), { status: 200 });
        calls.push({ method: opts.method, body: JSON.parse(opts.body) });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestAgent(baseCfg, 'agent-type-id', 'someone@example.com', 'someone@example.com', 'auto'),
    );

    assert.equal(calls.every((c) => c.method === 'PATCH'), true, 'an existing entity is never re-created');
    // Separate PATCHes, because the confirmed body carries exactly one
    // attributeValue. One per Set that can legitimately change.
    assert.deepEqual(calls.map((c) => c.body.attributeValue.name), ['agentType', 'operatingSystems', 'models']);
    // ADD only — REPLACE is not a confirmed op on this API.
    assert.deepEqual(calls.map((c) => c.body.op), ['ADD', 'ADD', 'ADD']);
  });
});

test('ingestAgent never targets the User entity type — only Agent, across the GET/POST/PATCH it makes', async () => {
  await withTempDir(async () => {
    const entityTypeIdsUsed = new Set<string>();
    await withFetch(
      (async (url: any, opts: any) => {
        const params = new URLSearchParams(url.split('?')[1]);
        entityTypeIdsUsed.add(params.get('entityTypeId') as string);
        if (methodOf(opts) === 'GET') return new Response(undefined, { status: 404 });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestAgent(baseCfg, 'agent-type-id', 'aa-bb-cc-dd-ee-ff', 'alice@example.com'),
    );
    assert.deepEqual([...entityTypeIdsUsed], ['agent-type-id']);
  });
});

test('ingestAgent: if the create POST itself fails after a confirmed not-found GET, there is no PATCH fallback — self-heals next session', async () => {
  await withTempDir(async () => {
    const calls: { method: string }[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        const method = methodOf(opts);
        if (method === 'GET') return new Response(undefined, { status: 404 });
        calls.push({ method });
        return new Response('already exists', { status: 409 });
      }) as any,
      () => ingestAgent(baseCfg, 'agent-type-id', 'aa-bb-cc-dd-ee-ff', 'alice@example.com'),
    );
    // No fallback PATCH after a failed create — the next session's GET will
    // find the Agent (created concurrently, or not) and PATCH from there.
    assert.deepEqual(calls, [{ method: 'POST' }]);
  });
});

test('ingestAgent: an inconclusive existence check skips creation but still attempts the agentType PATCH', async () => {
  await withTempDir(async () => {
    const calls: { method: string }[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        const method = methodOf(opts);
        if (method === 'GET') throw new Error('ECONNREFUSED');
        calls.push({ method });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestAgent(baseCfg, 'agent-type-id', 'aa-bb-cc-dd-ee-ff', 'alice@example.com'),
    );
    assert.equal(calls.some((c) => c.method === 'POST'), false);
    assert.equal(calls.some((c) => c.method === 'PATCH'), true);
  });
});

// --- MCP servers ------------------------------------------------------------

const mcpIds = { userEntityTypeId: 'user-type-id', mcpServerEntityTypeId: 'mcp-type-id' };
const mcpServers = [
  { name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' },
  { name: 'filesystem' },
];

// Records every call, answering the MCPServer existence GET with `getStatus`
// and every write with `writeStatus`.
function recordingFetch(calls: { method: string; url: string; body?: any }[], getStatus = 404, writeStatus = 200) {
  return (async (url: any, opts: any) => {
    calls.push({ method: opts?.method || 'GET', url, body: opts?.body ? JSON.parse(opts.body) : undefined });
    if ((opts?.method || 'GET') === 'GET') return new Response('', { status: getStatus });
    return new Response(undefined, { status: writeStatus });
  }) as any;
}

test('ingestMcpServers: every server, local or remote, is PATCH-ADDed onto User.registeredMcpServers', async () => {
  await withTempDir(async (dir) => {
    const calls: { method: string; url: string; body?: any }[] = [];
    await withFetch(recordingFetch(calls), () =>
      ingestMcpServers(baseCfg, mcpIds, 'someone@example.com', mcpServers, dir),
    );
    const userPatches = calls.filter((c) => c.method === 'PATCH');
    assert.deepEqual(
      userPatches.map((c) => c.body.attributeValue),
      [
        { name: 'registeredMcpServers', value: 'deepwiki' },
        { name: 'registeredMcpServers', value: 'filesystem' },
      ],
    );
    for (const c of userPatches) {
      assert.ok(c.url.includes('/entity/someone%40example.com?entityTypeId=user-type-id'));
      assert.equal(c.body.op, 'ADD');
    }
  });
});

test('ingestMcpServers: only a remote server gets an MCPServer entity, with its real baseUrl', async () => {
  await withTempDir(async (dir) => {
    const calls: { method: string; url: string; body?: any }[] = [];
    await withFetch(recordingFetch(calls), () =>
      ingestMcpServers(baseCfg, mcpIds, 'someone@example.com', mcpServers, dir),
    );
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1, 'the stdio server must not get a fabricated MCPServer');
    assert.equal(posts[0].body.entityId, 'deepwiki');
    assert.ok(posts[0].url.includes('entityTypeId=mcp-type-id'));
    assert.deepEqual(
      posts[0].body.attributes.find((a: any) => a.name === 'baseUrl'),
      { name: 'baseUrl', value: 'https://mcp.deepwiki.com/mcp' },
    );
  });
});

test('ingestMcpServers: an MCPServer that already exists is not POSTed again', async () => {
  await withTempDir(async (dir) => {
    const calls: { method: string; url: string; body?: any }[] = [];
    await withFetch(recordingFetch(calls, 200), () =>
      ingestMcpServers(baseCfg, mcpIds, 'someone@example.com', mcpServers, dir),
    );
    assert.equal(calls.some((c) => c.method === 'POST'), false);
    // The User side is still written.
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 2);
  });
});

test('ingestMcpServers: a fully registered server is skipped next session; a failed one is retried', async () => {
  await withTempDir(async (dir) => {
    // First session: every write fails.
    await withFetch(recordingFetch([], 404, 500), () =>
      ingestMcpServers(baseCfg, mcpIds, 'someone@example.com', mcpServers, dir),
    );
    // Second session: writes succeed — both must be attempted again.
    const second: { method: string; url: string; body?: any }[] = [];
    await withFetch(recordingFetch(second), () =>
      ingestMcpServers(baseCfg, mcpIds, 'someone@example.com', mcpServers, dir),
    );
    assert.equal(second.filter((c) => c.method === 'PATCH').length, 2);
    // Third session: nothing left to do.
    const third: { method: string; url: string; body?: any }[] = [];
    await withFetch(recordingFetch(third), () =>
      ingestMcpServers(baseCfg, mcpIds, 'someone@example.com', mcpServers, dir),
    );
    assert.equal(third.length, 0);
  });
});

test('ingestMcpServers: done-tracking is per User — another account on this machine gets its own writes', async () => {
  await withTempDir(async (dir) => {
    await withFetch(recordingFetch([]), () =>
      ingestMcpServers(baseCfg, mcpIds, 'first@example.com', mcpServers, dir),
    );
    const calls: { method: string; url: string; body?: any }[] = [];
    await withFetch(recordingFetch(calls), () =>
      ingestMcpServers(baseCfg, mcpIds, 'second@example.com', mcpServers, dir),
    );
    const patched = calls.filter((c) => c.method === 'PATCH').map((c) => c.url);
    assert.equal(patched.length, 2);
    assert.ok(patched.every((u) => u.includes('second%40example.com')));
  });
});

test('ingestMcpServers: no servers configured -> no network call at all', async () => {
  await withTempDir(async (dir) => {
    const calls: { method: string; url: string; body?: any }[] = [];
    await withFetch(recordingFetch(calls), () => ingestMcpServers(baseCfg, mcpIds, 'someone@example.com', [], dir));
    assert.equal(calls.length, 0);
  });
});

test('ingestMcpServers: never throws, even when every request fails at the network level', async () => {
  await withTempDir(async (dir) => {
    await withFetch(
      (async () => {
        throw new TypeError('fetch failed');
      }) as any,
      () => ingestMcpServers(baseCfg, mcpIds, 'someone@example.com', mcpServers, dir),
    );
  });
});


test('with no pluginDataDir, nothing persists — no fallback to a home-directory dotfile', async () => {
  const homeRevaGovernance = path.join(os.homedir(), '.reva-governance');
  const existedBefore = fs.existsSync(homeRevaGovernance);

  // ingestUser()/ingestAgent() have no local cache at all anymore — their
  // GET existence check is the live source of truth every time, with or
  // without a pluginDataDir — so there's nothing to test for either of
  // them here. Only resolveEntityTypeIds() still has a local cache.
  let fetchCount = 0;
  const fetchImpl = (async () => {
    fetchCount++;
    return new Response(JSON.stringify(entityTypesResponse), { status: 200 });
  }) as any;

  const first = await withFetch(fetchImpl, () => resolveEntityTypeIds(baseCfg, undefined));
  assert.equal(first.agentEntityTypeId, 'agent-type-id'); // still resolves for this call...
  const second = await withFetch(fetchImpl, () => resolveEntityTypeIds(baseCfg, undefined));
  assert.equal(second.agentEntityTypeId, 'agent-type-id');
  // ...but a genuine second network fetch happened — nothing was cached
  // without a pluginDataDir to cache it in.
  assert.equal(fetchCount, 2);

  assert.equal(fs.existsSync(homeRevaGovernance), existedBefore);
});

// --- the cache is scoped to one policy store --------------------------------

test('switching policy store or host lands on a different cache file', () => {
  // The cached entity-type ids are UUIDs belonging to ONE store. Reusing
  // them against another store would POST `?entityTypeId=<the old store's
  // User type>` at the new one — a failure at best, a write to the wrong
  // place at worst. Changing either coordinate must miss the cache.
  const a = cacheFile({ ...baseCfg, policyStoreId: 'store-a' }, '/data');
  const b = cacheFile({ ...baseCfg, policyStoreId: 'store-b' }, '/data');
  const otherHost = cacheFile(
    { ...baseCfg, policyStoreId: 'store-a', ingestionUrl: 'https://other.example.com/ingestion/v2' },
    '/data',
  );

  assert.notEqual(a, b, 'a different store must not share a cache file');
  assert.notEqual(a, otherHost, 'a different host must not share a cache file');
  assert.equal(a, cacheFile({ ...baseCfg, policyStoreId: 'store-a' }, '/data'), 'same inputs, same file');
});

test('switching auth token alone (store resolved from the token) lands on a different cache file', async () => {
  // REVA_POLICY_STORE_ID is normally unset — the backend picks the store
  // from the token — so a new store is usually just a new token. Reusing
  // the old token's cached ids would write the User/Agent into the OLD store.
  await withTempDir(async (dir) => {
    const oldToken = { ...baseCfg, authorization: 'token-old-store' };
    const newToken = { ...baseCfg, authorization: 'token-new-store' };
    assert.notEqual(cacheFile(oldToken, dir), cacheFile(newToken, dir));

    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      cacheFile(oldToken, dir)!,
      JSON.stringify({ userEntityTypeId: 'old-user', agentEntityTypeId: 'old-agent', mcpServerEntityTypeId: 'old-mcp' }),
      'utf8',
    );

    const fresh = await withFetch(
      (async () => new Response(JSON.stringify([
        { id: 'new-user', name: 'User', schemaName: 'CodingAgent' },
        { id: 'new-agent', name: 'Agent', schemaName: 'CodingAgent' },
        { id: 'new-mcp', name: 'MCPServer', schemaName: 'CodingAgent' },
      ]), { status: 200 })) as any,
      () => resolveEntityTypeIds(newToken, dir),
    );
    assert.equal(fresh.userEntityTypeId, 'new-user');
    assert.equal(fresh.agentEntityTypeId, 'new-agent');
  });
});

test('a store-scoped cache written for one store is invisible to another', async () => {
  await withTempDir(async (dir) => {
    const storeA = { ...baseCfg, policyStoreId: 'store-a' };
    const storeB = { ...baseCfg, policyStoreId: 'store-b' };

    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      cacheFile(storeA, dir)!,
      JSON.stringify({ userEntityTypeId: 'A-user', agentEntityTypeId: 'A-agent', mcpServerEntityTypeId: 'A-mcp' }),
      'utf8',
    );

    // Store A reads its own cache without a network call at all.
    const fromA = await withFetch(
      (async () => { throw new Error('must not fetch — the cache is fresh'); }) as any,
      () => resolveEntityTypeIds(storeA, dir),
    );
    assert.equal(fromA.userEntityTypeId, 'A-user');

    // Store B must NOT see them, and re-resolves from its own catalog.
    const fromB = await withFetch(
      (async () => new Response(JSON.stringify([
        { id: 'B-user', name: 'User', schemaName: 'CodingAgent' },
        { id: 'B-agent', name: 'Agent', schemaName: 'CodingAgent' },
        { id: 'B-mcp', name: 'MCPServer', schemaName: 'CodingAgent' },
      ]), { status: 200 })) as any,
      () => resolveEntityTypeIds(storeB, dir),
    );
    assert.equal(fromB.userEntityTypeId, 'B-user', 'store B must not inherit store A entity type ids');
  });
});

