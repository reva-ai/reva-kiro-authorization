"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.modelFromCommandLine = modelFromCommandLine;
exports.readLaunchModelFlag = readLaunchModelFlag;
exports.parseDefaultModel = parseDefaultModel;
exports.readKiroDefaultModel = readKiroDefaultModel;
const node_child_process_1 = require("node:child_process");
// The model a kiro-cli session was STARTED with: `kiro-cli chat --model <id>`.
//
// Why this exists: Kiro writes the session's model into its own record only
// after the first turn completes. During that whole first turn the record
// holds the placeholder "auto" — even for a session started with
// `--model claude-haiku-4.5` (confirmed on kiro-cli 2.36.0). The flag is the
// only place the chosen model exists before then: hooks get no model in
// their payload or environment.
//
// Read from the hook's ancestor processes. Confirmed on Windows: the
// chain is hook (node) <- powershell <- `kiro-cli acp --agent-engine=v2` <-
// `kiro-cli chat --agent … --model claude-haiku-4.5 …`. On macOS/Linux the
// shell in between differs but the `kiro-cli chat` ancestor is the same.
//
// Costs ~2s on Windows (a PowerShell process query), so it runs ONCE per
// session, from session start, and the result is kept in the session's
// model memo (see kiroSession.ts) — never on the per-tool-call path.
// Best-effort: any failure is simply "no flag".
const MAX_DEPTH = 6;
// `--model x` or `--model=x`, only on a `kiro-cli … chat` command line.
function modelFromCommandLine(commandLine) {
    if (!/kiro-cli(\.exe)?["']?\s+chat\b/i.test(commandLine))
        return undefined;
    const match = commandLine.match(/--model(?:=|\s+)("([^"]+)"|'([^']+)'|(\S+))/);
    const value = match?.[2] ?? match?.[3] ?? match?.[4];
    return value && !value.startsWith('-') ? value : undefined;
}
function ancestorCommandLinesWindows() {
    const script = `$p=${process.ppid}; for($i=0;$i -lt ${MAX_DEPTH};$i++){ ` +
        `$w=Get-CimInstance Win32_Process -Filter "ProcessId=$p"; if(-not $w){break}; ` +
        `[string]$w.CommandLine; $p=$w.ParentProcessId }`;
    const out = (0, node_child_process_1.execFileSync)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        // A hook's stdout/stderr are Kiro's decision channels — nothing a child
        // process prints may reach them.
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).filter(Boolean);
}
function ancestorCommandLinesPosix() {
    const lines = [];
    let pid = process.ppid;
    for (let i = 0; i < MAX_DEPTH && pid > 1; i++) {
        const out = (0, node_child_process_1.execFileSync)('ps', ['-o', 'ppid=,args=', '-p', String(pid)], {
            encoding: 'utf8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const match = out.match(/^(\d+)\s+(.*)$/);
        if (!match)
            break;
        lines.push(match[2]);
        pid = Number(match[1]);
    }
    return lines;
}
function readLaunchModelFlag(readAncestors = process.platform === 'win32' ? ancestorCommandLinesWindows : ancestorCommandLinesPosix) {
    try {
        for (const line of readAncestors()) {
            const model = modelFromCommandLine(line);
            if (model)
                return model;
        }
    }
    catch {
        // no flag we can see
    }
    return undefined;
}
// Kiro's own default model — what a session uses when nothing chose one
// (no `--model`, no `chat.defaultModel`). Read from kiro-cli itself, which
// marks it with "*" in `kiro-cli chat --list-models` (currently "auto"), so
// a change of default in a Kiro update is picked up rather than hard-coded.
// ~2.4s, so it is only called from session start and cached (kiroSession.ts).
function parseDefaultModel(listModelsOutput) {
    for (const line of listModelsOutput.split(/\r?\n/)) {
        const match = line.match(/^\s*\*\s+(\S+)/);
        if (match)
            return match[1];
    }
    return undefined;
}
function readKiroDefaultModel(run = () => (0, node_child_process_1.execFileSync)('kiro-cli', ['chat', '--list-models'], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
})) {
    try {
        return parseDefaultModel(run());
    }
    catch {
        return undefined;
    }
}
