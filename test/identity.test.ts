import assert from 'node:assert/strict';
import * as os from 'node:os';
import { test } from 'node:test';
import { resolveAgentContext, resolveUserEmail } from '../src/identity';

// The principal is the Kiro login email (readKiroAccountEmail() in
// deviceId.ts, which parses `kiro-cli whoami`) — see deviceId.test.ts.
test('resolveUserEmail prefers the Kiro login email over the OS username', () => {
  assert.equal(
    resolveUserEmail(() => `Logged in with Google
Email: someone@example.com
`),
    'someone@example.com',
  );
});

test('resolveUserEmail falls back to the OS username only when no account is logged in', () => {
  const notLoggedIn = () => { throw new Error('kiro-cli: command not found'); };
  assert.equal(resolveUserEmail(notLoggedIn), os.userInfo().username);
});

test('resolveAgentContext: no agent_id means a top-level session call, not a sub-agent', () => {
  const ctx = resolveAgentContext('agent-a', {});
  assert.equal(ctx.agentId, 'agent-a');
  assert.equal(ctx.isSubAgent, false);
  assert.equal(ctx.subAgentId, undefined);
});

// Confirmed ABSENT from both hosts' real payloads today — this pins the
// shape so a host version that starts sending it works with no change.
test('resolveAgentContext: a present agent_id means a sub-agent call', () => {
  const ctx = resolveAgentContext('agent-a', { agent_id: 'sub-1', agent_type: 'Explore' });
  assert.equal(ctx.isSubAgent, true);
  assert.equal(ctx.subAgentId, 'sub-1');
  assert.equal(ctx.subAgentType, 'Explore');
});

// --- the principal, and how it degrades ------------------------------------
//
// `kiro-cli whoami` can take ~11s. If its timeout budget is too short, the
// OS-username fallback silently takes over and every request is evaluated
// against a `User` that was never provisioned. A wide-open
// `permit(principal, action, resource)` still denies everything, because
// ingestion creates an unknown User with active="false".

test('the principal is the Kiro login email whenever one can be resolved', () => {
  assert.equal(
    resolveUserEmail(() => `Logged in with Google
Email: someone@example.com
`),
    'someone@example.com',
  );
});

test('the OS username is used only when no account can be established at all', () => {
  const boom = () => { throw new Error('kiro-cli: command not found'); };
  assert.equal(resolveUserEmail(boom), os.userInfo().username);
});
