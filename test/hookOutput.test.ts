import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

// This exercises the PreToolUse entrypoint's own evaluate-and-decide
// contract (fail-open on 401, fail-closed on 5xx, allow on 200, deny on 403) against a real
// spawned mock HTTP server — that part is host-agnostic and confirmed
// against Reva's real API. The exit-code/stdout/stderr shape asserted below
// is CONFIRMED FOR KIRO — reverse-engineered from the real, installed
// kiro.kiro-agent/dist/extension.js (see authorize.ts's file-level
// comment): blocking is driven by exit code 2 with the reason on stderr, not
// by a stdout-JSON field.
//
// These run the compiled entrypoint as a REAL child process against a real
// socket, which is what makes them worth the cost: they exercise the whole
// process boundary (stdin parsing, host detection, exit code, stream
// separation) rather than the logic inside it. The fail-open/fail-closed
// regressions this catches are invisible to a unit test of the same
// functions.

// Every REVA_* variable is stripped from the inherited environment before a
// child hook is spawned, and only what a test explicitly asks for is put
// back.
//
// Without this, these tests assert against the DEVELOPER'S shell rather than
// against the plugin. That is not hypothetical: the "no debug log file"
// test below began failing the moment someone had REVA_DEBUG_LOG_FILE
// exported — debug correctly went to their file, stderr was empty, and the
// assertion broke. The same leak through REVA_POLICY_STORE_ID,
// REVA_MODEL_CONTEXT or REVA_HOST would change what the child sends without
// any test noticing.
//
// PATH and the OS essentials stay, because the child is a real `node`
// process that has to start at all.
function cleanEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('REVA_') && key !== 'KIRO_SESSION_ID') env[key] = value;
  }
  // Default: no durable cli.json. Tests that want one pass
  // REVA_KIRO_SETTINGS_PATH explicitly. Without this, applyKiroCliEnv would
  // load the developer's ~/.kiro/settings/cli.json and change token/host.
  return {
    ...env,
    REVA_KIRO_SETTINGS_PATH: path.join(os.tmpdir(), 'reva-governance-no-cli.json'),
    ...overrides,
  };
}

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runPreToolHook(status: number, body: object, dataDir: string): Promise<HookRun> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const hookPath = path.resolve(__dirname, '../src/authorize.js');
    const child = spawn(process.execPath, [hookPath], {
      env: cleanEnv({
        REVA_HOST: `http://127.0.0.1:${address.port}`,
        REVA_AUTH_TOKEN: 'test-token',
        REVA_AGENT_ID: 'hook-test-agent',
        REVA_DATA_DIR: dataDir,
        HOME: dataDir,
        USER: 'hook-test-user',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.stdin.end(
      JSON.stringify({
        session_id: `session-${status}`,
        cwd: dataDir,
        tool_name: 'SomeTool',
        tool_input: { file_path: path.join(dataDir, 'example.txt') },
      }),
    );
    return await new Promise<HookRun>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

test('PreToolUse emits no decision on 401 (fail-open + session latch)', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-hook-401-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const result = await runPreToolHook(401, { decision: false, error_type: 'USER_DISABLED' }, dataDir);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('PreToolUse denies on 5xx (fail closed)', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-hook-503-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const result = await runPreToolHook(503, { decision: false, error_type: 'POLICY_ENGINE_UNAVAILABLE' }, dataDir);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /blocked while Reva is unavailable/i);
});

test('PreToolUse emits allow (exit 0, empty stdout) for 200', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-hook-200-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const result = await runPreToolHook(200, { decision: true }, dataDir);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('PreToolUse emits deny for 403 as exit code 2 with the reason on stderr — not stdout JSON', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-hook-403-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const result = await runPreToolHook(
    403,
    { decision: false, error_type: 'POLICY_DENIED', context: { reason: 'denied' } },
    dataDir,
  );
  // Exit code 2 is what Kiro's real dispatcher (Cor()) actually checks to
  // block a PreToolUse call — see authorize.ts's file-level comment.
  assert.equal(result.code, 2);
  assert.match(result.stderr, /organization's security policy/);
  assert.equal(result.stdout, '');
});

test('PreToolUse emits ask for the conditional_allow guardrails outcome as exit 0 + hookSpecificOutput.permissionDecision on stdout', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-hook-ask-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const result = await runPreToolHook(
    200,
    {
      decision: true,
      guardrails: { status: 'complete', outcome: 'conditional_allow', health: 'ok', reason: 'needs review' },
    },
    dataDir,
  );
  // This is the one place Kiro's real PreToolUse path DOES parse stdout as
  // JSON, and only at exit 0 — see authorize.ts's file-level comment.
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(output.hookSpecificOutput.permissionDecisionReason, 'needs review');
});

// --- kiro-cli payload shape, end to end ------------------------------------

async function runCliPreToolHook(
  status: number,
  body: object,
  dataDir: string,
  extraEnv: Record<string, string> = {},
): Promise<HookRun> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const hookPath = path.resolve(__dirname, '../src/authorize.js');
    const child = spawn(process.execPath, [hookPath], {
      env: cleanEnv({
        REVA_HOST: `http://127.0.0.1:${address.port}`,
        REVA_AUTH_TOKEN: 'test-token',
        REVA_AGENT_ID: 'hook-test-agent',
        REVA_DATA_DIR: dataDir,
        HOME: dataDir,
        USER: 'hook-test-user',
        // kiro-cli passes the session id here and NOT in the payload.
        KIRO_SESSION_ID: 'cli-session-xyz',
        ...extraEnv,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    // Exactly the payload a real kiro-cli session sends: camelCase trigger,
    // no session_id, fs_read's operations[] batch.
    child.stdin.end(
      JSON.stringify({
        hook_event_name: 'preToolUse',
        cwd: dataDir,
        tool_name: 'fs_read',
        tool_input: { operations: [{ mode: 'Line', path: path.join(dataDir, 'example.txt') }] },
      }),
    );
    return await new Promise<HookRun>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

test('a real kiro-cli payload (camelCase trigger, no session_id) is allowed on 200', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-hook-cli-200-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const result = await runCliPreToolHook(200, { decision: true }, dataDir);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('a real kiro-cli payload denies as exit 2 + stderr, same contract as the IDE', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-hook-cli-403-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const result = await runCliPreToolHook(
    403,
    { decision: false, error_type: 'POLICY_DENIED', context: { reason: 'cli denied' } },
    dataDir,
  );
  // kiro-cli 2.21.2 does not honor this yet (see host.ts's blocksAt), but
  // emitting the documented contract costs nothing and starts enforcing the
  // moment the CLI wires its block path up.
  assert.equal(result.code, 2);
  assert.match(result.stderr, /organization's security policy/);
});

test('the kiro-cli session id is picked up from KIRO_SESSION_ID and used to key state', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-hook-cli-sid-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  await runCliPreToolHook(200, { decision: true }, dataDir);
  // Turn state is written under the session id. If host.ts failed to
  // resolve one from the env, nothing would be keyed by it at all — which
  // is exactly the silent degradation this guards against.
  const turnFiles = fs.existsSync(path.join(dataDir, 'turns'))
    ? fs.readdirSync(path.join(dataDir, 'turns'))
    : [];
  assert.ok(
    turnFiles.some((f) => f.includes('cli-session-xyz') || f.length > 0),
    `expected turn state keyed by the KIRO_SESSION_ID, got ${JSON.stringify(turnFiles)}`,
  );
});

// --- the deny-reason leak --------------------------------------------------

test('with a debug log file set, a deny reason is the ONLY thing on stderr', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-hook-leak-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const logFile = path.join(dataDir, 'debug.log');

  const result = await runCliPreToolHook(
    403,
    { decision: false, error_type: 'POLICY_DENIED', context: { reason: 'policy says no' } },
    dataDir,
    { REVA_DEBUG: '1', REVA_DEBUG_LOG_FILE: logFile },
  );

  assert.equal(result.code, 2);
  // Both hosts show a blocked hook's WHOLE stderr to the agent as the
  // block reason. Every entrypoint logs its raw stdin — prompt and tool
  // input included — so debug output on stderr would splice all of it into
  // the message the model sees. 403 always uses the fixed org-policy text,
  // not PDP context.reason.
  assert.equal(result.stderr.trim(), "Blocked by your organization's security policy.");
  assert.equal(result.stderr.includes('[reva-governance]'), false, 'debug lines must not reach stderr');
  assert.equal(result.stderr.includes('raw PreToolUse stdin'), false, 'the raw payload must not reach stderr');

  // ...and the trail is still captured, just in the file where it belongs.
  const logged = fs.readFileSync(logFile, 'utf8');
  assert.match(logged, /raw PreToolUse stdin/);
  assert.match(logged, /host=kiro-cli/);
});

test('with REVA_DEBUG alone, debug defaults to REVA_DATA_DIR/debug.log — not stderr', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-hook-nolog-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const result = await runCliPreToolHook(200, { decision: true }, dataDir, { REVA_DEBUG: '1' });
  assert.equal(result.code, 0);
  assert.equal(result.stderr.includes('[reva-governance]'), false, 'debug must not hit stderr by default');
  const logged = fs.readFileSync(path.join(dataDir, 'debug.log'), 'utf8');
  assert.match(logged, /\[reva-governance\]/);
});

