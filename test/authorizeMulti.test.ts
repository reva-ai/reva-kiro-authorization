import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

// Real-subprocess test of deny-if-any: the compiled PreToolUse hook is run
// as Kiro would run it, against a mock PDP that denies any request whose
// resource is `.env` and allows everything else. Proves the whole chain —
// command parsing, one request per resource, composition, exit code — not
// just the functions in isolation.

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

interface Run {
  code: number | null;
  stderr: string;
  requests: any[];
}

async function runHook(dataDir: string, toolName: string, toolInput: object): Promise<Run> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const denied = String(parsed.resource?.id || '').endsWith('.env');
      res.writeHead(denied ? 403 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(denied ? { decision: false, reason: 'secrets are off limits' } : { decision: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../src/authorize.js')], {
      env: cleanEnv({
        REVA_HOST: `http://127.0.0.1:${address.port}`,
        REVA_AUTH_TOKEN: 'test-token',
        REVA_AGENT_ID: 'multi-test-agent',
        REVA_DATA_DIR: dataDir,
        HOME: dataDir,
        USER: 'multi-test-user',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.setEncoding('utf8').on('data', (c) => (stderr += c));
    // IDE-shaped payload, so the hook is on its enforcing path.
    child.stdin.end(JSON.stringify({ session_id: 'multi-session', cwd: dataDir, tool_name: toolName, tool_input: toolInput }));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, stderr, requests };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function withWorkspace(t: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-multi-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'README.md'), '');
  fs.writeFileSync(path.join(dir, '.env'), '');
  return dir;
}

test('a chained command is denied when ANY path it touches is denied — one request per path', async (t) => {
  const dir = withWorkspace(t);
  const run = await runHook(dir, 'execute_cmd', { command: 'cat README.md; cat .env' });
  assert.equal(run.requests.length, 2, 'one evaluation per path');
  assert.deepEqual(run.requests.map((r) => path.basename(r.resource.id)), ['README.md', '.env']);
  assert.ok(run.requests.every((r) => r.context.command === 'cat README.md; cat .env'));
  assert.equal(run.code, 2, `expected a deny, got exit ${run.code}: ${run.stderr}`);
  assert.match(run.stderr, /\[resource: executeBash on File:.*\.env\]/, 'the deny reason names the denied resource');
  assert.match(run.stderr, /2 resources evaluated/);
});

test('the same command without the denied path is allowed', async (t) => {
  const dir = withWorkspace(t);
  const run = await runHook(dir, 'execute_cmd', { command: 'cat README.md' });
  assert.equal(run.requests.length, 1);
  assert.equal(run.code, 0, run.stderr);
});

test('a batched fs_read is denied by its .env member instead of passing as a read of the folder', async (t) => {
  const dir = withWorkspace(t);
  const run = await runHook(dir, 'fs_read', {
    operations: [{ mode: 'Line', path: path.join(dir, 'README.md') }, { mode: 'Line', path: path.join(dir, '.env') }],
  });
  assert.equal(run.requests.length, 2);
  assert.equal(run.code, 2, run.stderr);
});

test('every request carries context.os and context.machineId', async (t) => {
  const dir = withWorkspace(t);
  const run = await runHook(dir, 'execute_cmd', { command: 'cat README.md' });
  const ctx = run.requests[0].context;
  assert.ok(['Windows', 'macOS', 'Linux'].includes(ctx.os), `unexpected os ${ctx.os}`);
  assert.equal(typeof ctx.machineId, 'string');
  assert.ok(ctx.machineId.length > 0);
});

test('a call over the per-call cap is denied without contacting the PDP', async (t) => {
  const dir = withWorkspace(t);
  const files = Array.from({ length: 11 }, (_, i) => `f${i}.txt`).join(' ');
  const run = await runHook(dir, 'execute_cmd', { command: `cat ${files}` });
  assert.equal(run.requests.length, 0);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /above the limit of 10/);
});
