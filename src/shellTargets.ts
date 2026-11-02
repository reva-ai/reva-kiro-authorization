import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Which files and folders a shell command touches, parsed by the shell it
// actually runs in.
//
// Kiro runs shell commands through the platform shell: PowerShell (and
// cmd-style commands) on Windows, a POSIX shell (bash/zsh/sh) on macOS and
// Linux. The two dialects disagree on exactly the things that decide what a
// path is — `\` is a path separator in one and an escape character in the
// other, `-Path x` names a path in one and is just a flag in the other — so
// one heuristic for both misattributes on at least one of them. The dialect
// follows the same platform split as context.os ("Windows" vs the rest).
//
// Still explicitly BEST-EFFORT. This is not a shell parser and must never
// become one: anything it cannot confidently identify is left out rather
// than guessed at, and a command that yields nothing falls back to the
// working directory (see mapping.ts).
// ---------------------------------------------------------------------------

export type ShellDialect = 'powershell' | 'posix';

export function shellDialectFor(platform: NodeJS.Platform = process.platform): ShellDialect {
  return platform === 'win32' ? 'powershell' : 'posix';
}

// --- path helpers shared with mapping.ts -----------------------------------

// path.resolve does NOT do shell-style "~" expansion — it treats "~" as a
// literal folder name, which would put a home-directory file inside the repo
// (a real policy bypass). "~user/..." is
// left alone; Node has no simple way to resolve another user's home.
export function expandHome(pathValue: string): string {
  if (pathValue === '~') return os.homedir();
  if (pathValue.startsWith('~/') || pathValue.startsWith('~\\')) return path.join(os.homedir(), pathValue.slice(2));
  return pathValue;
}

export function resolveAgainst(cwd: string, pathValue: string): string {
  return path.resolve(cwd, expandHome(pathValue));
}

export function hasWildcard(value: string): boolean {
  return /[*?{}[\]]/.test(value);
}

// Directory portion of a glob pattern, stopping at the first wildcard
// segment — a Cedar policy on a literal folder path can never match a
// resource id that still contains "*" as a path segment.
export function literalDirOf(patternValue: string): string {
  const segments = patternValue.replace(/\\/g, '/').split('/');
  const literal: string[] = [];
  for (const seg of segments) {
    if (/[*?{}[\]]/.test(seg)) break;
    literal.push(seg);
  }
  // If nothing was a wildcard, the last segment is the filename itself, not
  // a directory — drop it so we return the containing directory.
  if (literal.length === segments.length && literal.length > 0) {
    literal.pop();
  }
  return literal.join('/') || '.';
}

function existsSafe(absolutePath: string): boolean {
  try {
    return fs.existsSync(absolutePath);
  } catch {
    return false;
  }
}

// --- tokenizing -------------------------------------------------------------

interface Token {
  text: string;
  // Contained a variable, a substitution or another value only the shell
  // knows at run time — never a resource, because its real path is unknown.
  dynamic: boolean;
  // The word after a redirection operator (`> out.txt`, `2>> err.log`,
  // `< in.txt`): always a file the command reads or writes.
  redirect: boolean;
}

// Quote-aware split into segments (one per command) of tokens. Segment
// breaks are `;`, `|`, `||`, `&&`, `&` and newlines OUTSIDE quotes — a regex
// argument like "a|b" must not split the command.
function scanSegments(command: string, dialect: ShellDialect): Token[][] {
  const segments: Token[][] = [];
  let tokens: Token[] = [];
  let text = '';
  let started = false;
  let dynamic = false;
  let redirect = false;
  let pendingRedirect = false;
  let quote: '"' | "'" | undefined;

  const endToken = (): void => {
    if (started) {
      tokens.push({ text, dynamic, redirect: redirect || pendingRedirect });
      pendingRedirect = false;
    }
    text = '';
    started = false;
    dynamic = false;
    redirect = false;
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
    pendingRedirect = false;
  };
  // Skips a `$( ... )` substitution starting at index i (pointing at '$'),
  // returning the index of its closing parenthesis.
  const skipSubstitution = (i: number): number => {
    let depth = 0;
    for (let j = i + 1; j < command.length; j++) {
      if (command[j] === '(') depth++;
      else if (command[j] === ')' && --depth === 0) return j;
    }
    return command.length - 1;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote === "'") {
      // Single quotes: fully literal in both dialects.
      if (ch === "'") quote = undefined;
      else text += ch;
      continue;
    }

    // Escapes: `\` in POSIX (outside single quotes), backtick in PowerShell.
    // In PowerShell a backslash is just a path separator.
    if (dialect === 'posix' && ch === '\\' && i + 1 < command.length) {
      text += command[++i];
      started = true;
      continue;
    }
    if (dialect === 'powershell' && ch === '`' && i + 1 < command.length) {
      text += command[++i];
      started = true;
      continue;
    }

    // Substitutions and variables — the value is only known at run time.
    if (ch === '$' && command[i + 1] === '(') {
      i = skipSubstitution(i);
      dynamic = true;
      started = true;
      continue;
    }
    if (dialect === 'posix' && ch === '`') {
      const close = command.indexOf('`', i + 1);
      i = close === -1 ? command.length - 1 : close;
      dynamic = true;
      started = true;
      continue;
    }
    if (ch === '$' || (ch === '%' && /^%[A-Za-z_][A-Za-z0-9_]*%/.test(command.slice(i)))) {
      dynamic = true;
    }

    if (quote === '"') {
      if (ch === '"') quote = undefined;
      else text += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }

    if (ch === '\n' || ch === '\r' || ch === ';' || ch === '|' || ch === '&') {
      endSegment();
      // `||` / `&&` are one separator, not two.
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++;
      continue;
    }

    if (ch === '>' || ch === '<') {
      // A bare file-descriptor number right before the operator (`2>`) is
      // part of the operator, not a word.
      if (/^\d$/.test(text) && !dynamic) {
        text = '';
        started = false;
      }
      endToken();
      if (command[i + 1] === '>') i++;
      // `2>&1`, `>&2`: a descriptor duplication, not a file.
      if (command[i + 1] === '&') {
        i++;
        while (i + 1 < command.length && /[\d-]/.test(command[i + 1])) i++;
        continue;
      }
      pendingRedirect = true;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      endToken();
      continue;
    }

    text += ch;
    started = true;
  }
  endSegment();
  return segments;
}

// --- deciding what is a path ------------------------------------------------

// Values that name "no file".
const NULL_DEVICES = new Set(['/dev/null', 'nul', '$null', 'null']);

// A token that cannot be a filesystem path no matter what.
function neverAPath(token: Token): boolean {
  const t = token.text;
  if (!t || token.dynamic) return true;
  if (NULL_DEVICES.has(t.toLowerCase())) return true;
  // URLs and scp-style git remotes (git@github.com:org/repo).
  if (t.includes('://') || /^[\w.-]+@[\w.-]+:/.test(t)) return true;
  return false;
}

// Whether a positional argument names a filesystem path. Ordering matters:
// "does it exist on disk" is the strongest signal and is checked first, so a
// real path with awkward characters ("Program Files (x86)") is still
// recognized, while an expression that merely looks path-ish is not.
function isPathCandidate(token: Token, cwd: string, dialect: ShellDialect): boolean {
  if (neverAPath(token)) return false;
  const t = token.text;
  // Flags/parameters, npm scopes and splats, cmd-style switches (/s, /b).
  if (/^[-@]/.test(t)) return false;
  if (dialect === 'powershell' && /^\/[A-Za-z?]{1,3}$/.test(t)) return false;
  if (existsSafe(resolveAgainst(cwd, t))) return true;
  // Prose and expressions: a path that does not exist yet rarely has these.
  if (/\s/.test(t) || /[()'"=|<>;&{}]/.test(t)) return false;
  if (t.includes('/') || t.includes('\\')) return true;
  const base = t.replace(/\\/g, '/').split('/').pop() || t;
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1;
}

// A value the command itself says is a path (`-Path x`, `> x`): accepted
// without the "looks like a path" test, but still never a variable or URL.
function isForcedPath(token: Token): boolean {
  return !neverAPath(token);
}

// --- per-command knowledge --------------------------------------------------

function commandName(token: string): string {
  const base = token.replace(/\\/g, '/').split('/').pop() || token;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

// Prefixes that run the NEXT word as the real command.
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'nice', 'exec', 'command', 'xargs', 'call', 'start']);

// Commands whose positional arguments are text, not files — only a
// redirection target can be a resource (`echo hi > notes.txt`).
const TEXT_COMMANDS = new Set([
  'echo', 'printf', 'write-host', 'write-output', 'write-verbose', 'write-warning',
  'write-error', 'write-information', 'write-debug', 'out-host',
]);

// Commands whose FIRST positional argument is a pattern, not a path
// (`grep -r "a.b" src`, `Select-String "x" file.txt`).
const PATTERN_FIRST_COMMANDS = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'findstr', 'select-string', 'sls',
]);

// Tools whose FIRST positional argument is a subcommand, not a path — so
// `npm test` / `git status` never become a resource just because the repo
// happens to have a `test/` or `status` folder. `npm run <script>` skips the
// script name too.
const SUBCOMMAND_FIRST_COMMANDS = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'docker', 'kubectl', 'helm', 'cargo', 'go',
  'dotnet', 'pip', 'pip3', 'poetry', 'uv', 'gh', 'az', 'aws', 'gcloud', 'terraform', 'make', 'kiro-cli',
]);
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

// Change the working directory for the commands after them in the same line
// (`cd src && cat app.ts` reads src/app.ts).
const CD_COMMANDS = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location']);

// Shells that take a whole command string to run (`bash -c "cat .env"`,
// `cmd /c type .env`, `powershell -Command "Get-Content .env"`): the string
// is scanned as a command of its own, in that shell's dialect.
const NESTED_SHELLS: Record<string, { flags: Set<string>; dialect: ShellDialect }> = {
  bash: { flags: new Set(['-c']), dialect: 'posix' },
  sh: { flags: new Set(['-c']), dialect: 'posix' },
  zsh: { flags: new Set(['-c']), dialect: 'posix' },
  cmd: { flags: new Set(['/c', '/k']), dialect: 'powershell' },
  powershell: { flags: new Set(['-c', '-command']), dialect: 'powershell' },
  pwsh: { flags: new Set(['-c', '-command']), dialect: 'powershell' },
};

// PowerShell parameters whose value IS a path.
const PS_PATH_PARAMS = new Set([
  'path', 'literalpath', 'pspath', 'lp', 'destination', 'filepath', 'outfile', 'infile',
  'outputpath', 'targetpath', 'workingdirectory',
]);

// PowerShell parameters whose value is NOT a path (a filter, a pattern, a
// string to write…) — skipped, so `-Value "a.b"` never becomes a file.
const PS_VALUE_PARAMS = new Set([
  'filter', 'include', 'exclude', 'pattern', 'simplematch', 'encoding', 'erroraction',
  'warningaction', 'depth', 'first', 'last', 'skip', 'head', 'tail', 'totalcount', 'value',
  'delimiter', 'separator', 'itemtype', 'newname', 'name', 'property', 'argumentlist',
  'context', 'replace', 'join', 'width', 'inputobject', 'type',
]);

// --- extraction -------------------------------------------------------------

function extractFromSegments(
  segments: Token[][],
  cwd: string,
  dialect: ShellDialect,
  add: (literal: string, segmentCwd: string) => void,
  depth: number,
): void {
  let currentCwd = cwd;

  for (const segment of segments) {
    let rest = segment.slice();

    // Leading POSIX environment assignments (`NODE_ENV=x npm test`).
    while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0].text) && !rest[0].redirect) rest.shift();
    // Wrapper prefixes run the next word.
    while (rest.length > 1 && WRAPPERS.has(commandName(rest[0].text))) rest.shift();
    if (!rest.length) continue;

    // Redirection targets count whatever the command is.
    for (const token of rest) {
      if (token.redirect && isForcedPath(token)) add(token.text, currentCwd);
    }

    const [head, ...args] = rest.filter((t) => !t.redirect);
    if (!head) continue;
    const name = commandName(head.text);

    if (CD_COMMANDS.has(name)) {
      const target = args.find((t) => !t.text.startsWith('-') && !t.dynamic);
      if (target) currentCwd = resolveAgainst(currentCwd, target.text);
      continue;
    }

    const nested = NESTED_SHELLS[name];
    if (nested && depth < 2) {
      const flagIndex = args.findIndex((t) => nested.flags.has(t.text.toLowerCase()));
      if (flagIndex !== -1) {
        const inner = args.slice(flagIndex + 1).map((t) => t.text).join(' ');
        extractFromSegments(scanSegments(inner, nested.dialect), currentCwd, nested.dialect, add, depth + 1);
        continue;
      }
    }

    if (TEXT_COMMANDS.has(name)) continue;

    let skipPattern = PATTERN_FIRST_COMMANDS.has(name);
    let skipSubcommand = SUBCOMMAND_FIRST_COMMANDS.has(name);
    for (let i = 0; i < args.length; i++) {
      const token = args[i];
      const t = token.text;

      if (dialect === 'powershell' && /^-[A-Za-z]/.test(t)) {
        // `-Name value` or `-Name:value`.
        const colon = t.indexOf(':');
        const param = (colon === -1 ? t.slice(1) : t.slice(1, colon)).toLowerCase();
        const inline = colon === -1 ? undefined : t.slice(colon + 1);
        const valueToken: Token | undefined = inline !== undefined ? { ...token, text: inline } : args[i + 1];
        const consumesNext = inline === undefined;
        if (PS_PATH_PARAMS.has(param)) {
          if (valueToken) for (const piece of splitList(valueToken)) if (isForcedPath(piece)) add(piece.text, currentCwd);
          if (consumesNext) i++;
        } else if (PS_VALUE_PARAMS.has(param)) {
          if (param === 'pattern') skipPattern = false;
          if (consumesNext) i++;
        }
        // Any other parameter is a switch (-Recurse, -Force, -Raw).
        continue;
      }

      if (dialect === 'posix' && t.startsWith('-')) {
        // `--file=path`: the value after "=" may be a path.
        const eq = t.indexOf('=');
        if (t.startsWith('--') && eq !== -1) {
          const value: Token = { ...token, text: t.slice(eq + 1) };
          if (isPathCandidate(value, currentCwd, dialect)) add(value.text, currentCwd);
        }
        if (t === '-e' || t === '--regexp' || t === '-f') skipPattern = false;
        continue;
      }

      if (skipSubcommand) {
        skipSubcommand = false;
        // `npm run build`: the script name after `run` is not a path either.
        if (SCRIPT_RUNNERS.has(name) && /^(run|run-script)$/i.test(t)) i++;
        continue;
      }
      if (skipPattern) {
        skipPattern = false;
        continue;
      }

      // PowerShell accepts comma-separated lists: `Get-ChildItem src,test`.
      const pieces = dialect === 'powershell' ? splitList(token) : [token];
      for (const piece of pieces) {
        const cleaned = stripParens(piece);
        if (isPathCandidate(cleaned, currentCwd, dialect)) add(cleaned.text, currentCwd);
      }
    }
  }
}

function splitList(token: Token): Token[] {
  return token.text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => ({ ...token, text }));
}

// `(Get-Content a.txt)` tokenizes as "(Get-Content" and "a.txt)" — the
// grouping parentheses are not part of the path.
function stripParens(token: Token): Token {
  let text = token.text;
  while (text.startsWith('(') && !text.includes(')')) text = text.slice(1);
  while (text.endsWith(')') && !text.includes('(')) text = text.slice(0, -1);
  return text === token.text ? token : { ...token, text };
}

// Every distinct filesystem path a shell command appears to touch, as
// absolute paths, deduped and in first-seen order. Wildcards are reduced to
// their literal directory (`src/*.ts` -> `src`): no real folder is named
// "*", so no path policy could ever match one.
export function extractShellTargets(
  command: string,
  cwd: string,
  dialect: ShellDialect = shellDialectFor(),
): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  const add = (raw: string, segmentCwd: string): void => {
    const literal = hasWildcard(raw) ? literalDirOf(raw) : raw;
    const absolute = resolveAgainst(segmentCwd, literal);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    targets.push(absolute);
  };
  extractFromSegments(scanSegments(command, dialect), cwd, dialect, add, 0);
  return targets;
}
