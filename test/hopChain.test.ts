import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  enqueuePendingSpawnLineage,
  loadAgentHops,
  resolveSubAgentLineage,
  startTurnHops,
} from '../src/hopChain';
import { CedarHop } from '../src/types';

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-hops-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const invokeAgentHop: CedarHop = {
  seq: 1,
  subject: { type: 'User', id: 'alice@example.com' },
  action: { name: 'invokeAgent' },
  resource: { type: 'Agent', id: 'machine-1' },
  time: '2026-01-01T00:00:00.000Z',
};

test('loadAgentHops returns [] before any turn has started', () => {
  withTempDir((dir) => {
    assert.deepEqual(loadAgentHops('session-1', dir), []);
  });
});

test('startTurnHops seeds machineHops with the invokeAgent hop', () => {
  withTempDir((dir) => {
    startTurnHops('session-1', invokeAgentHop, dir);
    assert.deepEqual(loadAgentHops('session-1', dir), [invokeAgentHop]);
  });
});

test('resolveSubAgentLineage returns [] when nothing is pending', () => {
  withTempDir((dir) => {
    startTurnHops('session-1', invokeAgentHop, dir);
    assert.deepEqual(resolveSubAgentLineage('session-1', 'subagent-a', dir), []);
  });
});

test('a spawned subagent inherits the spawner lineage plus the spawn hop', () => {
  withTempDir((dir) => {
    startTurnHops('session-1', invokeAgentHop, dir);
    const parentLineage = loadAgentHops('session-1', dir);
    const spawnHop: CedarHop = {
      seq: 2,
      subject: { type: 'Agent', id: 'machine-1' },
      action: { name: 'spawn' },
      resource: { type: 'SubAgent', id: 'Explore' },
      time: '2026-01-01T00:00:01.000Z',
    };
    enqueuePendingSpawnLineage('session-1', parentLineage, spawnHop, dir);

    const lineage = resolveSubAgentLineage('session-1', 'subagent-a', dir);
    assert.deepEqual(lineage, [invokeAgentHop, spawnHop]);
  });
});

test('resolveSubAgentLineage is stable across repeated calls for the same subagent', () => {
  withTempDir((dir) => {
    startTurnHops('session-1', invokeAgentHop, dir);
    const spawnHop: CedarHop = { ...invokeAgentHop, seq: 2, action: { name: 'spawn' } };
    enqueuePendingSpawnLineage('session-1', [invokeAgentHop], spawnHop, dir);

    const first = resolveSubAgentLineage('session-1', 'subagent-a', dir);
    const second = resolveSubAgentLineage('session-1', 'subagent-a', dir);
    assert.deepEqual(first, second);
  });
});

test('pending spawn lineages bind to subagents in FIFO order', () => {
  withTempDir((dir) => {
    startTurnHops('session-1', invokeAgentHop, dir);
    const spawnHopA: CedarHop = { ...invokeAgentHop, seq: 2, resource: { type: 'SubAgent', id: 'Explore' } };
    const spawnHopB: CedarHop = { ...invokeAgentHop, seq: 2, resource: { type: 'SubAgent', id: 'general-purpose' } };
    enqueuePendingSpawnLineage('session-1', [invokeAgentHop], spawnHopA, dir);
    enqueuePendingSpawnLineage('session-1', [invokeAgentHop], spawnHopB, dir);

    // First subagent tool call seen this session gets the first spawn queued.
    const lineageForFirstSeen = resolveSubAgentLineage('session-1', 'subagent-a', dir);
    const lineageForSecondSeen = resolveSubAgentLineage('session-1', 'subagent-b', dir);
    assert.deepEqual(lineageForFirstSeen, [invokeAgentHop, spawnHopA]);
    assert.deepEqual(lineageForSecondSeen, [invokeAgentHop, spawnHopB]);
  });
});

test('a nested spawn lineage is the parent subagent lineage plus its own spawn hop', () => {
  withTempDir((dir) => {
    startTurnHops('session-1', invokeAgentHop, dir);
    const outerSpawnHop: CedarHop = { ...invokeAgentHop, seq: 2, action: { name: 'spawn' } };
    enqueuePendingSpawnLineage('session-1', [invokeAgentHop], outerSpawnHop, dir);
    const outerLineage = resolveSubAgentLineage('session-1', 'outer-subagent', dir);

    const innerSpawnHop: CedarHop = { ...invokeAgentHop, seq: 3, action: { name: 'spawn' } };
    enqueuePendingSpawnLineage('session-1', outerLineage, innerSpawnHop, dir);
    const innerLineage = resolveSubAgentLineage('session-1', 'inner-subagent', dir);

    assert.deepEqual(innerLineage, [invokeAgentHop, outerSpawnHop, innerSpawnHop]);
  });
});

test('starting a new turn clears stale pending and bound lineages from the previous turn', () => {
  withTempDir((dir) => {
    startTurnHops('session-1', invokeAgentHop, dir);
    const spawnHop: CedarHop = { ...invokeAgentHop, seq: 2, action: { name: 'spawn' } };
    enqueuePendingSpawnLineage('session-1', [invokeAgentHop], spawnHop, dir);
    resolveSubAgentLineage('session-1', 'subagent-a', dir);

    const nextTurnHop: CedarHop = { ...invokeAgentHop, time: '2026-01-01T01:00:00.000Z' };
    startTurnHops('session-1', nextTurnHop, dir);

    assert.deepEqual(loadAgentHops('session-1', dir), [nextTurnHop]);
    // subagent-a's binding from the previous turn is gone — nothing pending for it now.
    assert.deepEqual(resolveSubAgentLineage('session-1', 'subagent-a', dir), []);
  });
});

test('different sessions have independent hop chains', () => {
  withTempDir((dir) => {
    startTurnHops('session-1', invokeAgentHop, dir);
    assert.deepEqual(loadAgentHops('session-2', dir), []);
  });
});

test('with no pluginDataDir, everything no-ops instead of falling back to a home-directory dotfile', () => {
  const homeRevaGovernance = path.join(os.homedir(), '.reva-governance');
  const existedBefore = fs.existsSync(homeRevaGovernance);

  startTurnHops('session-1', invokeAgentHop, undefined);
  assert.deepEqual(loadAgentHops('session-1', undefined), []); // never actually persisted
  assert.deepEqual(resolveSubAgentLineage('session-1', 'subagent-a', undefined), []);

  assert.equal(fs.existsSync(homeRevaGovernance), existedBefore);
});
