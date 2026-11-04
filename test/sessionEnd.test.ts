import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

const ENTRYPOINT = path.join(__dirname, '..', 'src', 'sessionEnd.js');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-sessionend-'));
const CLEAN_ENV = {
  PATH: process.env.PATH || '',
  HOME: TEST_HOME,
  REVA_KIRO_SETTINGS_PATH: path.join(TEST_HOME, 'no-cli.json'),
  REVA_AGENT_ID: 'session-end-test-agent',
  REVA_DATA_DIR: path.join(TEST_HOME, 'data'),
};

function runSessionEnd(stdin: string): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [ENTRYPOINT], {
    input: stdin,
    env: CLEAN_ENV,
    encoding: 'utf8',
    timeout: 5000,
  });
  return { status: result.status, stdout: result.stdout };
}

test('valid Stop input: exits 0 with empty stdout', () => {
  const { status, stdout } = runSessionEnd(
    JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd: '/tmp' }),
  );
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('malformed JSON still exits 0', () => {
  const { status, stdout } = runSessionEnd('{ not valid');
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('empty stdin still exits 0', () => {
  const { status, stdout } = runSessionEnd('');
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

// Kiro fires Stop at the end of every reply, not when a session closes. An
// open session must stay in activeSessionCount after answering — removing it
// here meant a ">= 3 sessions" policy never saw more than 2.
test('Stop keeps every open session counted', () => {
  const { markSessionActive, getActiveSessionCount } = require('../src/activeSessions');
  const dataDir = CLEAN_ENV.REVA_DATA_DIR;
  for (const s of ['open-1', 'open-2', 'open-3']) markSessionActive(CLEAN_ENV.REVA_AGENT_ID, s, 'cli', dataDir);
  for (const s of ['open-1', 'open-2']) {
    const { status } = runSessionEnd(JSON.stringify({ hook_event_name: 'Stop', session_id: s, cwd: '/tmp' }));
    assert.equal(status, 0);
  }
  assert.equal(getActiveSessionCount(CLEAN_ENV.REVA_AGENT_ID, dataDir), 3);
});

// SessionEnd (Kiro desktop app, kiro-cli V3) fires when a session is torn
// down: that session leaves the count, the others stay.
test('SessionEnd removes only the session that closed', () => {
  const { markSessionActive, getActiveSessionCount, getSessionEntry } = require('../src/activeSessions');
  const dataDir = CLEAN_ENV.REVA_DATA_DIR;
  const agent = 'session-end-close-agent';
  const env = { ...CLEAN_ENV, REVA_AGENT_ID: agent };
  for (const s of ['c-1', 'c-2', 'c-3']) markSessionActive(agent, s, 'cli', dataDir);
  const result = spawnSync(process.execPath, [ENTRYPOINT], {
    input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'c-2', cwd: '/tmp', reason: 'other' }),
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(getActiveSessionCount(agent, dataDir), 2);
  assert.equal(getSessionEntry(agent, 'c-2', dataDir), undefined);
});
