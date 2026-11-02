import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { osFamily, readSessionModel, recordKiroDefaultModel, recordLaunchModel, resolveSessionModel, resolveSessionModelWithSource } from '../src/kiroSession';
import { modelFromCommandLine, parseDefaultModel, readLaunchModelFlag } from '../src/launchModel';

// osFamily's vocabulary is a fixed set of lowercase names, or a policy
// written `operatingSystems contains "windows"` stops matching the moment
// "win32" is reported instead.
test('osFamily uses the shared vocabulary, not Node platform strings', () => {
  assert.equal(osFamily('win32'), 'windows');
  assert.equal(osFamily('darwin'), 'macos');
  assert.equal(osFamily('linux'), 'linux');
});

test('an unknown platform is passed through rather than guessed at', () => {
  assert.equal(osFamily('freebsd' as NodeJS.Platform), 'freebsd');
});

function withFakeHome(fn: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-kirosession-'));
  try {
    fs.mkdirSync(path.join(home, '.kiro', 'sessions', 'cli'), { recursive: true });
    fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('the model is read out of Kiro’s own session record', () => {
  withFakeHome((home) => {
    fs.writeFileSync(
      path.join(home, '.kiro', 'sessions', 'cli', 'sess-1.json'),
      JSON.stringify({ conversation: { modelId: 'auto', nested: { deeper: true } } }),
      'utf8',
    );
    assert.equal(readSessionModel('sess-1', home), 'auto');
  });
});

test('a missing or unreadable session record yields undefined, never a placeholder', () => {
  withFakeHome((home) => {
    assert.equal(readSessionModel('does-not-exist', home), undefined);
    fs.writeFileSync(path.join(home, '.kiro', 'sessions', 'cli', 'bad.json'), 'not json', 'utf8');
    assert.equal(readSessionModel('bad', home), undefined);
  });
});

test('an empty session id short-circuits', () => {
  assert.equal(readSessionModel('', os.tmpdir()), undefined);
});

test('a session id containing path separators cannot escape the sessions directory', () => {
  // The session id arrives from a host payload / env var. Treating it as a
  // path segment without checking would let `../../..` read an arbitrary
  // JSON file off disk and report a string from it as "the model".
  withFakeHome((home) => {
    fs.writeFileSync(path.join(home, 'secrets.json'), JSON.stringify({ model: 'leaked' }), 'utf8');
    assert.equal(readSessionModel('../../secrets', home), undefined);
    assert.equal(readSessionModel('..\..\secrets', home), undefined);
  });
});

// The real record nests the model four levels down and spells it several
// ways — captured from an actual ~/.kiro/sessions/cli/<id>.json. An earlier
// version matched only "model"/"modelId" at shallow depth, which is part of
// why the field never reached the wire.
test('the model is found in the real nested session-record shape', () => {
  withFakeHome((home) => {
    fs.writeFileSync(
      path.join(home, '.kiro', 'sessions', 'cli', 'real.json'),
      JSON.stringify({
        session_id: 'real',
        session_state: {
          conversation_metadata: {
            user_turn_metadatas: [{ model: 'auto' }],
            last_context_usage: { model_id: 'auto' },
          },
          rts_model_state: { model_info: { model_id: 'auto', context_window_tokens: 200000 } },
        },
      }),
      'utf8',
    );
    assert.equal(readSessionModel('real', home), 'auto');
  });
});

test('snake_case model_id alone is still found', () => {
  withFakeHome((home) => {
    fs.writeFileSync(
      path.join(home, '.kiro', 'sessions', 'cli', 'snake.json'),
      JSON.stringify({ session_state: { rts_model_state: { model_info: { model_id: 'claude-sonnet-4' } } } }),
      'utf8',
    );
    assert.equal(readSessionModel('snake', home), 'claude-sonnet-4');
  });
});

// REVA_MODEL exists because Kiro reports "auto" rather than a resolved
// slug; a deployment that pins one out of band gets it on the wire.
test('REVA_MODEL overrides the session record', () => {
  withFakeHome((home) => {
    fs.writeFileSync(
      path.join(home, '.kiro', 'sessions', 'cli', 'sess-1.json'),
      JSON.stringify({ model: 'auto' }),
      'utf8',
    );
    assert.equal(resolveSessionModel('sess-1', { REVA_MODEL: 'claude-opus-5' }, home), 'claude-opus-5');
    assert.equal(resolveSessionModel('sess-1', { REVA_MODEL: '  ' }, home), 'auto');
    assert.equal(resolveSessionModel('sess-1', {}, home), 'auto');
  });
});

test('with neither source the model is absent, never a placeholder', () => {
  withFakeHome((home) => {
    assert.equal(resolveSessionModel('nope', {}, home), undefined);
  });
});

// Kiro writes the model into a session's record only once the turn starts —
// after the prompt hook has already run. The memo carries a model a session
// already reported across a moment when its record is being rewritten.
test("a session's own memo covers a moment when its record has no model", () => {
  withFakeHome((home) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-sessionmodel-'));
    try {
      const file = path.join(home, '.kiro', 'sessions', 'cli', 's1.json');
      fs.writeFileSync(file, JSON.stringify({ session_state: { conversation_metadata: { user_turn_metadatas: [{ model: 'claude-haiku-4.5' }] }, rts_model_state: { model_info: { model_id: 'claude-haiku-4.5' } } } }));
      assert.equal(resolveSessionModel('s1', {}, home, dataDir), 'claude-haiku-4.5');
      fs.writeFileSync(file, JSON.stringify({ session_state: { rts_model_state: { model_info: null } } }));
      assert.deepEqual(resolveSessionModelWithSource('s1', {}, home, dataDir), { model: 'claude-haiku-4.5', source: 'session memo' });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

// The bug this replaced: one memo shared across sessions made a brand-new
// session report the PREVIOUS session's model (a session started with
// --model claude-haiku-4.5 was reported as "auto").
test("a new session never reports another session's model", () => {
  withFakeHome((home) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-sessionmodel-'));
    try {
      fs.writeFileSync(path.join(home, '.kiro', 'sessions', 'cli', 'old.json'), JSON.stringify({ model: 'auto' }));
      assert.equal(resolveSessionModel('old', {}, home, dataDir), 'auto');
      // A new session whose record has no model yet: unknown, not "auto".
      assert.equal(resolveSessionModel('brand-new', {}, home, dataDir), undefined);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test('the CURRENT model wins over the first turn after a mid-session switch', () => {
  withFakeHome((home) => {
    fs.writeFileSync(
      path.join(home, '.kiro', 'sessions', 'cli', 'switched.json'),
      JSON.stringify({
        session_state: {
          conversation_metadata: { user_turn_metadatas: [{ model: 'auto' }, { model: 'claude-sonnet-4.5' }] },
          rts_model_state: { model_info: { model_id: 'claude-sonnet-4.5' } },
        },
      }),
    );
    assert.equal(readSessionModel('switched', home), 'claude-sonnet-4.5');
    // Without rts_model_state, the LAST turn's model — not the first.
    fs.writeFileSync(
      path.join(home, '.kiro', 'sessions', 'cli', 'turns.json'),
      JSON.stringify({ session_state: { conversation_metadata: { user_turn_metadatas: [{ model: 'auto' }, { model: 'glm-5' }] } } }),
    );
    assert.equal(readSessionModel('turns', home), 'glm-5');
  });
});

test('a Kiro IDE session record (<workspace hash>/<id>/session.json) is read too', () => {
  withFakeHome((home) => {
    const dir = path.join(home, '.kiro', 'sessions', '90c733a1471e8974', 'sess_abc');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ id: 'sess_abc', modelId: 'claude-sonnet-4.5' }));
    assert.equal(readSessionModel('sess_abc', home), 'claude-sonnet-4.5');
  });
});

test("the user's default model setting is the last fallback, after this session's own sources", () => {
  withFakeHome((home) => {
    fs.mkdirSync(path.join(home, '.kiro', 'settings'), { recursive: true });
    fs.writeFileSync(path.join(home, '.kiro', 'settings', 'cli.json'), JSON.stringify({ 'chat.defaultModel': 'claude-haiku-4.5' }));
    assert.deepEqual(resolveSessionModelWithSource('fresh', {}, home), { model: 'claude-haiku-4.5', source: 'default model setting' });
    // The session's own record still wins over the setting.
    fs.writeFileSync(path.join(home, '.kiro', 'sessions', 'cli', 'fresh.json'), JSON.stringify({ model: 'glm-5' }));
    assert.equal(resolveSessionModel('fresh', {}, home), 'glm-5');
  });
});

test('REVA_MODEL still outranks both the record and the memo', () => {
  withFakeHome((home) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-lastmodel-'));
    try {
      fs.writeFileSync(path.join(home, '.kiro', 'sessions', 'cli', 's.json'), JSON.stringify({ model: 'auto' }), 'utf8');
      assert.equal(resolveSessionModel('s', { REVA_MODEL: 'pinned' }, home, dataDir), 'pinned');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test('with no record, no memo and no override, the model is absent — never invented', () => {
  withFakeHome((home) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-lastmodel-'));
    try {
      assert.equal(resolveSessionModel('nothing', {}, home, dataDir), undefined);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test('an unwritable or absent data dir degrades to the old behaviour, never throws', () => {
  withFakeHome((home) => {
    fs.writeFileSync(path.join(home, '.kiro', 'sessions', 'cli', 's.json'), JSON.stringify({ model: 'auto' }), 'utf8');
    assert.equal(resolveSessionModel('s', {}, home, undefined), 'auto');
    assert.equal(resolveSessionModel('gone', {}, home, undefined), undefined);
  });
});

// --- the first turn: Kiro's record holds a placeholder -------------------------
//
// On kiro-cli 2.36.0, a session started with `--model claude-haiku-4.5` has a
// record saying "auto" with no completed turn for the whole first turn; the
// real model appears only after the turn ends.

function writePlaceholderRecord(home: string, id: string): void {
  fs.writeFileSync(
    path.join(home, '.kiro', 'sessions', 'cli', `${id}.json`),
    JSON.stringify({ session_state: { conversation_metadata: { user_turn_metadatas: [] }, rts_model_state: { model_info: { model_id: 'auto' } } } }),
  );
}

test('during the first turn, the launch --model flag beats the record placeholder', () => {
  withFakeHome((home) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-launchmodel-'));
    try {
      writePlaceholderRecord(home, 'first');
      recordLaunchModel('first', 'claude-haiku-4.5', dataDir);
      assert.deepEqual(resolveSessionModelWithSource('first', {}, home, dataDir), {
        model: 'claude-haiku-4.5',
        source: 'kiro-cli --model flag',
      });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test('once a turn has completed, the record wins — a later /model switch is reported', () => {
  withFakeHome((home) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-launchmodel-'));
    try {
      recordLaunchModel('switch', 'claude-haiku-4.5', dataDir);
      fs.writeFileSync(
        path.join(home, '.kiro', 'sessions', 'cli', 'switch.json'),
        JSON.stringify({ session_state: { conversation_metadata: { user_turn_metadatas: [{ model: 'claude-haiku-4.5' }, { model: 'glm-5' }] }, rts_model_state: { model_info: { model_id: 'glm-5' } } } }),
      );
      assert.equal(resolveSessionModel('switch', {}, home, dataDir), 'glm-5');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test('with no flag and no setting, the placeholder is reported as Kiro’s default ("auto")', () => {
  withFakeHome((home) => {
    writePlaceholderRecord(home, 'plain');
    assert.deepEqual(resolveSessionModelWithSource('plain', {}, home), { model: 'auto', source: "session record (Kiro's default)" });
    // A configured default model outranks the placeholder.
    fs.mkdirSync(path.join(home, '.kiro', 'settings'), { recursive: true });
    fs.writeFileSync(path.join(home, '.kiro', 'settings', 'cli.json'), JSON.stringify({ 'chat.defaultModel': 'glm-5' }));
    assert.deepEqual(resolveSessionModelWithSource('plain', {}, home), { model: 'glm-5', source: 'default model setting' });
  });
});

// --- reading --model off the kiro-cli command line -------------------------------

test('modelFromCommandLine reads --model from a kiro-cli chat command line only', () => {
  // The real Windows ancestor line, captured from a real session.
  assert.equal(
    modelFromCommandLine('C:\Users\a\AppData\Local\Kiro-Cli\kiro-cli.exe chat --agent reva-governance --model claude-haiku-4.5 --no-interactive "Reply ok"'),
    'claude-haiku-4.5',
  );
  assert.equal(modelFromCommandLine('/usr/local/bin/kiro-cli chat --model=glm-5'), 'glm-5');
  assert.equal(modelFromCommandLine('kiro-cli chat --agent x'), undefined);
  // The acp engine process carries no --model, and other programs are ignored.
  assert.equal(modelFromCommandLine('kiro-cli.exe acp --agent-engine=v2'), undefined);
  assert.equal(modelFromCommandLine('python train.py --model resnet50'), undefined);
});

test('readLaunchModelFlag walks the ancestors and never throws', () => {
  assert.equal(
    readLaunchModelFlag(() => ['node hook.js', 'powershell -Command node hook.js', 'kiro-cli.exe acp --agent-engine=v2', 'kiro-cli.exe chat --model claude-sonnet-4.5']),
    'claude-sonnet-4.5',
  );
  assert.equal(readLaunchModelFlag(() => ['node hook.js']), undefined);
  assert.equal(
    readLaunchModelFlag(() => {
      throw new Error('ps not available');
    }),
    undefined,
  );
});

// --- Kiro's default model -------------------------------------------------------
//
// A session's record can hold `model_info: null` and no turn until its first
// turn ends, with no --model flag and no chat.defaultModel — so nothing above
// applied and the model went missing from the request.

test("a record with no model yet falls back to Kiro's default model, never to nothing", () => {
  withFakeHome((home) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-kirodefault-'));
    try {
      fs.writeFileSync(
        path.join(home, '.kiro', 'sessions', 'cli', 'nullmodel.json'),
        JSON.stringify({ session_state: { conversation_metadata: { user_turn_metadatas: [] }, rts_model_state: { model_info: null } } }),
      );
      assert.deepEqual(resolveSessionModelWithSource('nullmodel', {}, home, dataDir), {});
      recordKiroDefaultModel('auto', dataDir);
      assert.deepEqual(resolveSessionModelWithSource('nullmodel', {}, home, dataDir), { model: 'auto', source: 'Kiro default model' });
      // A model the user chose still outranks Kiro's default.
      recordLaunchModel('nullmodel', 'glm-5', dataDir);
      assert.equal(resolveSessionModel('nullmodel', {}, home, dataDir), 'glm-5');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test('parseDefaultModel reads the "*" entry of real `kiro-cli chat --list-models` output', () => {
  const output = [
    'Available models (* = default):',
    '',
    '* auto                 1.00x credits      Models chosen by task for optimal usage and consistent quality',
    '  claude-sonnet-4.5    1.30x credits      Claude Sonnet 4.5 model',
    '  claude-haiku-4.5     0.40x credits      The latest Claude Haiku model',
  ].join('\n');
  assert.equal(parseDefaultModel(output), 'auto');
  assert.equal(parseDefaultModel('  claude-haiku-4.5   0.40x'), undefined);
});
