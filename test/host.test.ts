import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocksAt, detectHost, normalizeInput, sessionEntrypoint } from '../src/host';

// Every payload below is a real one, captured from real sessions:
//  - IDE shapes from the payload builder in the installed
//    kiro.kiro-agent/dist/extension.js
//  - CLI shapes from real `kiro-cli chat` sessions
// If a future Kiro version changes either, these are the tests that should
// fail first.

const IDE_PRE_TOOL_USE = {
  session_id: '44444444-4444-4444-8444-444444444444',
  hook_event_name: 'PreToolUse',
  cwd: 'C:\\repo',
  tool_name: 'fsWrite',
  tool_input: { path: 'C:\\repo\\a.txt' },
};

const CLI_PRE_TOOL_USE = {
  hook_event_name: 'preToolUse',
  cwd: 'C:\\repo',
  tool_name: 'fs_read',
  tool_input: { operations: [{ mode: 'Line', path: 'C:\\repo\\package.json' }] },
};

test('detectHost reads the host off the trigger name casing', () => {
  assert.deepEqual(detectHost(IDE_PRE_TOOL_USE, 'PreToolUse', {}), { host: 'kiro-ide', event: 'PreToolUse' });
  assert.deepEqual(detectHost(CLI_PRE_TOOL_USE, 'PreToolUse', {}), { host: 'kiro-cli', event: 'PreToolUse' });
});

test('detectHost maps every kiro-cli trigger onto its canonical IDE name', () => {
  const cases: [string, string][] = [
    ['agentSpawn', 'SessionStart'],
    ['userPromptSubmit', 'UserPromptSubmit'],
    ['preToolUse', 'PreToolUse'],
    ['postToolUse', 'PostToolUse'],
  ];
  for (const [cli, canonical] of cases) {
    const got = detectHost({ hook_event_name: cli }, 'PreToolUse', {});
    assert.equal(got.host, 'kiro-cli');
    assert.equal(got.event, canonical, `${cli} should canonicalize to ${canonical}`);
  }
});

test('detectHost falls back to the entrypoint’s own event when the name is unrecognized', () => {
  // "PromptSubmit" is what kiro.dev's docs call the IDE trigger; the real
  // loader rejects it. A payload carrying it must not be silently treated
  // as some other event.
  const got = detectHost({ hook_event_name: 'PromptSubmit', session_id: 's1' }, 'UserPromptSubmit', {});
  assert.equal(got.event, 'UserPromptSubmit');
  assert.equal(got.host, 'kiro-ide');
});

test('detectHost with no trigger name uses KIRO_SESSION_ID to tell the hosts apart', () => {
  assert.equal(detectHost({}, 'PreToolUse', { KIRO_SESSION_ID: 'abc' } as any).host, 'kiro-cli');
  assert.equal(detectHost({ session_id: 's1' }, 'PreToolUse', {} as any).host, 'kiro-ide');
});

test('normalizeInput takes the IDE session id from the payload', () => {
  const n = normalizeInput(IDE_PRE_TOOL_USE, 'PreToolUse', {});
  assert.equal(n.host, 'kiro-ide');
  assert.equal(n.sessionId, '44444444-4444-4444-8444-444444444444');
  assert.equal(n.toolName, 'fsWrite');
});

test('normalizeInput takes the kiro-cli session id from KIRO_SESSION_ID', () => {
  // This is the whole reason host.ts exists: kiro-cli sends no session_id
  // in the payload at all, and every cache in this plugin is keyed by it.
  const n = normalizeInput(CLI_PRE_TOOL_USE, 'PreToolUse', { KIRO_SESSION_ID: 'cli-session-1' } as any);
  assert.equal(n.host, 'kiro-cli');
  assert.equal(n.sessionId, 'cli-session-1');
  assert.deepEqual(n.toolInput, { operations: [{ mode: 'Line', path: 'C:\\repo\\package.json' }] });
});

test('normalizeInput leaves sessionId empty rather than fabricating one', () => {
  const n = normalizeInput({ hook_event_name: 'preToolUse', cwd: '.' }, 'PreToolUse', {} as any);
  assert.equal(n.sessionId, '');
});

test('normalizeInput defaults toolInput to an object so callers never guard for null', () => {
  const n = normalizeInput({ hook_event_name: 'preToolUse', tool_name: 'glob' }, 'PreToolUse', {} as any);
  assert.deepEqual(n.toolInput, {});
});

test('normalizeInput carries the prompt for both hosts’ prompt triggers', () => {
  const ide = normalizeInput(
    { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '.', prompt: 'hi' },
    'UserPromptSubmit',
    {} as any,
  );
  const cli = normalizeInput(
    { hook_event_name: 'userPromptSubmit', cwd: '.', prompt: 'hi' },
    'UserPromptSubmit',
    {} as any,
  );
  assert.equal(ide.prompt, 'hi');
  assert.equal(cli.prompt, 'hi');
});

test('blocksAt reports enforcement honestly per host and event', () => {
  // IDE: confirmed in the shipped dispatcher.
  assert.equal(blocksAt('kiro-ide', 'PreToolUse'), true);
  assert.equal(blocksAt('kiro-ide', 'UserPromptSubmit'), true);
  assert.equal(blocksAt('kiro-ide', 'PostToolUse'), false);
  // CLI: blocks once the Windows exit-code suffix is installed — confirmed
  // live on 2.36.0 (an always-deny hook stopped `Remove-Item`; the same hook
  // without the suffix did not). Post-tool-use is still audit-only.
  assert.equal(blocksAt('kiro-cli', 'PreToolUse'), true);
  assert.equal(blocksAt('kiro-cli', 'UserPromptSubmit'), true);
  assert.equal(blocksAt('kiro-cli', 'PostToolUse'), false);
});

// --- session entrypoint ------------------------------------------------------

test('session entrypoint: kiro-cli -> cli, Kiro IDE -> ide-kiro', () => {
  assert.equal(sessionEntrypoint('kiro-cli', {}), 'cli');
  assert.equal(sessionEntrypoint('kiro-ide', {}), 'ide-kiro');
});

test('REVA_SESSION_ENTRYPOINT names the surface explicitly when set', () => {
  assert.equal(sessionEntrypoint('kiro-cli', { REVA_SESSION_ENTRYPOINT: 'ci-runner' }), 'ci-runner');
  assert.equal(sessionEntrypoint('kiro-ide', { REVA_SESSION_ENTRYPOINT: '   ' }), 'ide-kiro');
});
