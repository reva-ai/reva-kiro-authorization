import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { claimSubAgentPrompt, recordSubAgentPrompts } from '../src/subAgentPrompts';

function withDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-subprompts-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a prompt identical to a recorded sub-agent instruction is claimed once', () => {
  withDir((dir) => {
    recordSubAgentPrompts('s', ['You are Subagent 4 of 4. Do X.'], dir);
    assert.equal(claimSubAgentPrompt('s', 'You are Subagent 4 of 4. Do X.', dir), true);
    // Consumed: the same words typed again later are a normal new turn.
    assert.equal(claimSubAgentPrompt('s', 'You are Subagent 4 of 4. Do X.', dir), false);
  });
});

test('an ordinary user prompt is never mistaken for a sub-agent', () => {
  withDir((dir) => {
    recordSubAgentPrompts('s', ['You are Subagent 1 of 4.'], dir);
    assert.equal(claimSubAgentPrompt('s', 'delete the app folder', dir), false);
    assert.equal(claimSubAgentPrompt('s', '', dir), false);
    assert.equal(claimSubAgentPrompt('s', undefined, dir), false);
  });
});

test('records are per session, and only fingerprints are stored — never the text', () => {
  withDir((dir) => {
    recordSubAgentPrompts('session-a', ['secret instructions'], dir);
    assert.equal(claimSubAgentPrompt('session-b', 'secret instructions', dir), false);
    const stored = fs.readFileSync(path.join(dir, 'subagent-prompts', 'session-a.json'), 'utf8');
    assert.ok(!stored.includes('secret instructions'));
    assert.equal(claimSubAgentPrompt('session-a', '  secret instructions  ', dir), true);
  });
});
