import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInvokeAgentRequest } from '../src/invokeAgent';
import { DirectEvalSession } from '../src/types';

const session: DirectEvalSession = { id: '33333333-3333-4333-8333-333333333333' };

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
  assert.equal('hops' in request.context, false);
  assert.equal('conversation' in request.context, false);
  assert.deepEqual(request.session, session);
  assert.deepEqual(Object.keys(request.session), ['id']);
  assert.equal('entities' in request, false);
  assert.equal('hops' in request, false);
});

test('buildInvokeAgentRequest never fabricates a current prompt', () => {
  assert.throws(
    () => buildInvokeAgentRequest('alice@example.com', 'agent-a', '', session),
    /nonblank current prompt/,
  );
});
