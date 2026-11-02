import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { nextSpawnIndex, reserveSpawnIndices, resetSpawnCounter } from '../src/spawnCounter';

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-spawn-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('first spawn in a session is index 1', () => {
  withTempDir((dir) => {
    assert.equal(nextSpawnIndex('sess-1', dir), 1);
  });
});

test('successive spawns in the same session increment', () => {
  withTempDir((dir) => {
    assert.equal(nextSpawnIndex('sess-1', dir), 1);
    assert.equal(nextSpawnIndex('sess-1', dir), 2);
    assert.equal(nextSpawnIndex('sess-1', dir), 3);
  });
});

test('different sessions have independent counters', () => {
  withTempDir((dir) => {
    assert.equal(nextSpawnIndex('sess-a', dir), 1);
    assert.equal(nextSpawnIndex('sess-a', dir), 2);
    assert.equal(nextSpawnIndex('sess-b', dir), 1);
  });
});

test('resetSpawnCounter brings the next spawn back to index 1 — a new turn is not a continuation of the last', () => {
  withTempDir((dir) => {
    assert.equal(nextSpawnIndex('sess-1', dir), 1);
    assert.equal(nextSpawnIndex('sess-1', dir), 2);
    assert.equal(nextSpawnIndex('sess-1', dir), 3);
    resetSpawnCounter('sess-1', dir);
    assert.equal(nextSpawnIndex('sess-1', dir), 1);
    assert.equal(nextSpawnIndex('sess-1', dir), 2);
  });
});

test('resetSpawnCounter on a session that never spawned anything is a harmless no-op', () => {
  withTempDir((dir) => {
    resetSpawnCounter('sess-never-spawned', dir);
    assert.equal(nextSpawnIndex('sess-never-spawned', dir), 1);
  });
});

test('resetSpawnCounter only affects the given session, not others', () => {
  withTempDir((dir) => {
    assert.equal(nextSpawnIndex('sess-a', dir), 1);
    assert.equal(nextSpawnIndex('sess-a', dir), 2);
    assert.equal(nextSpawnIndex('sess-b', dir), 1);
    assert.equal(nextSpawnIndex('sess-b', dir), 2);
    resetSpawnCounter('sess-a', dir);
    assert.equal(nextSpawnIndex('sess-a', dir), 1);
    // sess-b is untouched by resetting sess-a
    assert.equal(nextSpawnIndex('sess-b', dir), 3);
  });
});

test('with no pluginDataDir, nextSpawnIndex still returns a usable value but never persists — no fallback to a home-directory dotfile', () => {
  const homeRevaGovernance = path.join(os.homedir(), '.reva-governance');
  const existedBefore = fs.existsSync(homeRevaGovernance);

  assert.equal(nextSpawnIndex('sess-1', undefined), 1);
  assert.equal(nextSpawnIndex('sess-1', undefined), 1); // still 1 — nothing to increment from
  resetSpawnCounter('sess-1', undefined); // no-op, must not throw

  assert.equal(fs.existsSync(homeRevaGovernance), existedBefore);
});

test('reserveSpawnIndices claims consecutive numbers that continue the turn, and resets with the turn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-spawn-reserve-'));
  try {
    assert.deepEqual(reserveSpawnIndices('s', 4, dir), [1, 2, 3, 4]);
    assert.deepEqual(reserveSpawnIndices('s', 2, dir), [5, 6]);
    assert.equal(nextSpawnIndex('s', dir), 7);
    resetSpawnCounter('s', dir);
    assert.deepEqual(reserveSpawnIndices('s', 3, dir), [1, 2, 3]);
    assert.deepEqual(reserveSpawnIndices('s', 0, dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
