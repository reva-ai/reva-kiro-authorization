import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripBom } from '../src/stdin';

// Piping a payload into a compiled entrypoint from Windows PowerShell 5.1
// prepends a UTF-8 BOM, JSON.parse rejects it, and the entrypoint fails
// closed. On PreToolUse in the Kiro IDE that is a
// hard block on the tool call — a denied action caused by an invisible
// byte, which is about the worst failure-to-cause ratio available.

test('a leading BOM is removed so JSON.parse succeeds', () => {
  const payload = '{"hook_event_name":"preToolUse"}';
  assert.throws(() => JSON.parse(`﻿${payload}`), SyntaxError);
  assert.doesNotThrow(() => JSON.parse(stripBom(`﻿${payload}`)));
  assert.deepEqual(JSON.parse(stripBom(`﻿${payload}`)), { hook_event_name: 'preToolUse' });
});

test('a payload with no BOM is returned untouched', () => {
  const payload = '{"a":1}';
  assert.equal(stripBom(payload), payload);
});

test('only one BOM is stripped, and only from the front', () => {
  // A second leading U+FEFF is not a BOM, it is content; so is one in the
  // middle of a string value. Stripping either would corrupt the payload.
  assert.equal(stripBom('﻿﻿{"a":1}'), '﻿{"a":1}');
  assert.equal(stripBom('{"a":"x﻿y"}'), '{"a":"x﻿y"}');
});

test('empty input does not throw', () => {
  assert.equal(stripBom(''), '');
});
