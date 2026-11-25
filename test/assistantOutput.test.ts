import assert from 'node:assert/strict';
import { test } from 'node:test';
import { truncateAssistantOutput } from '../src/assistantOutput';

const LIMIT = 16 * 1024;

test('empty, missing and whitespace-only replies become an empty string', () => {
  assert.equal(truncateAssistantOutput(undefined), '');
  assert.equal(truncateAssistantOutput(null), '');
  assert.equal(truncateAssistantOutput(''), '');
  assert.equal(truncateAssistantOutput('  \n\t '), '');
});

test('a reply under the limit is returned trimmed and otherwise untouched', () => {
  assert.equal(truncateAssistantOutput('  Done.\nAll tests pass.  '), 'Done.\nAll tests pass.');
});

test('a reply over 16 KiB is cut to at most 16 KiB of UTF-8', () => {
  const out = truncateAssistantOutput('a'.repeat(LIMIT + 500));
  assert.equal(Buffer.byteLength(out, 'utf8'), LIMIT);
});

test('the limit is in bytes, not characters', () => {
  // 4-byte emoji: 8192 of them is 32 KiB in bytes but only 8192 code points.
  const out = truncateAssistantOutput('😀'.repeat(8192));
  assert.ok(Buffer.byteLength(out, 'utf8') <= LIMIT);
  assert.equal(Buffer.byteLength(out, 'utf8'), LIMIT);
});

test('cutting inside a multi-byte character leaves no replacement character behind', () => {
  // 2-byte characters starting on an odd byte offset, so the limit falls
  // in the middle of one.
  const out = truncateAssistantOutput('a' + 'é'.repeat(LIMIT));
  assert.ok(Buffer.byteLength(out, 'utf8') <= LIMIT);
  assert.equal(out.includes('�'), false);
});
