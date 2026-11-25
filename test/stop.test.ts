import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { startTurn } from '../src/turnCache';

// Real-subprocess test of the Stop hook, run as Kiro runs it, against a mock
// Reva that records what the summarize endpoint receives.

const ENTRYPOINT = path.resolve(__dirname, '../src/stop.js');

function cleanEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('REVA_') && key !== 'KIRO_SESSION_ID') env[key] = value;
  }
  return {
    ...env,
    REVA_KIRO_SETTINGS_PATH: path.join(os.tmpdir(), 'reva-governance-no-cli.json'),
    ...overrides,
  };
}

interface Recorded {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

interface Run {
  code: number | null;
  stdout: string;
  requests: Recorded[];
}

interface RunOptions {
  stdin: string;
  status?: number;
  env?: Record<string, string>;
  // Point the hook at a port nothing listens on.
  unreachable?: boolean;
}

async function runStop(dataDir: string, opts: RunOptions): Promise<Run> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(opts.status ?? 202);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = opts.unreachable ? 1 : address.port;
  try {
    const child = spawn(process.execPath, [ENTRYPOINT], {
      env: cleanEnv({
        REVA_HOST: `http://127.0.0.1:${port}`,
        REVA_AUTH_TOKEN: 'test-token',
        REVA_AGENT_ID: 'stop-test-agent',
        REVA_DATA_DIR: dataDir,
        HOME: dataDir,
        ...opts.env,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (c) => (stdout += c));
    child.stderr.resume();
    child.stdin.end(opts.stdin);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, stdout, requests };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function withDataDir(t: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Kiro IDE Stop: summarizes the turn trace with the session as thread, no output (none on the wire)', async (t) => {
  const dir = withDataDir(t);
  const turn = startTurn('ide-session', dir);
  const run = await runStop(dir, {
    stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 'ide-session', cwd: dir }),
  });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.requests.length, 1);
  const [req] = run.requests;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/pdp/ai/access/v1/ai/trace/summarize');
  assert.deepEqual(req.body, { trace_id: turn.traceId, thread_id: 'ide-session' });
  assert.equal(req.headers['x-api-token'], 'test-token');
  assert.equal(req.headers['x-api-origin-app'], 'KIRO');
  assert.equal(req.headers['x-reva-thread-id'], 'ide-session');
  assert.equal(req.headers['x-reva-verification-codes'], undefined);
});

test('kiro-cli stop: session id from KIRO_SESSION_ID, the reply goes along as output', async (t) => {
  const dir = withDataDir(t);
  const turn = startTurn('cli-session', dir);
  const run = await runStop(dir, {
    stdin: JSON.stringify({ hook_event_name: 'stop', cwd: dir, assistant_response: 'There are 12 files.' }),
    env: { KIRO_SESSION_ID: 'cli-session' },
  });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.requests.length, 1);
  assert.deepEqual(run.requests[0].body, {
    trace_id: turn.traceId,
    thread_id: 'cli-session',
    output: 'There are 12 files.',
  });
});

test('a long reply is cut to 16 KiB before it leaves the machine', async (t) => {
  const dir = withDataDir(t);
  startTurn('long-session', dir);
  const run = await runStop(dir, {
    stdin: JSON.stringify({ hook_event_name: 'stop', cwd: dir, assistant_response: 'x'.repeat(40000) }),
    env: { KIRO_SESSION_ID: 'long-session' },
  });
  assert.equal(run.code, 0);
  assert.equal(Buffer.byteLength(run.requests[0].body.output, 'utf8'), 16 * 1024);
});

test('sends nothing hops-, history- or prompt-shaped', async (t) => {
  const dir = withDataDir(t);
  // A cache entry written by an earlier version still carries the prompt
  // text. The stop hook reads past it and must never send it.
  fs.mkdirSync(path.join(dir, 'turns'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'turns', 'shape-session.json'),
    JSON.stringify({
      traceId: 'b'.repeat(32),
      prompt: 'private prompt text',
      promptTimestamp: '2026-09-20T10:00:00.000Z',
      turn: 1,
      startedAt: '2026-09-20T09:00:00.000Z',
    }),
    'utf8',
  );
  const run = await runStop(dir, {
    stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 'shape-session', cwd: dir }),
  });
  assert.deepEqual(Object.keys(run.requests[0].body).sort(), ['thread_id', 'trace_id']);
  assert.equal(JSON.stringify(run.requests[0].body).includes('private prompt text'), false);
});

test('no turn recorded for the session: nothing is sent, still exit 0', async (t) => {
  const dir = withDataDir(t);
  const run = await runStop(dir, {
    stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 'never-prompted', cwd: dir }),
  });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.requests.length, 0);
});

test('no session id at all: nothing is sent, still exit 0', async (t) => {
  const dir = withDataDir(t);
  const run = await runStop(dir, { stdin: JSON.stringify({ hook_event_name: 'stop', cwd: dir }) });
  assert.equal(run.code, 0);
  assert.equal(run.requests.length, 0);
});

test('Reva rejecting the summarize call never changes the hook outcome', async (t) => {
  const dir = withDataDir(t);
  startTurn('rejected-session', dir);
  for (const status of [400, 401, 403, 500]) {
    const run = await runStop(dir, {
      stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 'rejected-session', cwd: dir }),
      status,
    });
    assert.equal(run.code, 0, `HTTP ${status} must not change the exit code`);
    assert.equal(run.stdout, '', `HTTP ${status} must print nothing (a block decision would make Kiro continue)`);
    assert.equal(run.requests.length, 1);
  }
});

test('Reva unreachable: exit 0, no output', async (t) => {
  const dir = withDataDir(t);
  startTurn('offline-session', dir);
  const run = await runStop(dir, {
    stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 'offline-session', cwd: dir }),
    unreachable: true,
  });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
});

test('plugin not configured (no token): exit 0, nothing sent', async (t) => {
  const dir = withDataDir(t);
  startTurn('unconfigured-session', dir);
  const run = await runStop(dir, {
    stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 'unconfigured-session', cwd: dir }),
    env: { REVA_AUTH_TOKEN: '' },
  });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.requests.length, 0);
});

test('malformed and empty stdin still exit 0 with empty stdout', async (t) => {
  const dir = withDataDir(t);
  for (const stdin of ['{ not valid', '']) {
    const run = await runStop(dir, { stdin });
    assert.equal(run.code, 0);
    assert.equal(run.stdout, '');
    assert.equal(run.requests.length, 0);
  }
});
