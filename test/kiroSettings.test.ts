import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config';
import {
  applyKiroCliEnv,
  mergeEnvWithKiroCli,
  readKiroCliEnv,
} from '../src/kiroSettings';

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-kiro-settings-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeCliJson(filePath: string, body: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(body), 'utf8');
}

test('readKiroCliEnv pulls string values from the env block', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'cli.json');
    writeCliJson(file, {
      env: {
        REVA_AUTH_TOKEN: 'from-file',
        REVA_HOST: 'api.example.com',
        REVA_DEBUG: '1',
        IGNORE_ME: 123,
      },
    });
    assert.deepEqual(readKiroCliEnv({ settingsPath: file }), {
      REVA_AUTH_TOKEN: 'from-file',
      REVA_HOST: 'api.example.com',
      REVA_DEBUG: '1',
    });
  });
});

test('missing or malformed cli.json yields an empty map — never throws', () => {
  withTempDir((dir) => {
    assert.deepEqual(readKiroCliEnv({ settingsPath: path.join(dir, 'nope.json') }), {});
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not-json', 'utf8');
    assert.deepEqual(readKiroCliEnv({ settingsPath: bad }), {});
  });
});

test('process.env overrides cli.json; file fills gaps', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'cli.json');
    writeCliJson(file, {
      env: {
        REVA_AUTH_TOKEN: 'file-token',
        REVA_HOST: 'from-file.example',
        REVA_DEBUG: '1',
      },
    });
    const merged = mergeEnvWithKiroCli(
      { REVA_AUTH_TOKEN: 'shell-token', REVA_AGENT_ID: 'agent-a' },
      { settingsPath: file },
    );
    assert.equal(merged.REVA_AUTH_TOKEN, 'shell-token');
    assert.equal(merged.REVA_HOST, 'from-file.example');
    assert.equal(merged.REVA_DEBUG, '1');
    assert.equal(merged.REVA_AGENT_ID, 'agent-a');
  });
});

test('loadConfig reads REVA_AUTH_TOKEN from cli.json when process env has none', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'cli.json');
    writeCliJson(file, {
      env: {
        REVA_AUTH_TOKEN: 'cli-json-token',
        REVA_HOST: 'localhost:8787',
        REVA_AGENT_ID: 'kiro-FromCliJsonxxxxxxxxxxxx',
      },
    });
    const cfg = loadConfig({}, file);
    assert.equal(cfg.authorization, 'cli-json-token');
    assert.equal(cfg.pdpUrl, 'http://localhost:8787/pdp/v2/ai/evaluation');
    assert.equal(cfg.agentId, 'kiro-FromCliJsonxxxxxxxxxxxx');
  });
});

test('applyKiroCliEnv mutates only empty keys so debug.ts can see REVA_DEBUG', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'cli.json');
    writeCliJson(file, { env: { REVA_DEBUG: '1', REVA_HOST: 'from-file' } });
    const env: NodeJS.ProcessEnv = { REVA_HOST: 'already-set' };
    applyKiroCliEnv(env, { settingsPath: file });
    assert.equal(env.REVA_DEBUG, '1');
    assert.equal(env.REVA_HOST, 'already-set');
  });
});

test('synthetic env objects in unit tests do not bleed in the real ~/.kiro cli.json', () => {
  // Guard: loadConfig({}) must still throw even when this machine has a
  // token in ~/.kiro/settings/cli.json.
  assert.throws(() => loadConfig({}), /REVA_AUTH_TOKEN/);
});
