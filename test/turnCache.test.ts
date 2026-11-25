import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  directSessionFromTurn,
  loadOrStartTurn,
  loadTurn,
  resolveTurnTraceId,
  startTurn,
} from '../src/turnCache';
import { truncatePrompt } from '../src/context';

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-turn-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('startTurn persists a trace id that loadTurn reads back for the same session', () => {
  withTempDir((dir) => {
    const turn = startTurn('sess-1', dir);
    const loaded = loadTurn('sess-1', dir);
    assert.equal(loaded?.traceId, turn.traceId);
    assert.equal(loaded?.turn, 1);
    assert.match(loaded?.startedAt || '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('a second startTurn call for the same session overwrites the previous turn', () => {
  withTempDir((dir) => {
    const first = startTurn('sess-1', dir);
    const second = startTurn('sess-1', dir);
    assert.notEqual(first.traceId, second.traceId);
    const loaded = loadTurn('sess-1', dir);
    assert.equal(loaded?.traceId, second.traceId);
    assert.equal(loaded?.turn, 2);
    assert.equal(second.startedAt, first.startedAt);
  });
});

test('different sessions get independent turn entries', () => {
  withTempDir((dir) => {
    const a = startTurn('sess-a', dir);
    const b = startTurn('sess-b', dir);
    assert.notEqual(a.traceId, b.traceId);
    assert.equal(loadTurn('sess-a', dir)?.traceId, a.traceId);
    assert.equal(loadTurn('sess-b', dir)?.traceId, b.traceId);
  });
});

test('loadTurn returns undefined for a session that never started a turn', () => {
  withTempDir((dir) => {
    assert.equal(loadTurn('never-seen', dir), undefined);
  });
});

test('the turn cache file on disk never contains prompt text', () => {
  withTempDir((dir) => {
    // The prompt is not a parameter of startTurn/loadOrStartTurn any more, so
    // the cache entry has exactly these four fields and nothing text-bearing.
    // Read the raw bytes back rather than trusting the returned object.
    const fresh = startTurn('sess-fresh', dir);
    const fallback = loadOrStartTurn('sess-fallback', dir);
    for (const [session, turn] of [['sess-fresh', fresh], ['sess-fallback', fallback]] as const) {
      const raw = fs.readFileSync(path.join(dir, 'turns', `${session}.json`), 'utf8');
      assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['promptTimestamp', 'startedAt', 'traceId', 'turn']);
      assert.equal('prompt' in turn, false);
    }

    // A prompt an earlier version cached is not carried into the next turn.
    const marker = 'PROMPT-MARKER-7f3a9c-do-not-keep-me';
    fs.writeFileSync(
      path.join(dir, 'turns', 'sess-legacy.json'),
      JSON.stringify({
        traceId: 'a'.repeat(32),
        prompt: marker,
        promptTimestamp: '2026-09-20T10:00:00.000Z',
        turn: 3,
        startedAt: '2026-09-20T09:00:00.000Z',
      }),
      'utf8',
    );
    startTurn('sess-legacy', dir);
    assert.ok(!fs.readFileSync(path.join(dir, 'turns', 'sess-legacy.json'), 'utf8').includes(marker));
  });
});

test('direct session is the session id only — Reva owns turn numbers and history', () => {
  withTempDir((dir) => {
    startTurn('sess-1', dir);
    const session = directSessionFromTurn('sess-1');
    assert.deepEqual(session, { id: 'sess-1' });
    assert.equal('turn' in session, false);
    assert.equal('startedAt' in session, false);
    assert.equal('messages' in session, false);
  });
});

test('truncatePrompt caps very long prompts at 10,000 characters', () => {
  const long = 'x'.repeat(12000);
  const truncated = truncatePrompt(long);
  assert.equal(truncated, `${'x'.repeat(10000)}…`);
});

test('truncatePrompt leaves prompts up to 10,000 characters untouched', () => {
  assert.equal(truncatePrompt('short prompt'), 'short prompt');
  const exact = 'y'.repeat(10000);
  assert.equal(truncatePrompt(exact), exact);
});

test('with no pluginDataDir, startTurn/loadTurn still work but never persist — no fallback to a home-directory dotfile', () => {
  const homeRevaGovernance = path.join(os.homedir(), '.reva-governance');
  const existedBefore = fs.existsSync(homeRevaGovernance);

  const turn = startTurn('sess-1', undefined);
  assert.equal(turn.turn, 1); // still a usable entry for this call
  assert.equal(loadTurn('sess-1', undefined), undefined); // but never actually persisted

  assert.equal(fs.existsSync(homeRevaGovernance), existedBefore);
});

test('with no pluginDataDir the trace id is derived, so separate hooks still share a turn', () => {
  // A minted id can only be shared if it can be persisted — every later hook
  // in the turn is its own process and reads it back from the cache. Without
  // a cache to write to, minting would give each process a different random
  // id and the turn would fragment into one trace per PDP call.
  const a = resolveTurnTraceId('sess-nodir', loadOrStartTurn('sess-nodir', undefined));
  const b = resolveTurnTraceId('sess-nodir', loadOrStartTurn('sess-nodir', undefined));
  assert.equal(a, b, 'separate processes must agree with no cache available');
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('an upgrade from a pre-traceId cache entry keeps the turn and derives a shared trace', () => {
  withTempDir((dir) => {
    // Exactly the shape written before traceId existed: spanId, no traceId.
    fs.mkdirSync(path.join(dir, 'turns'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'turns', 'sess-old.json'),
      JSON.stringify({
        spanId: 'c515b2193e5f1234',
        promptTimestamp: '2026-09-20T10:00:00.000Z',
        turn: 13,
        startedAt: '2026-09-20T09:00:00.000Z',
        prompt: 'an older prompt',
      }),
      'utf8',
    );

    const turn = loadOrStartTurn('sess-old', dir);
    // The turn must be REUSED, not restarted — restarting would bump the
    // counter and lose the conversation's own history.
    assert.equal(turn.turn, 13);
    assert.equal(turn.startedAt, '2026-09-20T09:00:00.000Z');
    assert.equal(turn.traceId, undefined);

    // …and every hook still agrees on a trace for it, via the fallback.
    const first = resolveTurnTraceId('sess-old', turn);
    const second = resolveTurnTraceId('sess-old', loadOrStartTurn('sess-old', dir));
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{32}$/);

    // The next prompt recovers to a minted id and drops the stale fields,
    // including the prompt text an earlier version cached.
    const next = startTurn('sess-old', dir);
    assert.match(next.traceId || '', /^[0-9a-f]{32}$/);
    assert.equal(next.turn, 14);
    assert.equal(next.startedAt, '2026-09-20T09:00:00.000Z');
    assert.ok(!('spanId' in next));
    assert.ok(!('prompt' in next));
    assert.ok(!fs.readFileSync(path.join(dir, 'turns', 'sess-old.json'), 'utf8').includes('an older prompt'));
  });
});
