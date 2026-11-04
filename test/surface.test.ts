import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { markSessionActive } from '../src/activeSessions';
import { AncestorProcess, nearestKiroProcess, resolveSessionEntrypoint, resolveSessionSurface, surfaceFromAncestors, surfaceFromProcess } from '../src/surface';

// Paths as Get-CimInstance (Windows) and `ps -o comm=` (macOS) report them.
const WIN_KIRO_CLI = 'C:\\Users\\dev\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe';
const WIN_KIRO_CLI_NODE = 'C:\\Users\\dev\\AppData\\Local\\Kiro-Cli\\node.exe';
const WIN_CHAT_CLI = 'C:\\Users\\dev\\AppData\\Local\\Kiro-Cli\\run\\chat-cli-2.37.1.exe';
const WIN_KIRO_APP = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Kiro\\Kiro.exe';
const MAC_KIRO_HELPER = '/Applications/Kiro.app/Contents/Frameworks/Kiro Helper (Plugin).app/Contents/MacOS/Kiro Helper (Plugin)';
const MAC_KIRO_CLI = '/Users/dev/.local/bin/kiro-cli';
const MAC_KIRO_CLI_CHAT = '/Users/dev/.local/bin/kiro-cli-chat';

test('surfaceFromProcess: kiro-cli and everything in its install folder is cli', () => {
  for (const p of [WIN_KIRO_CLI, WIN_KIRO_CLI_NODE, WIN_CHAT_CLI, MAC_KIRO_CLI, MAC_KIRO_CLI_CHAT, 'kiro-cli']) {
    assert.equal(surfaceFromProcess(p), 'cli', p);
  }
});

test('surfaceFromProcess: the Kiro app and its macOS helpers are desktop', () => {
  for (const p of [WIN_KIRO_APP, MAC_KIRO_HELPER, '/usr/share/kiro/kiro', 'Kiro.exe']) {
    assert.equal(surfaceFromProcess(p), 'desktop', p);
  }
});

test('surfaceFromProcess: anything that is not a Kiro product is never guessed', () => {
  for (const p of ['C:\\Windows\\System32\\cmd.exe', 'powershell.exe', '/bin/zsh', 'C:\\Program Files\\nodejs\\node.exe', '', undefined]) {
    assert.equal(surfaceFromProcess(p), undefined, String(p));
  }
});

test('surfaceFromAncestors: the nearest Kiro product wins — kiro-cli run in the app\'s terminal is cli', () => {
  assert.equal(surfaceFromAncestors(['cmd.exe', WIN_KIRO_CLI_NODE, WIN_KIRO_CLI, 'powershell.exe', WIN_KIRO_APP]), 'cli');
  assert.equal(surfaceFromAncestors(['cmd.exe', WIN_KIRO_APP]), 'desktop');
  assert.equal(surfaceFromAncestors(['/bin/sh', MAC_KIRO_HELPER, '/Applications/Kiro.app/Contents/MacOS/Kiro']), 'desktop');
  assert.equal(surfaceFromAncestors(['cmd.exe', 'explorer.exe']), undefined);
  assert.equal(surfaceFromAncestors([]), undefined);
});

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reva-surface-'));
}

const base = { agentId: 'agent-1', env: {} as NodeJS.ProcessEnv };

// Ancestors as listAncestorProcesses returns them: nearest first, pids 101, 102, ...
function procs(...names: string[]): AncestorProcess[] {
  return names.map((name, i) => ({ pid: 101 + i, name }));
}

test('resolveSessionEntrypoint: kiro-cli V3 (IDE-shaped payload, kiro-cli parent) -> cli', () => {
  const pluginDataDir = tempDataDir();
  const got = resolveSessionEntrypoint({
    ...base, host: 'kiro-ide', sessionId: 'sess_v3', pluginDataDir,
    listAncestors: () => procs('cmd.exe', WIN_KIRO_CLI_NODE, WIN_KIRO_CLI, 'powershell.exe'),
  });
  assert.equal(got, 'cli');
});

test('resolveSessionEntrypoint: the Kiro app -> Kiro Desktop', () => {
  const pluginDataDir = tempDataDir();
  const got = resolveSessionEntrypoint({
    ...base, host: 'kiro-ide', sessionId: 'sess_app', pluginDataDir,
    listAncestors: () => procs('cmd.exe', WIN_KIRO_APP),
  });
  assert.equal(got, 'Kiro Desktop');
});

test('resolveSessionEntrypoint: no Kiro process found (or the lookup failed) -> Kiro Desktop, as before', () => {
  const pluginDataDir = tempDataDir();
  const got = resolveSessionEntrypoint({ ...base, host: 'kiro-ide', sessionId: 'sess_x', pluginDataDir, listAncestors: () => [] });
  assert.equal(got, 'Kiro Desktop');
});

test('resolveSessionEntrypoint: kiro-cli 2.x is settled by its payload — no process lookup', () => {
  const got = resolveSessionEntrypoint({
    ...base, host: 'kiro-cli', sessionId: 's', listAncestors: () => assert.fail('lookup must not run'),
  });
  assert.equal(got, 'cli');
});

test('resolveSessionEntrypoint: REVA_SESSION_ENTRYPOINT wins — no process lookup', () => {
  const got = resolveSessionEntrypoint({
    ...base, env: { REVA_SESSION_ENTRYPOINT: 'ci-runner' }, host: 'kiro-ide', sessionId: 's',
    listAncestors: () => assert.fail('lookup must not run'),
  });
  assert.equal(got, 'ci-runner');
});

test('resolveSessionEntrypoint: once a session is resolved, later hooks reuse it — one lookup per session', () => {
  const pluginDataDir = tempDataDir();
  markSessionActive('agent-1', 'sess_v3', 'cli', pluginDataDir);
  const got = resolveSessionEntrypoint({
    ...base, host: 'kiro-ide', sessionId: 'sess_v3', pluginDataDir,
    listAncestors: () => assert.fail('lookup must not run again'),
  });
  assert.equal(got, 'cli');
});

test('nearestKiroProcess: a kiro-cli session keeps the id of its nearest kiro-cli process; the app keeps none', () => {
  // Live V3 chain: cmd < node (Kiro-Cli) < kiro-cli chat < bun < kiro-cli < powershell
  assert.deepEqual(nearestKiroProcess(procs('cmd.exe', WIN_KIRO_CLI_NODE, WIN_KIRO_CLI, 'powershell.exe')), { surface: 'cli', pid: 102 });
  // Every Kiro desktop chat shares one Kiro.exe — its id says nothing about one chat.
  assert.deepEqual(nearestKiroProcess(procs('cmd.exe', WIN_KIRO_APP)), { surface: 'desktop' });
  assert.deepEqual(nearestKiroProcess([]), {});
});

test('resolveSessionSurface: the kiro-cli pid is returned only from a fresh lookup', () => {
  const pluginDataDir = tempDataDir();
  const fresh = resolveSessionSurface({
    ...base, host: 'kiro-ide', sessionId: 'sess_pid', pluginDataDir,
    // A real, running process: a stored pid that has exited drops the session.
    listAncestors: () => [{ pid: 1, name: 'cmd.exe' }, { pid: process.pid, name: WIN_KIRO_CLI_NODE }],
  });
  assert.deepEqual(fresh, { entrypoint: 'cli', pid: process.pid });
  markSessionActive('agent-1', 'sess_pid', fresh.entrypoint, pluginDataDir, fresh.pid);
  const reused = resolveSessionSurface({
    ...base, host: 'kiro-ide', sessionId: 'sess_pid', pluginDataDir,
    listAncestors: () => assert.fail('lookup must not run again'),
  });
  assert.deepEqual(reused, { entrypoint: 'cli' });
});
