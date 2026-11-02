import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInvokeAgentRequest } from '../src/invokeAgent';
import { DirectEvalSession } from '../src/types';

const session: DirectEvalSession = {
  id: '33333333-3333-4333-8333-333333333333',
  turn: 3,
  startedAt: '2026-08-14T09:57:30Z',
};

test('buildInvokeAgentRequest emits the canonical direct-AI User to Agent envelope', () => {
  const request = buildInvokeAgentRequest('alice@example.com', 'agent-a', 'hello', session);

  assert.deepEqual(request.subject, { type: 'User', id: 'alice@example.com' });
  assert.deepEqual(request.principal, request.subject);
  assert.deepEqual(request.action, { name: 'invokeAgent' });
  assert.deepEqual(request.resource, { type: 'Agent', id: 'agent-a' });
  assert.deepEqual(request.transmission, {
    promptKey: 'userQuery',
    userQuery: 'hello',
    role: 'user',
    contentType: 'text/plain',
  });
  assert.deepEqual(request.context.hops, []);
  assert.deepEqual(request.session, session);
  assert.equal('messages' in request.session, false);
  assert.equal('entities' in request, false);
  assert.equal('hops' in request, false);
});

test('buildInvokeAgentRequest never fabricates a current prompt', () => {
  assert.throws(
    () => buildInvokeAgentRequest('alice@example.com', 'agent-a', '', session),
    /nonblank current prompt/,
  );
});
