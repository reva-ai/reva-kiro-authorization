import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { isCircuitOpen, openCircuit } from '../src/pdpCircuitBreaker';

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-circuit-breaker-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cacheFile(dir: string, sessionId: string): string {
  return path.join(dir, 'pdp-circuit-breaker', `${sessionId}.json`);
}

test('a session that has never seen a 401 is closed', () => {
  withTempDir((dir) => {
    assert.equal(isCircuitOpen('sess-1', dir).open, false);
  });
});

test('openCircuit latches that session, carrying status and errorType through', () => {
  withTempDir((dir) => {
    openCircuit('sess-1', 401, 'UNAUTHORIZED', dir);
    const status = isCircuitOpen('sess-1', dir);
    assert.equal(status.open, true);
    assert.equal(status.triggeredStatus, 401);
    assert.equal(status.errorType, 'UNAUTHORIZED');
  });
});

test('the latch NEVER expires — openedAt is recorded but never compared to the clock', () => {
  withTempDir((dir) => {
    const file = cacheFile(dir, 'sess-old');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        openedAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
        triggeredStatus: 401,
        errorType: 'UNAUTHORIZED',
      }),
      'utf8',
    );
    assert.equal(isCircuitOpen('sess-old', dir).open, true);
  });
});

test('a DIFFERENT session is unaffected — this is the recovery path', () => {
  withTempDir((dir) => {
    openCircuit('sess-broken', 401, 'UNAUTHORIZED', dir);
    assert.equal(isCircuitOpen('sess-broken', dir).open, true);
    assert.equal(isCircuitOpen('sess-fresh', dir).open, false);
  });
});

test('an unreadable latch reads as CLOSED, so the PDP is called rather than skipped', () => {
  withTempDir((dir) => {
    const file = cacheFile(dir, 'sess-corrupt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not-json', 'utf8');
    assert.equal(isCircuitOpen('sess-corrupt', dir).open, false);
  });
});
