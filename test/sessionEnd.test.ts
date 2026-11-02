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
