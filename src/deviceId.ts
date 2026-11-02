import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { debugLog } from './debug';

// Ties the Agent's Cedar identity to a stable, logged-in account id (not to
// any one machine) wherever the host can supply one. Per-machine tracking
// still happens, just separately: the current machine's hardware id is
// appended to the User entity's registeredMachineIds Set (see
// ingestionClient.ts), not used as Agent's own id.
//
// Kiro has a logged-in account, and `kiro-cli whoami` reports it without
// exposing any secret:
//
//     $ kiro-cli whoami
//     Logged in with Google
//     Email: someone@example.com
//
// That email is what readKiroAccountEmail() below parses, and it is used as
// the `User`/principal — a real login-derived identity, so identity.ts's
// OS-username branch is now genuinely a last resort rather than the normal
// path.
//
// The ACCOUNT id comes from kiro-cli's own local state database (see
// readKiroUserId below), NOT from `whoami`, which reports only
// {accountType, provider, email} even with `--format json`. kiro-cli
// stores the logged-in user's id there under `telemetryUserId`, in AWS
// Identity Store form: `d-<10 hex directory id>.<user UUID>` (confirmed on
// kiro-cli 2.33.0, Windows). The UUID part is the Agent id: an opaque
// account UUID.
//
// Kiro's token cache (~/.aws/sso/cache/kiro-auth-token.json) and the
// database's `auth_kv` table hold credentials; neither is ever opened. Only
// the `state` row for `telemetryUserId` is read.
//
// REVA_AGENT_ID still overrides all of this (config.ts). If no account is
// logged in, or the database cannot be read, there is no Agent id and
// config.ts fails loudly — never a derived, machine, or random stand-in.
//
// Verify on two machines with the same login before treating the id as
// settled — an id that looks stable on one machine often isn't.
//
// This only reports an honest, self-declared value — actual "this token
// can't be used from another account/machine" enforcement has to happen in
// Reva's policies (checking principal.id/context against what's registered
// for that token/user). A malicious client could still misreport this;
// it's identity-fingerprinting, not attestation.

interface WhoamiResult {
  email?: string;
  // The kiro-cli user id that was logged in when `email` was resolved. Ties
  // the cached email to one account, so switching accounts invalidates it
  // immediately instead of attributing requests to the previous account for
  // up to the 24h TTL.
  kiroUserId?: string;
}

let cachedWhoami: WhoamiResult | undefined;
let cachedAgentId: string | undefined;
let cachedKiroUserId: string | null | undefined;

// `kiro-cli whoami` is the ONLY source of the logged-in account, so this
// budget has to be generous enough for it to actually succeed. Measured on
// Windows, three consecutive runs: 11,386ms / 10,138ms /
// 10,071ms — it is simply slow, not broken. An earlier 2s budget failed
// every time and silently degraded the principal to the OS username, which
// then got ingested as an unknown, inactive `User` and denied everything.
//
// Note that execFileSync's `timeout` cannot actually cut the child short
// here (verified: 10,088ms with timeout:2000, unchanged with killSignal
// SIGKILL or with stderr closed) — the child does not die when Node asks.
// So this number governs whether we ACCEPT the answer, not how long we
// wait. The caches below are what keep that cost off the hot path.
const WHOAMI_TIMEOUT_MS = 15000;

// How long a SUCCESSFULLY resolved account is trusted. Deliberately long:
// at ~11s per resolve, this cost must land as close to never as possible.
// Someone switching Kiro accounts mid-day is rare, and a stale email for a
// few hours is far less harmful than an 11s stall in front of a tool call.
// `npm run install-hooks` pre-warms this so the first hook of a session
// never pays it.
const WHOAMI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// A FAILED lookup is cached far more briefly. It has to be cached at all —
// otherwise a machine with no Kiro login pays the full ~11s on every single
// hook call — but a failure is much more likely to be transient than a
// success: a credential mid-refresh, a CLI upgrade, a laptop off the
// network. Five minutes bounds the retry cost without making a blip sticky.
const WHOAMI_FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;

function runWhoami(): string {
  // stdio pinned: a hook's stdout/stderr are Kiro's decision channels, and
  // nothing a child process prints may reach them.
  return execFileSync('kiro-cli', ['whoami'], {
    encoding: 'utf8',
    timeout: WHOAMI_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// Durable per-plugin state directory. Lives here rather than in config.ts
// because deviceId.ts must not import config.ts (config.ts imports this
// file — that would be a cycle). config.ts re-exports it.
//
// ~/.kiro is Kiro's own configuration root (it already holds hooks/,
// agents/, settings/), so this is inside what the host sanctions rather
// than a location of our own invention elsewhere in $HOME. Returns
// undefined if it cannot be created, and every cache then no-ops.
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env.REVA_DATA_DIR?.trim() || path.join(os.homedir(), '.kiro', 'reva-governance');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return undefined;
  }
}

function whoamiCacheFile(): string | undefined {
  const dir = resolveDataDir();
  return dir ? path.join(dir, 'account.json') : undefined;
}

// `ignoreExpiry` is used only on the recovery path in readKiroWhoami, where
// an expired-but-real account is a better answer than no account at all.
function readWhoamiCache(ignoreExpiry = false): WhoamiResult | undefined {
  const file = whoamiCacheFile();
  if (!file) return undefined;
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof entry?.resolvedAt !== 'number') return undefined;
    const email = typeof entry.email === 'string' ? entry.email : undefined;
    const kiroUserId = typeof entry.kiroUserId === 'string' ? entry.kiroUserId : undefined;
    if (ignoreExpiry) return { email, kiroUserId };
    const ttl = email ? WHOAMI_CACHE_TTL_MS : WHOAMI_FAILURE_CACHE_TTL_MS;
    if (Date.now() - entry.resolvedAt > ttl) return undefined;
    return { email, kiroUserId };
  } catch {
    // absent or corrupt — re-resolve, same as every other cache here
    return undefined;
  }
}

// A failed lookup is cached too, deliberately: without that, a machine with
// no Kiro login would pay the full subprocess timeout on every hook call
// forever. The TTL still lets it heal on its own after a later login.
function writeWhoamiCache(result: WhoamiResult): void {
  const file = whoamiCacheFile();
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ ...result, resolvedAt: Date.now() }), 'utf8');
  } catch {
    // best effort — worst case is re-resolving next call
  }
}

// `kiro-cli whoami` prints human-readable lines, not JSON. Parsed rather
// than assumed: only a line of the form "Email: <address>" is accepted, and
// anything else (not logged in, CLI missing, non-zero exit, timeout) yields
// undefined rather than a guess. Takes an injectable runner, so tests can
// feed canned output instead of spawning the real CLI.
//
// Two layers of caching, because each hook invocation is a fresh, separate
// process: an in-process memo (several call sites per invocation) and a
// TTL'd disk cache (across invocations). Without the disk layer this shells
// out once per hook call — meaning every prompt and every tool call pays a
// `kiro-cli whoami` subprocess spawn before the PDP is even contacted.
//
// Passing an explicit runner bypasses both layers, which is what makes this
// testable without a real login and without touching the developer's own
// cached account.
export function readKiroWhoami(run: () => string = runWhoami): WhoamiResult {
  const injected = run !== runWhoami;
  if (injected) return parseWhoami(run);

  if (cachedWhoami) return cachedWhoami;

  // Which account is logged in RIGHT NOW, per kiro-cli's own database — a
  // cheap local read, unlike whoami. A cached email resolved under a
  // different account (or before this field was recorded) is not trusted:
  // the account changed, so the email has to be resolved again.
  const currentUserId = readKiroUserId();
  const sameAccount = (entry: WhoamiResult) => !currentUserId || entry.kiroUserId === currentUserId;

  const cached = readWhoamiCache();
  if (cached && sameAccount(cached)) {
    cachedWhoami = cached;
    return cached;
  }

  const result: WhoamiResult = { ...parseWhoami(run), kiroUserId: currentUserId };
  if (result.email) {
    writeWhoamiCache(result);
    cachedWhoami = result;
    return result;
  }

  // The resolve failed. Before accepting "no account", fall back to the
  // last email this machine ever successfully resolved, however old.
  //
  // This is the difference between a slow/flaky `whoami` being invisible
  // and it silently changing who every request is attributed to. Without
  // it, one failed lookup drops the principal to the OS username — which
  // gets ingested as an unknown `User` with active="false" and denied by
  // any deployment that gates on active users, under any policy. A stale
  // but real account id is unambiguously better than that.
  //
  // The stale entry is deliberately NOT rewritten, so its age keeps
  // advancing and a genuine logout still expires out of the cache instead
  // of being renewed forever by repeated failures.
  //
  // Only for the SAME account, though: a stale email from a different
  // account is a different human, and reusing it would misattribute every
  // request rather than merely delay a refresh.
  const stale = readWhoamiCache(true);
  if (stale?.email && sameAccount(stale)) {
    debugLog(`whoami failed; reusing the last known account (${stale.email}) rather than degrading the principal`);
    cachedWhoami = stale;
    return stale;
  }

  writeWhoamiCache(result);
  cachedWhoami = result;
  return result;
}

// Only a line of the form "Email: <address>" is accepted. Anything else —
// not logged in, kiro-cli missing, non-zero exit, timeout — yields no email
// rather than a guess.
function parseWhoami(run: () => string): WhoamiResult {
  try {
    const email = run().match(/^\s*Email:\s*(\S+@\S+)\s*$/m)?.[1];
    return email ? { email } : {};
  } catch {
    // not logged in, kiro-cli not on PATH, or an IDE-only install — all
    // legitimately "no identity available," never an error worth throwing
    return {};
  }
}

// The human's login email, used as the `User`/principal (identity.ts).
export function readKiroAccountEmail(run?: () => string): string | undefined {
  return readKiroWhoami(run).email;
}

// --- the Kiro account id (the Agent's Cedar id) ----------------------------
//
// kiro-cli's local state database. Windows confirmed on kiro-cli 2.33.0.
// The macOS and Linux locations follow the platform data-directory
// convention kiro-cli inherited from Amazon Q CLI and are UNCONFIRMED —
// REVA_KIRO_DB_PATH pins the file explicitly when they turn out to differ.
export function kiroCliDbPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const pinned = env.REVA_KIRO_DB_PATH?.trim();
  if (pinned) return [pinned];
  switch (process.platform) {
    case 'win32':
      return [path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Kiro-Cli', 'data.sqlite3')];
    case 'darwin':
      return [path.join(os.homedir(), 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3')];
    default:
      return [path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'kiro-cli', 'data.sqlite3')];
  }
}

// node:sqlite is built into Node 22.5+ and absent before that. Loading it
// emits an ExperimentalWarning on stderr — and a hook's stderr becomes the
// block reason on a deny (see debug.ts) — so that one warning is suppressed
// for the duration of the require. On an older Node this returns undefined
// and the account id is simply unavailable (REVA_AGENT_ID then required).
function loadSqlite(): any | undefined {
  const original = process.emitWarning;
  (process as any).emitWarning = (warning: any, ...rest: any[]) => {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type ?? warning?.name;
    if (type === 'ExperimentalWarning') return;
    return (original as any).call(process, warning, ...rest);
  };
  try {
    return require('node:sqlite');
  } catch {
    return undefined;
  } finally {
    process.emitWarning = original;
  }
}

// Reads ONLY the `telemetryUserId` row of the `state` table, read-only.
// The value is stored as a JSON string. Never touches `auth_kv` (tokens).
function readTelemetryUserIdFromDb(file: string): string | undefined {
  const sqlite = loadSqlite();
  if (!sqlite?.DatabaseSync || !fs.existsSync(file)) return undefined;
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    let value = db.prepare("SELECT value FROM state WHERE key = 'telemetryUserId'").get()?.value;
    if (value instanceof Uint8Array) value = Buffer.from(value).toString('utf8');
    if (typeof value !== 'string') return undefined;
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : undefined;
    } catch {
      return value;
    }
  } finally {
    db.close();
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IDENTITY_STORE_USER_ID = new RegExp(`^d-[0-9a-f]{10}\\.(${UUID})$`, 'i');
const BARE_UUID = new RegExp(`^${UUID}$`, 'i');

// The Agent id for a kiro-cli user id: the user UUID out of an Identity
// Store id (`d-<directory>.<uuid>`), or a bare UUID as-is. Anything else is
// a shape this plugin has not seen, and yields undefined rather than a
// guess — config.ts then asks for REVA_AGENT_ID.
export function agentIdFromKiroUserId(kiroUserId: string | undefined): string | undefined {
  const value = kiroUserId?.trim();
  if (!value) return undefined;
  const match = IDENTITY_STORE_USER_ID.exec(value);
  if (match) return match[1].toLowerCase();
  return BARE_UUID.test(value) ? value.toLowerCase() : undefined;
}

// The logged-in kiro-cli user id, e.g. `d-1234567890.0f1e2d3c-…`, or
// undefined when there is no readable database. Memoized per process.
export function readKiroUserId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (cachedKiroUserId !== undefined) return cachedKiroUserId ?? undefined;
  let found: string | undefined;
  for (const file of kiroCliDbPaths(env)) {
    try {
      found = readTelemetryUserIdFromDb(file);
    } catch (err: any) {
      debugLog(`readKiroUserId: could not read ${file} — ${err?.message || String(err)}`);
    }
    if (found) break;
  }
  cachedKiroUserId = found ?? null;
  return found;
}

// The Cedar `Agent` entity's id: the logged-in Kiro account's own user
// UUID, an opaque account UUID — e.g.
// `0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b`.
//
// Requires BOTH a logged-in account (whoami email) and a readable user id.
// The database row can outlive a logout, so the email check is what stops
// a logged-out machine from still claiming the last account's identity.
//
// WHY NOT THE OLD `kiro-<hash of email>` ID: it was invented by this
// plugin, so it matched nothing Kiro itself knows about the account, and
// the Reva console could not treat it as an account id. The user id here
// is the one Kiro assigns.
//
// NOTE: this changes the Agent's identity in Reva. The first session after
// upgrading ingests a NEW Agent entity; the old `kiro-…` one stays until
// removed in the console, and any policy naming it stops matching.
// REVA_AGENT_ID (config.ts) still overrides this and can pin the old id.
export function readKiroAccountId(
  run?: () => string,
  readUserId: () => string | undefined = () => readKiroUserId(),
): string | undefined {
  const email = readKiroAccountEmail(run);
  if (!email) return undefined;
  return agentIdFromKiroUserId(readUserId());
}

// Drops the memoized whoami/agent-id results. Only for tests — a real hook
// process is too short-lived for the cache to ever need clearing.
export function __resetIdentityCacheForTests(): void {
  cachedWhoami = undefined;
  cachedAgentId = undefined;
  cachedKiroUserId = undefined;
}

// --- this machine's id ---------------------------------------------------------
//
// The machine's OWN hardware GUID, exactly as the OS reports it, and nothing
// else — never an invented, random or persisted fallback id. One machine has
// one GUID: an earlier version generated a random id whenever the hardware
// read failed (a 2s timeout under parallel hooks was enough), persisted it,
// and registered it in User.registeredMachineIds — so one Windows PC showed
// up as two "registered devices" (its real MachineGuid and an invented
// one). If the GUID cannot be read, there is no machine id
// for that call; nothing is substituted.
//
// Sources — the same commands an administrator would run:
//   macOS    ioreg -rd1 -c IOPlatformExpertDevice      -> "IOPlatformUUID" = "…"
//            (same value as: … | awk -F '"' '/IOPlatformUUID/ {print $4}')
//   Windows  reg query "HKLM\SOFTWARE\Microsoft\Cryptography" /v MachineGuid
//            and, if reg is unavailable, the same registry value via
//            (Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Cryptography").MachineGuid
//   Linux    /etc/machine-id (or /var/lib/dbus/machine-id) — the OS's own id
//
// The value is used exactly as returned (macOS reports upper case, Windows
// lower case): re-casing it would register an already-known machine a
// second time under a different spelling.

const HARDWARE_ID_TIMEOUT_MS = 8000;
const GUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

type Runner = (file: string, args: string[]) => string;

const runCommand: Runner = (file, args) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    timeout: HARDWARE_ID_TIMEOUT_MS,
    windowsHide: true,
    // A hook's stdout/stderr are Kiro's decision channels — nothing a child
    // process prints may reach them.
    stdio: ['ignore', 'pipe', 'ignore'],
  });

// `"IOPlatformUUID" = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"` from ioreg.
export function parseIoregPlatformUuid(output: string): string | undefined {
  const value = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1]?.trim();
  return value && GUID.test(value) ? value : undefined;
}

// `MachineGuid    REG_SZ    3f2b9c1a-5d4e-4f60-8a7b-1c2d3e4f5a6b` from reg query.
export function parseRegMachineGuid(output: string): string | undefined {
  const value = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1]?.trim();
  return value && GUID.test(value) ? value : undefined;
}

function readMacHardwareId(run: Runner): string | undefined {
  try {
    return parseIoregPlatformUuid(run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']));
  } catch {
    return undefined;
  }
}

function readWindowsMachineGuid(run: Runner, env: NodeJS.ProcessEnv): string | undefined {
  const system32 = path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32');
  try {
    const viaReg = parseRegMachineGuid(
      run(path.join(system32, 'reg.exe'), ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']),
    );
    if (viaReg) return viaReg;
  } catch {
    // fall through to PowerShell — the SAME registry value, read another way
  }
  try {
    const value = run(path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Cryptography").MachineGuid',
    ]).trim();
    return GUID.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readLinuxMachineId(): string | undefined {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const id = fs.readFileSync(p, 'utf8').trim();
      if (id) return id;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

// OS-level, not coding-agent-specific. `platform`, `run` and `env` are
// injectable for tests.
export function readOsHardwareId(
  platform: NodeJS.Platform = process.platform,
  run: Runner = runCommand,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  switch (platform) {
    case 'darwin':
      return readMacHardwareId(run);
    case 'win32':
      return readWindowsMachineGuid(run, env);
    case 'linux':
      return readLinuxMachineId();
    default:
      return undefined;
  }
}

let cachedMachineId: string | null | undefined;

// This machine's id for User.registeredMachineIds and context.machineId —
// the real hardware GUID, or undefined when it cannot be read. Callers omit
// the value rather than invent one. (`pluginDataDir` is accepted for call
// compatibility; nothing is read from or written to it.)
export function resolveMachineId(_pluginDataDir?: string): string | undefined {
  if (cachedMachineId === undefined) cachedMachineId = readOsHardwareId() ?? null;
  return cachedMachineId ?? undefined;
}

// Resolves the id for the Cedar `Agent` entity: an account-scoped id, and
// nothing else. No fallback to resolveMachineId or a random id — a machine
// id would silently fragment one account into one Agent per machine, and a
// random one would fabricate an identity outright.
// Returns undefined when no Kiro account is logged in, and config.ts turns
// that into a loud, actionable "set REVA_AGENT_ID" error.
export function resolveAgentId(): string | undefined {
  if (!cachedAgentId) {
    cachedAgentId = readKiroAccountId();
  }
  return cachedAgentId;
}
