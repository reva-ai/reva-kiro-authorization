import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildActionContext,
  buildInvokeAgentContext,
  buildToolResponseTransmission,
  buildTransmission,
  osAttribute,
  serializeToolResponse,
} from '../src/context';
import { CedarActionMapping, CedarHop, DirectEvalConversationMessage } from '../src/types';

const hops: CedarHop[] = [
  {
    seq: 1,
    subject: { type: 'User', id: 'alice' },
    action: { name: 'invokeAgent' },
    resource: { type: 'Agent', id: 'agent-a' },
    time: '2026-08-19T10:00:00Z',
  },
];
const conversationMessages: DirectEvalConversationMessage[] = [
  {
    seq: 1,
    role: 'user',
    contentType: 'text/plain',
    content: 'do the thing',
    timestamp: '2026-08-19T10:00:00Z',
  },
];

const CONTEXT_KEYS = [
  'activeSessionCount', 'sessionId', 'sessionEntryPoint', 'sessionLastSeen', 'agentType', 'machineId', 'os', 'hops', 'timestamp',
].sort();

test('invokeAgent context is timestamp + hops + session scalars + agentType — no prompt (PDP-managed, not client-set)', () => {
  const ctx = buildInvokeAgentContext();
  assert.deepEqual(Object.keys(ctx).sort(), CONTEXT_KEYS);
  assert.equal('prompt' in ctx, false);
  assert.deepEqual(ctx.hops, []);
  assert.equal(ctx.activeSessionCount, 0);
  assert.equal(ctx.sessionId, '');
  assert.equal(ctx.sessionEntryPoint, '');
  assert.equal(ctx.sessionLastSeen, 0);
  assert.equal(ctx.agentType, 'Kiro');
});

test('invokeAgent context carries the current session as flat scalars, plus the aggregate count', () => {
  const currentSession = { sessionId: 's1', entrypoint: 'cli', lastSeen: 1000 };
  const ctx = buildInvokeAgentContext(2, currentSession);
  assert.equal(ctx.activeSessionCount, 2);
  assert.equal(ctx.sessionId, 's1');
  assert.equal(ctx.sessionEntryPoint, 'cli');
  assert.equal(ctx.sessionLastSeen, 1000);
});

test('invokeTool context is timestamp only, no prompt or session', () => {
  const mapping: CedarActionMapping = { actionName: 'invokeTool', resourceType: 'Tool', resourceId: 'WebFetch' };
  const ctx = buildActionContext(mapping);
  assert.deepEqual(Object.keys(ctx).sort(), CONTEXT_KEYS);
  assert.equal('prompt' in ctx, false);
  assert.equal('session' in ctx, false);
});

test('spawn context is scalar policy attributes plus canonical hops, with no nested session record', () => {
  const mapping: CedarActionMapping = { actionName: 'spawn', resourceType: 'SubAgent', resourceId: 'Explore' };
  const ctx = buildActionContext(mapping, { hops });
  assert.deepEqual(Object.keys(ctx).sort(), [...CONTEXT_KEYS, 'subagentIndex'].sort());
  assert.deepEqual(ctx.hops, hops);
  assert.equal('session' in ctx, false);
});

test('executeBash context has scalar action attributes and no managed context record', () => {
  const mapping: CedarActionMapping = {
    actionName: 'executeBash',
    resourceType: 'File',
    resourceId: '/repo/a.ts',
    command: 'cat /repo/a.ts',
  };
  const ctx = buildActionContext(mapping);
  assert.deepEqual(Object.keys(ctx).sort(), [...CONTEXT_KEYS, 'command'].sort());
  assert.equal(ctx.command, 'cat /repo/a.ts');
  assert.equal('session' in ctx, false);
});

test('read/write/edit context is timestamp only — no prompt, session, tool, or command', () => {
  for (const actionName of ['read', 'write', 'edit'] as const) {
    const mapping: CedarActionMapping = {
      actionName,
      resourceType: 'File',
      resourceId: '/repo/a.ts',
      tool: 'Edit',
    };
    const ctx = buildActionContext(mapping);
    assert.deepEqual(Object.keys(ctx).sort(), CONTEXT_KEYS);
    assert.equal('prompt' in ctx, false);
  }
});

test('glob/grep context is timestamp only — no prompt, session, tool, or pattern', () => {
  for (const actionName of ['glob', 'grep'] as const) {
    const mapping: CedarActionMapping = {
      actionName,
      resourceType: 'Directory',
      resourceId: '/repo/src',
      tool: actionName === 'glob' ? 'Glob' : 'Grep',
      pattern: 'TODO',
    };
    const ctx = buildActionContext(mapping);
    assert.deepEqual(Object.keys(ctx).sort(), CONTEXT_KEYS);
    assert.equal('prompt' in ctx, false);
  }
});

test('buildActionContext carries the current session as flat scalars, plus the aggregate count, on every action', () => {
  const currentSession = { sessionId: 's3', entrypoint: 'sdk-cli', lastSeen: 3000 };
  const mapping: CedarActionMapping = { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts' };
  const ctx = buildActionContext(mapping, { activeSessionCount: 3, currentSession });
  assert.equal(ctx.activeSessionCount, 3);
  assert.equal(ctx.sessionId, 's3');
  assert.equal(ctx.sessionEntryPoint, 'sdk-cli');
  assert.equal(ctx.sessionLastSeen, 3000);
});

test('session fields default to empty/0 when not provided', () => {
  const mapping: CedarActionMapping = { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts' };
  const ctx = buildActionContext(mapping);
  assert.equal(ctx.activeSessionCount, 0);
  assert.equal(ctx.sessionId, '');
  assert.equal(ctx.sessionEntryPoint, '');
  assert.equal(ctx.sessionLastSeen, 0);
});

test('agentType is the constant "Kiro" on every action, not runtime-detected', () => {
  const actions: CedarActionMapping[] = [
    { actionName: 'invokeTool', resourceType: 'Tool', resourceId: 'WebFetch' },
    { actionName: 'spawn', resourceType: 'SubAgent', resourceId: 'Explore' },
    { actionName: 'executeBash', resourceType: 'Directory', resourceId: '/repo', command: 'ls' },
    { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts' },
    { actionName: 'glob', resourceType: 'Directory', resourceId: '/repo' },
  ];
  for (const mapping of actions) {
    assert.equal(buildActionContext(mapping).agentType, 'Kiro');
  }
  assert.equal(buildInvokeAgentContext().agentType, 'Kiro');
});

test('timestamp is a Long (epoch milliseconds), not an ISO string, on every action', () => {
  const now = Date.now();
  const actions: CedarActionMapping[] = [
    { actionName: 'invokeTool', resourceType: 'Tool', resourceId: 'WebFetch' },
    { actionName: 'spawn', resourceType: 'SubAgent', resourceId: 'Explore' },
    { actionName: 'executeBash', resourceType: 'Directory', resourceId: '/repo', command: 'ls' },
    { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts' },
    { actionName: 'glob', resourceType: 'Directory', resourceId: '/repo' },
  ];
  for (const mapping of actions) {
    const ts = buildActionContext(mapping).timestamp;
    assert.equal(typeof ts, 'number');
    assert.ok(ts >= now, `timestamp for ${mapping.actionName} should be a recent epoch-ms value`);
  }
  assert.equal(typeof buildInvokeAgentContext().timestamp, 'number');
});

test('prompt is never present in context, on any action — it is PDP-managed, not client-set', () => {
  const invokeTool: CedarActionMapping = { actionName: 'invokeTool', resourceType: 'Tool', resourceId: 'WebFetch' };
  assert.equal('prompt' in buildActionContext(invokeTool), false);

  const bash: CedarActionMapping = { actionName: 'executeBash', resourceType: 'Directory', resourceId: '/repo', command: 'ls' };
  assert.equal('prompt' in buildActionContext(bash), false);

  const read: CedarActionMapping = { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts', tool: 'Read' };
  assert.equal('prompt' in buildActionContext(read), false);

  const spawn: CedarActionMapping = { actionName: 'spawn', resourceType: 'SubAgent', resourceId: 'Explore' };
  assert.equal('prompt' in buildActionContext(spawn), false);

  assert.equal('prompt' in buildInvokeAgentContext(), false);
});

test('spawn context uses the real subagentIndex when provided, defaults to 1 otherwise', () => {
  const mapping: CedarActionMapping = { actionName: 'spawn', resourceType: 'SubAgent', resourceId: 'Explore' };
  assert.equal(buildActionContext(mapping).subagentIndex, 1);
  assert.equal(buildActionContext(mapping, { subagentIndex: 4 }).subagentIndex, 4);
});

test('active-turn evidence uses context.conversation and context.hops with object actions', () => {
  const mapping: CedarActionMapping = { actionName: 'read', resourceType: 'File', resourceId: 'repo/a.ts' };
  const ctx = buildActionContext(mapping, { hops, conversationMessages });
  assert.deepEqual(ctx.hops, hops);
  assert.deepEqual(ctx.conversation, { messages: conversationMessages });
  assert.deepEqual(ctx.hops[0].action, { name: 'invokeAgent' });
});

test('transmission uses canonical dynamic userQuery selector and semantic role', () => {
  assert.deepEqual(buildTransmission('run tests', 'assistant'), {
    promptKey: 'userQuery',
    userQuery: 'run tests',
    role: 'assistant',
    contentType: 'text/plain',
  });
});

test('buildToolResponseTransmission keeps the pre-tool userQuery and puts a JSON tool_response in response', () => {
  const tx = buildToolResponseTransmission({ filePath: '/repo/a.ts', success: true }, 'Edit');
  assert.equal(tx.role, 'tool');
  assert.equal(tx.promptKey, 'userQuery');
  assert.equal(tx.contentType, 'text/plain');
  assert.equal(tx.userQuery, 'Edit');
  assert.equal(tx.response, JSON.stringify({ filePath: '/repo/a.ts', success: true }));
});

test('buildToolResponseTransmission keeps a string tool_response verbatim in response', () => {
  const tx = buildToolResponseTransmission('     1\thello\n', 'Read');
  assert.equal(tx.role, 'tool');
  assert.equal(tx.userQuery, 'Read');
  assert.equal(tx.response, '     1\thello\n');
});

test('serializeToolResponse treats null/undefined as empty string', () => {
  assert.equal(serializeToolResponse(undefined), '');
  assert.equal(serializeToolResponse(null), '');
  assert.equal(buildToolResponseTransmission(undefined, 'Read').userQuery, 'Read');
  assert.equal(buildToolResponseTransmission(undefined, 'Read').response, '');
});

test('serializeToolResponse caps responses at 10000 chars', () => {
  assert.equal(serializeToolResponse('x'.repeat(10000)), 'x'.repeat(10000));
  const long = 'x'.repeat(12000);
  const serialized = serializeToolResponse(long);
  assert.equal(serialized, `${'x'.repeat(10000)}…`);
});

// --- os / machineId --------------------------------------------------------

test('osAttribute reports exactly Windows, macOS or Linux', () => {
  assert.equal(osAttribute('win32'), 'Windows');
  assert.equal(osAttribute('darwin'), 'macOS');
  assert.equal(osAttribute('linux'), 'Linux');
  // Any other Unix-like platform uses POSIX shell commands, like Linux.
  assert.equal(osAttribute('freebsd'), 'Linux');
});

test('os is sent on every action and on invokeAgent, matching this machine', () => {
  const expected = osAttribute();
  for (const actionName of ['invokeTool', 'spawn', 'executeBash', 'read', 'write', 'edit', 'glob', 'grep'] as const) {
    const mapping: CedarActionMapping = { actionName, resourceType: 'File', resourceId: 'r/a' };
    assert.equal(buildActionContext(mapping).os, expected, actionName);
  }
  assert.equal(buildInvokeAgentContext().os, expected);
});

test('machineId is sent on every action and on invokeAgent, empty rather than invented when unknown', () => {
  const mapping: CedarActionMapping = { actionName: 'read', resourceType: 'File', resourceId: 'r/a' };
  assert.equal(buildActionContext(mapping, { machineId: 'machine-1' }).machineId, 'machine-1');
  assert.equal(buildActionContext(mapping).machineId, '');
  assert.equal(buildInvokeAgentContext(0, undefined, undefined, 'machine-1').machineId, 'machine-1');
});

test('model is always sent when resolved, and left out when Kiro gave none — there is no switch', () => {
  assert.equal(buildInvokeAgentContext(0, undefined, 'claude-sonnet-4.5').model, 'claude-sonnet-4.5');
  assert.equal(buildActionContext({ actionName: 'read' } as any, { model: 'auto' }).model, 'auto');
  assert.equal('model' in buildInvokeAgentContext(), false);
  assert.equal('model' in buildActionContext({ actionName: 'read' } as any, {}), false);
});
