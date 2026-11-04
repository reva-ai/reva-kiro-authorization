#!/usr/bin/env node
// Reports what this machine's Kiro install ACTUALLY does with a governance
// deny, instead of asserting it from a version number or a docs page.
//
// This exists because both hosts' published documentation disagreed with
// their shipped binaries: kiro.dev names the IDE's prompt trigger
// `PromptSubmit` (the real one is `UserPromptSubmit`), and kiro-cli's own
// bundled docs state that exit code 2 blocks a preToolUse hook (on 2.21.2 it
// does not). A check that runs the real path is the only claim worth making.
//
// Usage:  node scripts/reva-doctor.mjs [--probe-cli]
//
// Without --probe-cli this is offline: config, build, registration, and
// identity. --probe-cli additionally runs one real `kiro-cli chat` turn
// with a deliberately denying hook installed, and reports whether the tool
// was actually stopped. That turn costs credits and needs a login, which is
// why it is opt-in.

import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const probeCli = process.argv.includes('--probe-cli');

const ok = (m) => console.log(`  [ok]   ${m}`);
const warn = (m) => console.log(`  [warn] ${m}`);
const bad = (m) => console.log(`  [FAIL] ${m}`);
const info = (m) => console.log(`         ${m}`);

console.log('\nReva governance — host check\n');

// --- build ----------------------------------------------------------------
console.log('Build');
const entries = ['sessionStart.js', 'authorizePrompt.js', 'authorize.js', 'authorizePost.js', 'sessionEnd.js'];
const missing = entries.filter((e) => !fs.existsSync(path.join(ROOT, 'dist', 'src', e)));
if (missing.length) bad(`dist/src is missing ${missing.join(', ')} — run: npm install && npm run build`);
else ok('all four entrypoints compiled');

// --- config ---------------------------------------------------------------
console.log('\nConfiguration');
// Same source hooks use: ~/.kiro/settings/cli.json `env`, then process.env.
const cliJsonPath = path.join(process.env.KIRO_HOME || path.join(os.homedir(), '.kiro'), 'settings', 'cli.json');
let cliEnv = {};
try {
  const parsed = JSON.parse(fs.readFileSync(cliJsonPath, 'utf8'));
  if (parsed?.env && typeof parsed.env === 'object') cliEnv = parsed.env;
  ok(`cli.json       = ${cliJsonPath}`);
} catch {
  info(`cli.json       = ${cliJsonPath} (missing — using process.env only)`);
}
const eff = (key) => (process.env[key] && process.env[key].length ? process.env[key] : cliEnv[key]) || '';
const token = eff('REVA_AUTH_TOKEN');
if (token) {
  const src = process.env.REVA_AUTH_TOKEN ? 'process.env' : 'cli.json env';
  ok(`REVA_AUTH_TOKEN is set (${src})`);
} else {
  bad('REVA_AUTH_TOKEN is not set — put it in ~/.kiro/settings/cli.json env, or export it');
}
info(`REVA_HOST      = ${eff('REVA_HOST') || 'api.reva.ai (default)'}`);
const dataDir = eff('REVA_DATA_DIR') || path.join(os.homedir(), '.kiro', 'reva-governance');
info(`REVA_DATA_DIR  = ${dataDir}${eff('REVA_DATA_DIR') ? '' : ' (default)'}`);
if (eff('REVA_POLICY_STORE_ID')) {
  const header = eff('REVA_POLICY_STORE_HEADER') || 'policyStoreId';
  ok(`policy store    = ${eff('REVA_POLICY_STORE_ID')}`);
  info(`sent as header  ${header}`);
  info('NOTE: that header NAME is an assumption, not a confirmed Reva contract.');
  info('If your PDP wants it elsewhere, an unknown header is simply ignored —');
  info('so a wrong name looks identical to not setting it at all. Confirm with');
  info('whoever owns the PDP, then set REVA_POLICY_STORE_HEADER if it differs.');
} else {
  info('policy store    = not set (PDP resolves it from the auth token)');
}
try {
  fs.mkdirSync(dataDir, { recursive: true });
  ok('data directory is writable — turn/hop/spawn state will persist');
} catch {
  warn('data directory is NOT writable — every hook call will start from turn 1');
}
if (eff('REVA_DEBUG')) {
  const logFile = eff('REVA_DEBUG_LOG_FILE') || path.join(dataDir, 'debug.log');
  ok(`REVA_DEBUG log  = ${logFile}`);
}

// --- identity -------------------------------------------------------------
console.log('\nIdentity');

// The principal is what Cedar policies are actually evaluated against, and
// getting it wrong produces denials that look nothing like an identity
// problem — so report the RESOLVED value, not just whether a var is set.
let kiroEmail;
const whoamiStart = Date.now();
try {
  const out = execFileSync('kiro-cli', ['whoami'], { encoding: 'utf8', timeout: 20000 });
  kiroEmail = out.match(/^\s*Email:\s*(\S+@\S+)\s*$/m)?.[1];
} catch { /* reported below */ }
const whoamiMs = Date.now() - whoamiStart;

if (kiroEmail) {
  ok(`principal (User) = ${kiroEmail}   [Kiro login, ${whoamiMs}ms]`);
  if (whoamiMs > 8000) {
    info(`\`kiro-cli whoami\` is slow (${whoamiMs}ms). That is survivable — the`);
    info('account is cached for 24h and pre-warmed by npm run install-hooks —');
    info('but a cold resolve inside a session will stall a hook for that long.');
  }
  info('This email must exist as an ACTIVE User in your Reva policy store.');
  info('The plugin only ever creates Users with active="false", so a brand-new');
  info('one needs a human to activate it before any policy can permit it.');
} else {
  bad(`principal (User) = ${os.userInfo().username}   [OS USERNAME FALLBACK]`);
  info('`kiro-cli whoami` established no account, and none was cached.');
  info('Not an email, and almost certainly not a provisioned Reva User.');
  info('Ingestion creates it with active="false", and a deployment that gates');
  info('on active users denies everything for it — even under a wide-open');
  info('permit(principal, action, resource) policy.');
  info('Fix: run `kiro-cli login`, then `npm run install-hooks`.');
}

// The Agent id comes from the compiled resolver itself (dist/ is checked
// under "Build" above), so the doctor reports exactly what the hooks send
// instead of keeping a second copy of the logic in step by hand.
if (process.env.REVA_AGENT_ID) {
  ok(`Agent id       = ${process.env.REVA_AGENT_ID}   [REVA_AGENT_ID]`);
} else {
  let agentId;
  let kiroUserId;
  try {
    const deviceId = createRequire(import.meta.url)(path.join(ROOT, 'dist', 'src', 'deviceId.js'));
    kiroUserId = deviceId.readKiroUserId();
    agentId = kiroEmail ? deviceId.agentIdFromKiroUserId(kiroUserId) : undefined;
  } catch { /* reported below */ }
  if (agentId) {
    ok(`Agent id       = ${agentId}   [Kiro account id, from kiro-cli's user id ${kiroUserId}]`);
  } else {
    warn('Agent id       = UNRESOLVED — every hook will fail closed');
    if (!kiroEmail) info('No Kiro account is logged in. Run `kiro-cli login`.');
    else if (!kiroUserId) info("kiro-cli's local database could not be read (needs Node 22.5+; set REVA_KIRO_DB_PATH if it lives elsewhere).");
    else info(`kiro-cli's user id has an unrecognized shape: ${kiroUserId}`);
    info('Or set REVA_AGENT_ID explicitly.');
  }
}

// --- does the principal actually exist in the policy store? ----------------
//
// This is the check that matters most in practice. A PDP that answers 401
// USER_NOT_FOUND is not rejecting your policy — it never evaluated one,
// because the principal is not provisioned. That failure is invisible in a
// session (401 fails open, silently), and no Cedar policy can fix it:
// `permit(principal, action, resource)` still denies, because the request
// is refused before policy evaluation.
//
// Asks the ingestion API directly, which is the same directory the PDP
// resolves principals from.
async function checkPrincipalProvisioned(principal) {
  const host = (eff('REVA_HOST') || 'api.reva.ai').trim().replace(/\/+$/, '').replace(/^https?:\/\//, '');
  const scheme = /^(localhost|127\.0\.0\.1|\[::1\])/i.test(host) ? 'http' : 'https';
  const base = `${scheme}://${host}/ingestion/v2`;
  const headers = {
    'Content-Type': 'application/json',
    'X-API-Token': token,
    ...(eff('REVA_POLICY_STORE_ID')
      ? { [eff('REVA_POLICY_STORE_HEADER') || 'policyStoreId']: eff('REVA_POLICY_STORE_ID') }
      : {}),
  };

  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms))]);

  let types;
  try {
    const res = await withTimeout(fetch(`${base}/policy-store/entity-types`, { headers }), 10000);
    if (!res.ok) {
      bad(`entity-types lookup returned HTTP ${res.status} — cannot verify the principal`);
      if (res.status === 401) info('A 401 here means the AUTH TOKEN itself is rejected. Start there.');
      return;
    }
    types = await res.json();
  } catch (err) {
    warn(`could not reach the ingestion API (${err.message}) — skipping the provisioning check`);
    return;
  }

  const userType = (Array.isArray(types) ? types : []).find((t) => t?.name === 'User');
  if (!userType) {
    bad('this policy store declares no `User` entity type');
    info(`Types present: ${(Array.isArray(types) ? types : []).map((t) => t?.name).join(', ') || '(none)'}`);
    info('The store is probably using a different schema than this plugin targets.');
    return;
  }

  try {
    const url = `${base}/entity/${encodeURIComponent(principal)}?entityTypeId=${encodeURIComponent(userType.id)}`;
    const res = await withTimeout(fetch(url, { headers }), 10000);
    if (res.status === 404 || res.status === 400) {
      bad(`User "${principal}" does NOT exist in this policy store`);
      info('This is exactly what a PDP reports as USER_NOT_FOUND, and it is why you');
      info('see Deny under a wide-open permit(principal, action, resource) policy —');
      info('the request is refused before any policy is evaluated.');
      info('The session-start hook tries to create it; check the debug log for');
      info('"sessionStart: ingest User failed". If creation succeeded, the store the');
      info('hook wrote to is not the store you are reading.');
      return;
    }
    if (!res.ok) {
      warn(`entity lookup returned HTTP ${res.status} — inconclusive`);
      return;
    }
    const entity = await res.json();
    const active = (entity?.entityAttributes || []).find((a) => a?.name === 'active')?.value;
    if (String(active) === 'true') {
      ok(`User "${principal}" exists and is active`);
    } else {
      bad(`User "${principal}" exists but active="${active}"`);
      info('This plugin only ever creates Users with active="false" — it has no way');
      info('to vet that a human is real. A person must flip this on the Reva side');
      info('before any policy can permit this principal.');
    }
  } catch (err) {
    warn(`entity lookup failed (${err.message}) — inconclusive`);
  }
}

if (token) {
  console.log('\nPolicy store');
  await checkPrincipalProvisioned(kiroEmail || os.userInfo().username);
}

// --- registration ---------------------------------------------------------
console.log('\nRegistration');
const ideDir = path.join(os.homedir(), '.kiro', 'hooks');
const ideFiles = fs.existsSync(ideDir) ? fs.readdirSync(ideDir).filter((f) => f.startsWith('reva-') && f.endsWith('.json')) : [];
// reva-stop.json is what earlier versions wrote in place of reva-session-end.json.
if (ideFiles.includes('reva-stop.json')) warn('Kiro IDE: reva-stop.json is from an older version — run: npm run install-hooks');
if (ideFiles.length === 5 && ideFiles.includes('reva-session-end.json')) ok(`Kiro IDE: 5 hooks in ${ideDir}`);
else if (ideFiles.length) warn(`Kiro IDE: only ${ideFiles.length}/5 hooks in ${ideDir}`);
else warn(`Kiro IDE: no hooks in ${ideDir} — run: npm run install-hooks`);

const agentsDir = path.join(os.homedir(), '.kiro', 'agents');
const cliAgents = [];
const unenforcedAgents = [];
if (fs.existsSync(agentsDir)) {
  for (const f of fs.readdirSync(agentsDir).filter((f) => f.endsWith('.json'))) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(agentsDir, f), 'utf8'));
      const reva = Object.values(cfg.hooks || {}).flat().filter((h) => String(h?.command || '').includes('dist/src'));
      if (reva.length) cliAgents.push(`${path.basename(f, '.json')} (${reva.length} hooks)`);
      // On Windows a hook without the exit-code suffix cannot block: PowerShell
      // turns its exit 2 into 1 and kiro-cli runs the tool anyway.
      if (process.platform === 'win32' && reva.some((h) => !String(h.command).includes('$LASTEXITCODE'))) {
        unenforcedAgents.push(path.basename(f, '.json'));
      }
    } catch { /* not our file to complain about */ }
  }
}
if (cliAgents.length) ok(`kiro-cli: ${cliAgents.join(', ')}`);
else warn('kiro-cli: no agent config carries Reva hooks — run: npm run install-hooks');
if (unenforcedAgents.length) {
  bad(`kiro-cli: hooks in ${unenforcedAgents.join(', ')} lack "; exit $LASTEXITCODE" — denies will NOT block on Windows`);
  info('Fix: npm run install-hooks -- --cli');
}

// --- enforcement ----------------------------------------------------------
console.log('\nEnforcement (what a deny actually does here)');
info('Kiro IDE  PreToolUse/UserPromptSubmit : exit 2 + stderr BLOCKS');
info('Kiro IDE  PostToolUse                 : ignored (audit only)');

if (!probeCli) {
  info('kiro-cli  preToolUse/userPromptSubmit : exit 2 BLOCKS (re-run with --probe-cli to test)');
  info('');
  info('Measured on kiro-cli 2.36.0: a deny blocks — on Windows only with the');
  info('"; exit $LASTEXITCODE" suffix npm run install-hooks now writes, because');
  info('PowerShell otherwise turns exit 2 into 1. Re-run install-hooks if your');
  info('agent hooks predate it.');
} else {
  const probeJs = path.join(ROOT, 'scripts', '.doctor-probe.cjs');
  const marker = `REVA-DOCTOR-${Date.now()}`;
  const flag = path.join(os.tmpdir(), `reva-doctor-${process.pid}.flag`);
  fs.writeFileSync(
    probeJs,
    `let r='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>r+=d);` +
      `process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(flag)},'fired');` +
      `process.stderr.write('reva-doctor probe: denied\\n');process.exit(2);});\n`,
  );
  const agentFile = path.join(agentsDir, 'reva-doctor-probe.json');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    agentFile,
    JSON.stringify(
      {
        name: 'reva-doctor-probe',
        description: 'temporary enforcement probe',
        prompt: null, mcpServers: {}, tools: ['shell'], toolAliases: {},
        allowedTools: ['shell'], resources: [], toolsSettings: {},
        includeMcpJson: false, model: null,
        // Same command form install-hooks.mjs writes, including the
        // Windows exit-code suffix — the probe must test what is installed.
        hooks: {
          preToolUse: [
            {
              matcher: '*',
              command: `node "${probeJs.split(path.sep).join('/')}"${process.platform === 'win32' ? '; exit $LASTEXITCODE' : ''}`,
              timeout_ms: 20000,
            },
          ],
        },
      },
      null, 2,
    ),
  );
  try {
    info('running one real kiro-cli turn with an always-deny hook...');
    const run = spawnSync(
      'kiro-cli',
      ['chat', '--agent', 'reva-doctor-probe', '--no-interactive', '--trust-all-tools',
       `Run the shell command: echo ${marker}`],
      { encoding: 'utf8', timeout: 180000 },
    );
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    const hookFired = fs.existsSync(flag);
    const commandRan = output.includes(marker) && !output.includes(`echo ${marker}`.replace(marker, marker + 'X'));
    if (!hookFired) {
      bad('kiro-cli: the preToolUse hook never fired — hooks are not wired up on this version');
    } else if (commandRan) {
      warn('kiro-cli: hook fired and exited 2, but the command STILL RAN → audit-only');
      info('Denies are recorded in Reva but not enforced by this CLI version.');
    } else {
      ok('kiro-cli: exit 2 BLOCKED the tool → this version enforces denies');
    }
  } finally {
    for (const f of [probeJs, agentFile, flag]) { try { fs.unlinkSync(f); } catch {} }
  }
}

console.log('');
