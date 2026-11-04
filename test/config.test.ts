import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_HOST, loadConfig } from '../src/config';

// REVA_AGENT_ID is pinned here so every test below is independent of
// resolveAgentId() (see deviceId.ts — currently always undefined, since no
// Kiro account-id source is confirmed/wired in yet). The dedicated "missing
// agentId" test further down deliberately omits it instead.
const TOKEN_ENV = { REVA_AUTH_TOKEN: 'auth-token', REVA_AGENT_ID: 'agent-a' };

test('uses the default auth host when REVA_HOST is unset', () => {
  const cfg = loadConfig(TOKEN_ENV);
  assert.equal(cfg.pdpUrl, `https://${DEFAULT_HOST}/pdp/v2/ai/evaluation`);
  assert.equal(cfg.ingestionUrl, `https://${DEFAULT_HOST}/ingestion/v2`);
});

test('REVA_HOST overrides the default host', () => {
  const cfg = loadConfig({
    ...TOKEN_ENV,
    REVA_HOST: 'localhost:8787',
  });
  assert.equal(cfg.pdpUrl, 'http://localhost:8787/pdp/v2/ai/evaluation');
  assert.equal(cfg.ingestionUrl, 'http://localhost:8787/ingestion/v2');
});

test('throws when REVA_AUTH_TOKEN is missing', () => {
  assert.throws(() => loadConfig({}), /REVA_AUTH_TOKEN/);
});

test('a single auth token authenticates both evaluation and ingestion — no separate ingestion token', () => {
  const cfg = loadConfig(TOKEN_ENV);
  assert.equal(cfg.authorization, 'auth-token');
  assert.ok(!('ingestionToken' in cfg));
});

test('REVA_HOST uses https for non-local hosts', () => {
  const cfg = loadConfig({
    ...TOKEN_ENV,
    REVA_HOST: 'api.example.reva.ai',
  });
  assert.equal(cfg.pdpUrl, 'https://api.example.reva.ai/pdp/v2/ai/evaluation');
  assert.equal(cfg.ingestionUrl, 'https://api.example.reva.ai/ingestion/v2');
});

test('timeouts still have working defaults — not part of the required/error-if-missing set', () => {
  const cfg = loadConfig(TOKEN_ENV);
  assert.equal(cfg.timeoutMs, 25000);
  assert.equal(cfg.ingestionTimeoutMs, 5000);
});

test('agentId resolves from REVA_AGENT_ID', () => {
  const cfg = loadConfig(TOKEN_ENV);
  assert.equal(cfg.agentId, 'agent-a');
});

// UNCONFIRMED FOR KIRO note: this always throws today, for every machine,
// resolveAgentId() now has a real source (`kiro-cli whoami`), so whether
// this throws depends on whether the machine running the tests happens to
// be logged into Kiro. Assert the property that holds either way: the agent
// id is never silently invented. Either it resolves to an account-scoped
// id, or loading fails loudly naming REVA_AGENT_ID.
test('never invents an agent id: resolves an account-scoped one, or fails loudly', () => {
  let cfg;
  try {
    cfg = loadConfig({ REVA_AUTH_TOKEN: 'auth-token' });
  } catch (err: any) {
    assert.match(err.message, /REVA_AGENT_ID/);
    return;
  }
  // The Kiro account's own user UUID — and specifically NOT the account
  // email, which is what the User/principal uses.
  assert.match(cfg.agentId, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, `expected the account UUID, got ${cfg.agentId}`);
  assert.ok(!cfg.agentId.includes('@'));
});

// --- policy store id -------------------------------------------------------
//
// Optional by design. No known Reva deployment needs one on the wire — the
// store is resolved from the auth token — so the default must be "send
// nothing", and setting it must never be required.

test('no policy store id by default — nothing is sent', () => {
  const cfg = loadConfig({ REVA_AUTH_TOKEN: 'auth-token', REVA_AGENT_ID: 'agent-1' });
  assert.equal(cfg.policyStoreId, '');
});

test('REVA_POLICY_STORE_ID is read, and the header name defaults', () => {
  const cfg = loadConfig({
    REVA_AUTH_TOKEN: 'auth-token',
    REVA_AGENT_ID: 'agent-1',
    REVA_POLICY_STORE_ID: '22222222-2222-4222-8222-222222222222',
  });
  assert.equal(cfg.policyStoreId, '22222222-2222-4222-8222-222222222222');
  assert.equal(cfg.policyStoreHeader, 'policyStoreId');
});

test('the header NAME is overridable without a code change', () => {
  // The name is an unconfirmed assumption (see config.ts). Making it
  // settable is what keeps a wrong guess from requiring a rebuild.
  const cfg = loadConfig({
    REVA_AUTH_TOKEN: 'auth-token',
    REVA_AGENT_ID: 'agent-1',
    REVA_POLICY_STORE_ID: 'store-1',
    REVA_POLICY_STORE_HEADER: 'X-Reva-Store',
  });
  assert.equal(cfg.policyStoreHeader, 'X-Reva-Store');
});

test('surrounding whitespace is trimmed off the store id', () => {
  // Pasting an id out of a UI very often brings a trailing space with it,
  // and a header value with one would not match server-side.
  const cfg = loadConfig({
    REVA_AUTH_TOKEN: 'auth-token',
    REVA_AGENT_ID: 'agent-1',
    REVA_POLICY_STORE_ID: '  store-1  ',
  });
  assert.equal(cfg.policyStoreId, 'store-1');
});

test('a blank policy store id is treated as unset, not as an empty header', () => {
  const cfg = loadConfig({
    REVA_AUTH_TOKEN: 'auth-token',
    REVA_AGENT_ID: 'agent-1',
    REVA_POLICY_STORE_ID: '   ',
  });
  assert.equal(cfg.policyStoreId, '');
});

