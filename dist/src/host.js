"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DESKTOP_ENTRYPOINT = exports.CLI_ENTRYPOINT = void 0;
exports.detectHost = detectHost;
exports.normalizeInput = normalizeInput;
exports.sessionEntrypoint = sessionEntrypoint;
exports.hostLabel = hostLabel;
exports.blocksAt = blocksAt;
exports.emitDecision = emitDecision;
// ---------------------------------------------------------------------------
// Host adapter — the ONLY file that knows Kiro ships two different, mutually
// incompatible hook systems. Everything else in src/ works off the canonical
// shape this file produces.
//
// All of the below was captured from real sessions / read out of the shipped
// binaries, not taken from kiro.dev's docs (which disagreed with the shipped
// implementation on both hosts):
//
//                        Kiro IDE                     kiro-cli
//   registration    ~/.kiro/hooks/*.json         agent config `hooks` field
//   triggers        PascalCase                   camelCase
//                   SessionStart                 agentSpawn
//                   UserPromptSubmit             userPromptSubmit
//                   PreToolUse                   preToolUse
//                   PostToolUse                  postToolUse
//   session id      `session_id` in payload      KIRO_SESSION_ID env var
//   tool names      fsWrite/grepSearch/...       fs_read/fs_write/execute_cmd/...
//   shell (win)     cmd.exe                      PowerShell
//   deny            exit 2 + stderr  (WORKS)     exit 2 + stderr (NOT honored yet)
//   ask             stdout permissionDecision    unsupported
// ---------------------------------------------------------------------------
// kiro-cli's camelCase trigger names → the canonical (IDE-style) names the
// rest of this plugin uses. `stop` has no canonical equivalent — this plugin
// registers no hook for it.
const CLI_EVENT_ALIASES = {
    agentSpawn: 'SessionStart',
    userPromptSubmit: 'UserPromptSubmit',
    preToolUse: 'PreToolUse',
    postToolUse: 'PostToolUse',
    stop: 'Stop',
};
// SessionEnd: the Kiro desktop app and kiro-cli V3 only, fired when a session
// is torn down (payload adds `reason`). Not in Kiro's public trigger list yet;
// read from Kiro's own implementation.
const IDE_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']);
// Detect from the payload's own trigger name rather than from an env var or
// a build flag: the trigger name is the one field both hosts always send,
// and its casing is unambiguous between them. `expected` is the entrypoint's
// own declared event, used only when a host sends no recognizable name at
// all (then the presence of KIRO_SESSION_ID is the tiebreak, since only
// kiro-cli passes the session id that way).
function detectHost(raw, expected, env = process.env) {
    const name = typeof raw.hook_event_name === 'string' ? raw.hook_event_name : '';
    if (IDE_EVENTS.has(name))
        return { host: 'kiro-ide', event: name };
    const aliased = CLI_EVENT_ALIASES[name];
    if (aliased)
        return { host: 'kiro-cli', event: aliased };
    // Unrecognized/absent trigger name. Don't guess the event — the entrypoint
    // knows which one it was registered for; only the host is in question.
    const host = raw.session_id ? 'kiro-ide' : env.KIRO_SESSION_ID ? 'kiro-cli' : 'kiro-ide';
    return { host, event: expected };
}
// Normalizes both hosts' payloads into one shape.
//
// The session id is the important part: kiro-cli does NOT put session_id in
// the JSON at all (confirmed by capturing real kiro-cli payloads), it exposes
// it as the KIRO_SESSION_ID environment variable instead. Every
// piece of per-session state in this plugin (turn cache, hop chain, spawn
// counter, active-session registry, trace id, `session.id` on the wire) is
// keyed by it, so resolving it in exactly one place is what keeps both hosts
// working off the same machinery.
function normalizeInput(raw, expected, env = process.env) {
    const { host, event } = detectHost(raw, expected, env);
    return {
        host,
        event,
        // Empty string rather than a fabricated id when neither source has one:
        // the caches below treat an empty session id as "nothing honest to key
        // by" and no-op, which is the correct degradation.
        sessionId: (typeof raw.session_id === 'string' && raw.session_id) || env.KIRO_SESSION_ID || '',
        cwd: typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : process.cwd(),
        promptId: typeof raw.prompt_id === 'string' ? raw.prompt_id : undefined,
        prompt: typeof raw.prompt === 'string' ? raw.prompt : undefined,
        toolName: typeof raw.tool_name === 'string' ? raw.tool_name : undefined,
        toolInput: raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {},
        toolResponse: raw.tool_response,
        // Neither host exposes a sub-agent marker on the hook payload today
        // (IDE: confirmed absent from the payload builder; CLI: absent from every
        // captured payload). Kept so a future host version that adds one under
        // these names starts working without another change here.
        subAgentId: typeof raw.agent_id === 'string' ? raw.agent_id : undefined,
        subAgentType: typeof raw.agent_type === 'string' ? raw.agent_type : undefined,
        raw,
    };
}
// The surface reported as context.sessionEntryPoint: 'cli' for a terminal
// session and 'Kiro Desktop' for Kiro's own desktop app, so Reva maps it to
// the Desktop App surface. The Kiro IDE is Kiro's desktop app rather than
// an editor extension, so it is not reported as 'ide-<editor>'.
//
//   kiro-cli  -> 'cli'
//   Kiro IDE  -> 'Kiro Desktop'
//
// This function only knows what the payload says. kiro-cli V3 sends the
// IDE-shaped payload, so hooks call surface.ts's resolveSessionEntrypoint,
// which settles an IDE-shaped payload from the parent processes.
//
// THESE STRINGS ARE POLICY-VISIBLE: changing one silently stops a policy
// written against it from matching. REVA_SESSION_ENTRYPOINT names the
// surface explicitly when a deployment needs a different value; Kiro's host
// is always detected, so it is checked first rather than as a fallback.
exports.CLI_ENTRYPOINT = 'cli';
exports.DESKTOP_ENTRYPOINT = 'Kiro Desktop';
function sessionEntrypoint(host, env = process.env) {
    const declared = env.REVA_SESSION_ENTRYPOINT?.trim();
    if (declared)
        return declared;
    return host === 'kiro-cli' ? exports.CLI_ENTRYPOINT : exports.DESKTOP_ENTRYPOINT;
}
// The entrypoint's env-var override, so `npm run doctor` and the test suite
// can force a host without fabricating a payload.
function hostLabel(host) {
    return host === 'kiro-cli' ? 'kiro-cli' : 'Kiro IDE';
}
// True when this host actually enforces a deny at this event. Used only for
// honest logging — the deny is emitted either way (see emitDecision).
function blocksAt(host, event) {
    // Both hosts block on exit 2 at these two triggers. For kiro-cli this was
    // long believed not to work (three probes on 2.21.2 failed) — the real
    // cause was PowerShell discarding the exit code on Windows, not kiro-cli.
    // With the `; exit $LASTEXITCODE` suffix install-hooks.mjs now writes, an
    // always-deny preToolUse hook blocked `Remove-Item` in a real kiro-cli
    // 2.36.0 session. Hooks installed before that change are still
    // audit-only on Windows until `npm run install-hooks` is re-run.
    return event === 'PreToolUse' || event === 'UserPromptSubmit';
}
// The single place either host's native allow/deny/ask signal is produced.
//
// Deny is emitted as exit 2 + reason on stderr for BOTH hosts. That is the
// real, working contract on the IDE and the documented (not yet honored)
// one on the CLI — emitting it anyway costs nothing today and starts
// enforcing the moment kiro-cli wires its own block path up, without a
// code change here.
function emitDecision(host, event, result) {
    // No Reva decision at all (PDP outage/auth failure). Emitting an explicit
    // allow here would bypass the host's own native permission behavior, which
    // is the one thing a governance plugin must never do on its way down.
    if (result.inactive)
        process.exit(0);
    if (event === 'PostToolUse' || event === 'SessionStart' || event === 'Stop' || event === 'SessionEnd') {
        // Both hosts ignore output from these entirely — the tool already ran /
        // the session already started/ended. Stop is local cleanup only (no PDP).
        process.exit(0);
    }
    if (result.decision === 'deny') {
        process.stderr.write(`${result.reason || 'Blocked by Reva governance policy'}\n`);
        process.exit(2);
    }
    if (result.decision === 'ask') {
        const reason = result.reason || 'Requires manual approval per Reva governance policy';
        if (host === 'kiro-ide' && event === 'PreToolUse') {
            // The one stdout-JSON shape the IDE actually parses, and only at exit
            // 0 (its PreToolUse handler runs this parser and no other).
            process.stdout.write(JSON.stringify({
                hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
            }));
            process.exit(0);
        }
        // Everywhere else there is no structured "ask": the IDE's
        // UserPromptSubmit and both of kiro-cli's blockable triggers surface a
        // hook's stdout to the agent as plain context text at exit 0. Say it in
        // a sentence rather than emitting a field the host would just ignore.
        process.stdout.write(`Reva governance: this action requires elevated review (${reason}); it was not auto-approved by policy.`);
        process.exit(0);
    }
    // Plain allow: exit 0, print nothing.
    process.exit(0);
}
