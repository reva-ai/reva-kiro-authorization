import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

// SessionStart has no blocking/decision control at all — sessionStart.ts
// must always exit 0 with empty stdout, no matter what. Exercised as a real
// subprocess (not a unit test of internal functions) because the contract
// that actually matters here is the process's exit code and stdout, which
// is exactly what Kiro itself observes.
//
// Runs with a deliberately clean, minimal env — no REVA_AUTH_TOKEN — so
// this never makes a real network call regardless of what's set in the
// developer's own shell.
//
// REVA_AGENT_ID is pinned for the same reason: without it, resolveAgentId()
// shells out to `kiro-cli whoami`, which is a real external command whose
// latency this test would then depend on. That is not hypothetical — it was
// measured at >10s on a machine whose Kiro credentials needed refreshing,
// which blew this test's own 5s timeout and made it fail with a null exit
// code. A test asserting an exit-code contract must not be gated on how
// fast an unrelated CLI happens to answer.
//
// REVA_DATA_DIR points at a throwaway directory so the run never reads or
// writes the developer's real account cache.
//
// PATH holds only node's own directory, so kiro-cli is not resolvable. Session
// start otherwise asks `kiro-cli chat --list-models` for Kiro's default model
// (~2.4s, more under a parallel test run), which blew the 5s timeout the same
// way whoami did.
const ENTRYPOINT = path.join(__dirname, '..', 'src', 'sessionStart.js');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-sessionstart-'));
const CLEAN_ENV = {
  PATH: path.dirname(process.execPath),
  HOME: TEST_HOME,
  // Keep applyKiroCliEnv from reading the developer's real
  // ~/.kiro/settings/cli.json (which often has REVA_AUTH_TOKEN) — without
  // this the "not configured" case below would hit the network and time out.
  REVA_KIRO_SETTINGS_PATH: path.join(TEST_HOME, 'no-cli.json'),
  REVA_AGENT_ID: 'session-start-test-agent',
  REVA_DATA_DIR: path.join(TEST_HOME, 'data'),
};

function runSessionStart(stdin: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [ENTRYPOINT], {
    input: stdin,
    env: CLEAN_ENV,
    encoding: 'utf8',
    timeout: 5000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('valid input, plugin not configured at all: exits 0 with empty stdout', () => {
  const { status, stdout } = runSessionStart(JSON.stringify({ session_id: 's1', cwd: '/tmp', source: 'startup' }));
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('malformed JSON on stdin: still exits 0 with empty stdout, never throws uncaught', () => {
  const { status, stdout } = runSessionStart('{ not valid json');
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('empty stdin: still exits 0 with empty stdout', () => {
  const { status, stdout } = runSessionStart('');
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('missing fields entirely (bare {}): still exits 0 with empty stdout', () => {
  const { status, stdout } = runSessionStart('{}');
  assert.equal(status, 0);
  assert.equal(stdout, '');
});
