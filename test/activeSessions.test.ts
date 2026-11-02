import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { getActiveSessionCount, getActiveSessions, getSessionEntry, markSessionActive } from '../src/activeSessions';

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-active-sessions-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Matches activeSessions.ts's own (unexported) cacheFile() convention —
// needed here only to hand-write a stale entry for the pruning test below.
function cacheFile(dir: string, agentId: string): string {
  return path.join(dir, 'active-sessions', `${agentId}.json`);
}

test('first session for an Agent is the only one active', () => {
  withTempDir((dir) => {
    markSessionActive('agent-1', 'sess-1', 'cli', dir);
    assert.equal(getActiveSessionCount('agent-1', dir), 1);
  });
});

test('markSessionActive returns the entry it just wrote, so callers need no separate read', () => {
  withTempDir((dir) => {
    const entry = markSessionActive('agent-1', 'sess-1', 'cli', dir);
    assert.equal(entry?.sessionId, 'sess-1');
    assert.equal(entry?.entrypoint, 'cli');
    assert.ok(entry && entry.lastSeen > 0);
  });
});

test('markSessionActive returns undefined for an empty sessionId — nothing to report', () => {
  withTempDir((dir) => {
    assert.equal(markSessionActive('agent-1', '', 'cli', dir), undefined);
  });
});

test('getSessionEntry reads one session back without refreshing it', () => {
  withTempDir((dir) => {
    markSessionActive('agent-1', 'sess-1', 'cli', dir);
    const entry = getSessionEntry('agent-1', 'sess-1', dir);
    assert.equal(entry?.sessionId, 'sess-1');
    assert.equal(entry?.entrypoint, 'cli');
  });
});

test('getSessionEntry returns undefined for a session that was never marked active', () => {
  withTempDir((dir) => {
    markSessionActive('agent-1', 'sess-1', 'cli', dir);
    assert.equal(getSessionEntry('agent-1', 'sess-does-not-exist', dir), undefined);
  });
});

test('multiple distinct session_ids for the same Agent all count as active', () => {
  withTempDir((dir) => {
    markSessionActive('agent-1', 'sess-1', 'cli', dir);
    markSessionActive('agent-1', 'sess-2', 'ide-kiro', dir);
    assert.equal(getActiveSessionCount('agent-1', dir), 2);

    const sessions = getActiveSessions('agent-1', dir).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    assert.equal(sessions[0].sessionId, 'sess-1');
    assert.equal(sessions[0].entrypoint, 'cli');
    assert.equal(sessions[1].sessionId, 'sess-2');
    assert.equal(sessions[1].entrypoint, 'ide-kiro');
    assert.ok(sessions[0].lastSeen > 0);
  });
});

test('re-marking the same session_id refreshes it in place, not as a duplicate', () => {
  withTempDir((dir) => {
    markSessionActive('agent-1', 'sess-1', 'cli', dir);
    markSessionActive('agent-1', 'sess-1', 'cli', dir);
    markSessionActive('agent-1', 'sess-1', 'cli', dir);
    assert.equal(getActiveSessionCount('agent-1', dir), 1);
  });
});

test('different Agents (machines) have independent registries', () => {
  withTempDir((dir) => {
    markSessionActive('agent-1', 'sess-1', 'cli', dir);
    markSessionActive('agent-2', 'sess-2', 'cli', dir);
    assert.equal(getActiveSessionCount('agent-1', dir), 1);
    assert.equal(getActiveSessionCount('agent-2', dir), 1);
  });
});

test('a session not seen in over 10 minutes is treated as gone', () => {
  withTempDir((dir) => {
    markSessionActive('agent-1', 'sess-fresh', 'cli', dir);

    // Hand-write a second, stale entry directly into the same file — this
    // is what a session looks like after being genuinely abandoned (no
    // SessionEnd hook exists to clean it up any other way).
    const file = cacheFile(dir, 'agent-1');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.sessions['sess-stale'] = { entrypoint: 'cli', lastSeen: Date.now() - 11 * 60 * 1000 };
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');

    const sessions = getActiveSessions('agent-1', dir);
    assert.deepEqual(
      sessions.map((s) => s.sessionId),
      ['sess-fresh'],
    );
  });
});

test('reading prunes stale entries from disk, not just from the returned result', () => {
  withTempDir((dir) => {
    const file = cacheFile(dir, 'agent-1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ sessions: { 'sess-old': { entrypoint: 'cli', lastSeen: Date.now() - 24 * 60 * 60 * 1000 } } }),
      'utf8',
    );

    // Any call that writes (markSessionActive) re-saves the pruned state.
    markSessionActive('agent-1', 'sess-new', 'cli', dir);

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(onDisk.sessions), ['sess-new']);
  });
});

test('markSessionActive ignores an empty/missing sessionId rather than recording a literal "undefined" entry', () => {
  withTempDir((dir) => {
    markSessionActive('agent-1', '', 'cli', dir);
    markSessionActive('agent-1', undefined as unknown as string, 'cli', dir);
    assert.equal(getActiveSessionCount('agent-1', dir), 0);
  });
});

test('getActiveSessionCount is 0 when nothing has ever been recorded', () => {
  withTempDir((dir) => {
    assert.equal(getActiveSessionCount('never-seen-agent', dir), 0);
    assert.deepEqual(getActiveSessions('never-seen-agent', dir), []);
  });
});

test('with no pluginDataDir, everything no-ops instead of falling back to a home-directory dotfile', () => {
  const homeRevaGovernance = path.join(os.homedir(), '.reva-governance');
  const existedBefore = fs.existsSync(homeRevaGovernance);

  const marked = markSessionActive('agent-1', 'sess-1', 'cli', undefined);
  assert.equal(marked?.sessionId, 'sess-1'); // still returns a usable entry
  assert.equal(getActiveSessionCount('agent-1', undefined), 0); // but never actually persisted
  assert.deepEqual(getActiveSessions('agent-1', undefined), []);
  assert.equal(getSessionEntry('agent-1', 'sess-1', undefined), undefined);

  // Never created (or re-created) ~/.reva-governance as a side effect.
  assert.equal(fs.existsSync(homeRevaGovernance), existedBefore);
});
