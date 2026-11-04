"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.surfaceFromProcess = surfaceFromProcess;
exports.surfaceFromAncestors = surfaceFromAncestors;
exports.nearestKiroProcess = nearestKiroProcess;
exports.listAncestorProcesses = listAncestorProcesses;
exports.resolveSessionSurface = resolveSessionSurface;
exports.resolveSessionEntrypoint = resolveSessionEntrypoint;
// Which Kiro product launched this hook: kiro-cli or the Kiro desktop app.
//
// Needed because the payload alone no longer says. kiro-cli 2.x sends
// camelCase triggers (host.ts tells it apart by those), but kiro-cli V3 reads
// the same ~/.kiro/hooks/*.json files as the desktop app and sends the
// identical payload — same fields, same PascalCase hook_event_name, same
// `sess_` session id, confirmed from a real V3 session on Windows. So for an
// IDE-shaped payload the answer comes from the
// hook's parent processes instead: the nearest Kiro product above it.
//
// Nearest-first matters: kiro-cli started in the desktop app's own terminal
// has both above it, and the nearer one (kiro-cli) is the right answer.
const node_child_process_1 = require("node:child_process");
const activeSessions_1 = require("./activeSessions");
const debug_1 = require("./debug");
const host_1 = require("./host");
// 'C:\…\Kiro-Cli\kiro-cli.exe' -> 'cli'; '/Applications/Kiro.app/…' -> 'desktop';
// anything else (node, cmd, powershell, a terminal) -> undefined, never guessed.
function surfaceFromProcess(nameOrPath) {
    if (!nameOrPath)
        return undefined;
    const slashed = nameOrPath.replace(/\\/g, '/');
    // macOS: the app and its helpers ("Kiro Helper (Plugin)", which runs the
    // extension host) all live inside the bundle.
    if (/\/Kiro\.app\//i.test(slashed))
        return 'desktop';
    // Windows: %LOCALAPPDATA%\Kiro-Cli holds kiro-cli.exe, the chat-cli-*.exe
    // builds and the node.exe/bun.exe V3 runs its agent on — any of them is cli.
    if (/\/Kiro-Cli\//i.test(slashed))
        return 'cli';
    const exe = (slashed.split('/').pop() || '').replace(/\.exe$/i, '').trim().toLowerCase();
    if (exe === 'kiro')
        return 'desktop';
    if (exe === 'kiro-cli' || exe.startsWith('kiro-cli-') || exe.startsWith('chat-cli'))
        return 'cli';
    return undefined;
}
function surfaceFromAncestors(ancestors) {
    for (const name of ancestors) {
        const surface = surfaceFromProcess(name);
        if (surface)
            return surface;
    }
    return undefined;
}
// The nearest Kiro product above this hook, and — for kiro-cli — that
// process's id. It is this session's own process (each kiro-cli session runs
// its own chain: kiro-cli → bun → kiro-cli chat → node on V3), so
// it exits when the session does, however the session ends. The desktop
// app's Kiro.exe is shared by every chat, so no id is kept for it.
function nearestKiroProcess(ancestors) {
    for (const proc of ancestors) {
        const surface = surfaceFromProcess(proc.name);
        if (surface)
            return surface === 'cli' && proc.pid ? { surface, pid: proc.pid } : { surface };
    }
    return {};
}
const PROCESS_WALK_DEPTH = 12;
const PROCESS_LOOKUP_TIMEOUT_MS = 8000;
// One PowerShell call, one CIM query for every process, then the chain is
// walked in memory: ~1.5s, against ~3.5s for a query per level, measured on
// Windows 11. Sent as
// -EncodedCommand: a multi-line script on stdin does not run reliably.
// Each line is "<pid>|<path or name>".
function windowsAncestors(startPid) {
    const script = [
        "$ProgressPreference = 'SilentlyContinue'",
        `$p = ${Math.trunc(startPid)}`,
        '$all = @{}',
        'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath | ForEach-Object { $all[[int]$_.ProcessId] = $_ }',
        `for ($i = 0; $i -lt ${PROCESS_WALK_DEPTH} -and $all.ContainsKey($p); $i++) {`,
        '  $x = $all[$p]',
        '  if ($x.ExecutablePath) { "$p|$($x.ExecutablePath)" } else { "$p|$($x.Name)" }',
        '  $p = [int]$x.ParentProcessId',
        '}',
    ].join('\n');
    const out = (0, node_child_process_1.execFileSync)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: PROCESS_LOOKUP_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
        const cut = line.indexOf('|');
        const pid = Number(line.slice(0, cut));
        return cut > 0 && Number.isInteger(pid) ? { pid, name: line.slice(cut + 1) } : { name: line };
    });
}
function unixAncestors(startPid) {
    const found = [];
    let pid = startPid;
    for (let i = 0; i < PROCESS_WALK_DEPTH && pid > 1; i++) {
        const out = (0, node_child_process_1.execFileSync)('ps', ['-o', 'ppid=', '-o', 'comm=', '-p', String(pid)], {
            encoding: 'utf8',
            timeout: PROCESS_LOOKUP_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const match = out.match(/^(\d+)\s+(.+)$/);
        if (!match)
            break;
        found.push({ pid, name: match[2] });
        pid = Number(match[1]);
    }
    return found;
}
// The processes above this hook, nearest first; empty when the lookup fails.
function listAncestorProcesses(startPid = process.ppid) {
    try {
        return process.platform === 'win32' ? windowsAncestors(startPid) : unixAncestors(startPid);
    }
    catch {
        return [];
    }
}
// context.sessionEntryPoint for this hook, plus the session's kiro-cli
// process id. The process lookup costs about a second on Windows, so it runs
// once per session: the first hook to resolve it stores the answer in the
// active-sessions entry and every later hook of the session reuses it. Order:
// REVA_SESSION_ENTRYPOINT → kiro-cli 2.x (payload says so) → this session's
// stored answer → parent processes → 'Kiro Desktop' when nothing Kiro is
// found (the previous behaviour).
function resolveSessionSurface(opts) {
    const env = opts.env ?? process.env;
    if (env.REVA_SESSION_ENTRYPOINT?.trim() || opts.host === 'kiro-cli')
        return { entrypoint: (0, host_1.sessionEntrypoint)(opts.host, env) };
    const stored = opts.sessionId ? (0, activeSessions_1.getSessionEntry)(opts.agentId, opts.sessionId, opts.pluginDataDir)?.entrypoint : undefined;
    if (stored === host_1.CLI_ENTRYPOINT || stored === host_1.DESKTOP_ENTRYPOINT)
        return { entrypoint: stored };
    const ancestors = (opts.listAncestors ?? listAncestorProcesses)();
    const { surface, pid } = nearestKiroProcess(ancestors);
    (0, debug_1.debugLog)(`surface: ${surface ?? 'none found — assuming desktop'}${pid ? ` (kiro-cli pid ${pid})` : ''} ` +
        `from parent processes [${ancestors.map((a) => a.name).join(' < ')}]`);
    return surface === 'cli' ? { entrypoint: host_1.CLI_ENTRYPOINT, pid } : { entrypoint: host_1.DESKTOP_ENTRYPOINT };
}
function resolveSessionEntrypoint(opts) {
    return resolveSessionSurface(opts).entrypoint;
}
