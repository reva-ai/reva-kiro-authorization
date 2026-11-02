import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { claimSessionIngestion } from '../src/sessionIngestion';

// Ingestion used to hang off the `agentSpawn` / `SessionStart` hook alone.
// kiro-cli 2.21.3 stopped firing that trigger (verified against a brand-new
// agent config, so neither caching nor a hook timeout), and ingestion
// silently never ran. The claim below is what lets the first
// userPromptSubmit of a session start the pass instead, without the two
// triggers racing into a double run on hosts where both do fire.

function withDataDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-ingest-claim-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('exactly one caller wins the claim for a session', () => {
  withDataDir((dir) => {
    assert.equal(claimSessionIngestion('sess-1', dir), true, 'the first caller claims it');
    assert.equal(claimSessionIngestion('sess-1', dir), false, 'a second caller must not');
    assert.equal(claimSessionIngestion('sess-1', dir), false);
  });
});

test('a different session is a separate claim', () => {
  withDataDir((dir) => {
    assert.equal(claimSessionIngestion('sess-1', dir), true);
    // Every session re-runs the live GET, so a record deleted on the Reva
    // side is recreated by the next session. A marker that spanned sessions
    // would break exactly that self-healing.
    assert.equal(claimSessionIngestion('sess-2', dir), true);
  });
});

test('concurrent claims from separate processes cannot both win', () => {
  // This is the real scenario: userPromptSubmit and agentSpawn can fire for
  // one session, and several hooks run concurrently as separate processes.
  // The claim must be decided by the filesystem, not by a read-then-write
  // race where both sides read "absent" and both proceed.
  withDataDir((dir) => {
    const results = Array.from({ length: 20 }, () => claimSessionIngestion('race', dir));
    assert.equal(results.filter(Boolean).length, 1, 'exactly one claim may succeed');
  });
});

test('no data dir means no claim — never a claim that cannot be recorded', () => {
  // Returning true here would re-spawn the ingestion pass on every single
  // prompt, since nothing would record that it had already started.
  assert.equal(claimSessionIngestion('sess-1', undefined), false);
});

test('an empty session id never claims', () => {
  withDataDir((dir) => {
    assert.equal(claimSessionIngestion('', dir), false);
  });
});

test('an unwritable data dir degrades to "do not start", not to a throw', () => {
  // Ingestion is best-effort; a storage problem must not reach the
  // enforcement entrypoint that called this.
  assert.doesNotThrow(() => claimSessionIngestion('sess-1', path.join(os.tmpdir(), 'reva-nonexistent', '\0bad')));
});
