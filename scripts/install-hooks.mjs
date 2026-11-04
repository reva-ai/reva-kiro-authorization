#!/usr/bin/env node
// Registers this power's hooks with BOTH of Kiro's hook systems — the hooks
// and nothing else (see installCli for the one field a new CLI agent needs).
//
// Neither host installs hooks as part of installing a power, and the two
// use different mechanisms that do not see each other's config:
//
//   Kiro IDE  -> ~/.kiro/hooks/*.json          (or <project>/.kiro/hooks/)
//   kiro-cli  -> ~/.kiro/agents/<agent>.json, "hooks" field
//
// Usage:
//   node scripts/install-hooks.mjs                     # both hosts, global scope
//   node scripts/install-hooks.mjs --ide               # IDE only
//   node scripts/install-hooks.mjs --cli               # kiro-cli only
//   node scripts/install-hooks.mjs --agent my-agent    # target a specific CLI agent
//   node scripts/install-hooks.mjs --project /path     # IDE hooks into that project
//   node scripts/install-hooks.mjs --uninstall
//
// Every command is emitted as a bare `node "<abs path>.js"` invocation.
// That matters: the IDE spawns hook commands through cmd.exe on Windows and
// kiro-cli spawns them through PowerShell, and a quoted path to a .cmd/.sh
// wrapper parses in the first but not the second ("Unexpected token" —
// PowerShell needs `&` before a quoted executable path). `node <path>` is
// the one form both shells agree on.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const DIST = path.join(ROOT, 'dist', 'src');

const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

const uninstall = has('--uninstall');
const onlyIde = has('--ide');
const onlyCli = has('--cli');
const doIde = !onlyCli;
const doCli = !onlyIde;
const agentName = valueOf('--agent') || 'reva-governance';
const projectDir = valueOf('--project');

// entry script -> [IDE trigger, CLI trigger (null: not installed for
// kiro-cli 2.x), matcher (tool-name triggers only), timeout seconds]
const HOOKS = [
  // 45s, NOT the 10s this used to carry. A cold session-start resolves the
  // Kiro account and lists MCP servers, both of which shell out to kiro-cli
  // and are slow (measured: 10,341ms cold, 380ms warm). At 10s the host
  // killed the hook mid-flight and NOTHING was ingested — silently, because
  // a killed best-effort hook looks identical to one that had nothing to do.
  // Session start is non-blocking by design, so a generous budget costs the
  // user nothing.
  ['sessionStart.js',    'SessionStart',     'agentSpawn',       null, 45],
  ['authorizePrompt.js', 'UserPromptSubmit', 'userPromptSubmit', null, 30],
  ['authorize.js',       'PreToolUse',       'preToolUse',       '*',  45],
  ['authorizePost.js',   'PostToolUse',      'postToolUse',      '*',  45],
  // `SessionEnd` — the session is closing (Kiro desktop app and kiro-cli V3,
  // which share these files). Drops it from the local active-session count.
  // Not `Stop`: Kiro fires that after every reply, so an open session idling
  // at its prompt was dropped from the count. 5s because Kiro gives
  // SessionEnd hooks 5s in total. kiro-cli 2.x has no such event, so it gets
  // none — its sessions leave the count through the 10-minute idle TTL.
  ['sessionEnd.js',      'SessionEnd',       null,               null, 5],
];

// Registrations earlier versions wrote, removed on every install and
// uninstall so an upgrade never leaves them firing.
const LEGACY_IDE_FILES = ['reva-stop.json'];
const LEGACY_CLI_TRIGGERS = ['stop'];

function command(entry) {
  return `node "${path.join(DIST, entry).split(path.sep).join('/')}"`;
}

// kiro-cli runs hook commands through PowerShell on Windows, and
// `powershell -Command node <script>` DISCARDS the script's exit code:
// a deny (exit 2) arrives as exit 1, which kiro-cli treats as a non-blocking
// hook error — so the denied tool call RAN. Confirmed on kiro-cli 2.36.0:
// the same always-deny hook let `Remove-Item` delete its target without this
// suffix and blocked it with the suffix. POSIX shells pass the exit code
// through natively, and the IDE runs hooks through cmd.exe, where this
// syntax would be wrong — so it is added for kiro-cli on Windows only.
function cliCommand(entry) {
  return process.platform === 'win32' ? `${command(entry)}; exit $LASTEXITCODE` : command(entry);
}

function assertBuilt() {
  const missing = HOOKS.map(([e]) => e).filter((e) => !fs.existsSync(path.join(DIST, e)));
  if (missing.length) {
    console.error(`Not built yet — missing ${missing.join(', ')} in ${DIST}\nRun: npm install && npm run build`);
    process.exit(1);
  }
}

// --- Kiro IDE: ~/.kiro/hooks/*.json (or <project>/.kiro/hooks/) ------------
// Both scopes are merged by the IDE rather than one overriding the other,
// so a global install is active in every project.
function installIde() {
  const dir = projectDir
    ? path.join(path.resolve(projectDir), '.kiro', 'hooks')
    : path.join(os.homedir(), '.kiro', 'hooks');
  const files = [
    ['reva-session-start.json',  'reva-governance-session-start',  0],
    ['reva-prompt-submit.json',  'reva-governance-prompt-submit',  1],
    ['reva-pre-tool-use.json',   'reva-governance-pre-tool-use',   2],
    ['reva-post-tool-use.json',  'reva-governance-post-tool-use',  3],
    ['reva-session-end.json',    'reva-governance-session-end',    4],
  ];
  for (const file of LEGACY_IDE_FILES) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`removed ${p} (replaced)`); }
  }
  if (uninstall) {
    for (const [file] of files) {
      const p = path.join(dir, file);
      if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`removed ${p}`); }
    }
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, name, i] of files) {
    const [entry, ideTrigger, , matcher, timeout] = HOOKS[i];
    const hook = {
      name,
      description: `Reva governance — ${ideTrigger}`,
      trigger: ideTrigger,
      // The IDE's matcher is a REGEX tested against the tool name, and only
      // for tool-name triggers; kiro-cli's is a glob. Hence '.*' here and
      // '*' below — same intent, different syntax, easy to get backwards.
      ...(matcher ? { matcher: '.*' } : {}),
      action: { type: 'command', command: command(entry) },
      timeout,
    };
    const p = path.join(dir, file);
    fs.writeFileSync(p, JSON.stringify({ version: 'v1', hooks: [hook] }, null, 2) + '\n');
    console.log(`wrote ${p}`);
  }
}

// --- kiro-cli: agent config `hooks` field ----------------------------------
// This installer writes HOOKS, and nothing else.
//
// An existing agent (--agent <name>) gets only its `hooks` field changed:
// the Reva entries are added or removed, every other field — tools, MCP
// servers, prompt, permissions — is left exactly as it was.
//
// A NEW agent is the bare minimum Kiro needs to run: name, description,
// `tools: ["shell", "use_subagent"]`, and the hooks. The tools field is
// required: confirmed on kiro-cli 2.36.0, an agent with no `tools`
// field gets no tools at all (the model only describes what it would do).
//   shell        — the only FILE-capable tool, deliberately: with no
//                  dedicated read/write/MCP file tools, every file operation
//                  becomes a shell command, evaluated as `executeBash` and
//                  parsed for the paths it touches (src/shellTargets.ts).
//   use_subagent — so the model can start real sub-agents. Without it, a
//                  "use 4 sub-agents" prompt was answered with four shell
//                  commands pretending to be sub-agents (seen in practice), so no
//                  `spawn` was ever evaluated and no subagentIndex guardrail
//                  could fire. Each sub-agent it starts is its own `spawn`.
// MCP servers, extra tools, prompts and auto-approval are the user's choice,
// made in the agent file — never by this script.
function installCli() {
  const dir = path.join(os.homedir(), '.kiro', 'agents');
  const file = path.join(dir, `${agentName}.json`);
  let cfg;
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`Refusing to touch ${file} — it is not valid JSON (${err.message}).`);
      process.exit(1);
    }
  } else if (uninstall) {
    console.log(`no CLI agent at ${file} — nothing to remove`);
    return;
  } else {
    cfg = {
      name: agentName,
      description: 'Kiro CLI agent governed by Reva',
      tools: ['shell', 'use_subagent'],
    };
  }

  // Match on this power's ROOT, not on "dist/src": an earlier install that
  // pointed somewhere else inside the same tree would otherwise be left
  // behind — which shows up as every hook firing twice rather than as an error.
  const rootPrefix = ROOT.split(path.sep).join('/');
  const isReva = (h) => typeof h?.command === 'string' && h.command.includes(rootPrefix);
  cfg.hooks = cfg.hooks || {};
  for (const trigger of LEGACY_CLI_TRIGGERS) {
    const kept = (cfg.hooks[trigger] || []).filter((h) => !isReva(h));
    if (kept.length) cfg.hooks[trigger] = kept;
    else delete cfg.hooks[trigger];
  }
  for (const [entry, , cliTrigger, matcher, timeout] of HOOKS) {
    if (!cliTrigger) continue;
    const existing = (cfg.hooks[cliTrigger] || []).filter((h) => !isReva(h));
    if (uninstall) {
      if (existing.length) cfg.hooks[cliTrigger] = existing;
      else delete cfg.hooks[cliTrigger];
      continue;
    }
    cfg.hooks[cliTrigger] = [
      ...existing,
      {
        ...(matcher ? { matcher: '*' } : {}),
        command: cliCommand(entry),
        description: `Reva governance — ${cliTrigger}`,
        timeout_ms: timeout * 1000,
      },
    ];
  }
  if (uninstall && Object.keys(cfg.hooks).length === 0) delete cfg.hooks;

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`${uninstall ? 'cleaned' : 'wrote'} ${file}`);
  if (!uninstall) console.log(`  run it with:  kiro-cli chat --agent ${agentName}`);
}

// Resolving the Kiro account shells out to `kiro-cli whoami`, which was
// measured at ~10s on a machine whose credentials needed refreshing — and
// Node cannot reliably time that out (see deviceId.ts). Paying it HERE,
// once, at install time keeps it out of the first hook call of the user's
// next session, where it would add that latency to a real action and could
// exceed the IDE's own 10s SessionStart hook timeout.
//
// Best-effort by definition: a failure here just means the first session
// resolves it instead, which is the behaviour without this step anyway.
function warmAccountCache() {
  if (process.env.REVA_AGENT_ID) {
    console.log('skipping account pre-warm — REVA_AGENT_ID is set, so whoami is never consulted');
    return;
  }
  process.stdout.write('pre-warming the Kiro account cache (runs `kiro-cli whoami`, may take a few seconds)... ');
  try {
    // Use the compiled resolver rather than re-implementing the cache
    // format here — two writers of one file is how formats drift apart.
    const deviceId = require(path.join(DIST, 'deviceId.js'));
    const email = deviceId.readKiroAccountEmail();
    console.log(email ? `done (${email})` : 'no account logged in — set REVA_AGENT_ID, or run `kiro-cli login`');
  } catch (err) {
    console.log(`skipped (${err.message})`);
  }
}

if (!uninstall) assertBuilt();
if (doIde) installIde();
if (doCli) installCli();
if (!uninstall) warmAccountCache();

if (!uninstall) {
  console.log('\nPut REVA_* in ~/.kiro/settings/cli.json (preferred):');
  console.log('  { "env": { "REVA_AUTH_TOKEN": "…", "REVA_HOST": "…" } }');
  console.log('Or export them in the shell that launches Kiro (overrides the file).');
  console.log('  REVA_AUTH_TOKEN   (required)');
  console.log('  REVA_HOST         (default api.reva.ai)');
  console.log('  REVA_AGENT_ID     (optional — defaults to the `kiro-cli whoami` account)');
  console.log('\nThen check what is actually enforced here:  npm run doctor');
}
