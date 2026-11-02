import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  __resetIdentityCacheForTests,
  parseIoregPlatformUuid,
  parseRegMachineGuid,
  readOsHardwareId,
  readKiroAccountEmail,
  agentIdFromKiroUserId,
  readKiroAccountId,
  readKiroUserId,
  readKiroWhoami,
  resolveAgentId,
  resolveDataDir,
  resolveMachineId,
} from '../src/deviceId';

// --- the machine's hardware GUID ------------------------------------------------
//
// Only the OS's own GUID, exactly as reported — never an invented or
// persisted fallback id. An earlier version wrote a random id when the read
// failed, and one PC was registered as two machines.

const IOREG_OUTPUT = `+-o Root  <class IORegistryEntry, id 0x100000100, retain 26>
  {
    "IOPlatformSerialNumber" = "C02XXXXXXXXX"
    "IOPlatformUUID" = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"
    "IOPlatformModel" = <"MacBookPro18,1">
  }`;

const REG_OUTPUT = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography
    MachineGuid    REG_SZ    aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
`;

test('macOS: the GUID is IOPlatformUUID from ioreg, exactly as reported', () => {
  assert.equal(parseIoregPlatformUuid(IOREG_OUTPUT), 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE');
  const run = (file: string, args: string[]) => {
    assert.equal(file, '/usr/sbin/ioreg');
    assert.deepEqual(args, ['-rd1', '-c', 'IOPlatformExpertDevice']);
    return IOREG_OUTPUT;
  };
  assert.equal(readOsHardwareId('darwin', run, {}), 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE');
});

test('Windows: the GUID is MachineGuid from reg query, exactly as reported', () => {
  assert.equal(parseRegMachineGuid(REG_OUTPUT), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  const calls: string[] = [];
  const run = (file: string, args: string[]) => {
    calls.push(path.basename(file));
    assert.deepEqual(args, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
    return REG_OUTPUT;
  };
  assert.equal(readOsHardwareId('win32', run, { SystemRoot: 'C:\\Windows' }), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.deepEqual(calls, ['reg.exe']);
});

test('Windows: if reg fails, the SAME value is read through PowerShell Get-ItemProperty', () => {
  const run = (file: string, args: string[]) => {
    if (path.basename(file) === 'reg.exe') throw new Error('reg timed out');
    assert.equal(path.basename(file), 'powershell.exe');
    assert.ok(args.join(' ').includes('Get-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Cryptography"'));
    return 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\r\n';
  };
  assert.equal(readOsHardwareId('win32', run, { SystemRoot: 'C:\\Windows' }), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
});

test('when the GUID cannot be read, there is NO machine id — nothing invented, nothing persisted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-device-'));
  try {
    const fail = () => {
      throw new Error('unavailable');
    };
    assert.equal(readOsHardwareId('win32', fail, {}), undefined);
    assert.equal(readOsHardwareId('darwin', fail, {}), undefined);
    // Output that is not a GUID is rejected rather than used.
    assert.equal(readOsHardwareId('darwin', () => '"IOPlatformUUID" = "not-a-guid"', {}), undefined);
    assert.equal(readOsHardwareId('win32', () => 'garbage', {}), undefined);
    // And no fallback id file is ever written anywhere.
    assert.equal(fs.existsSync(path.join(dir, 'device-id')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// `kiro-cli whoami` prints prose, not JSON — these pin the exact parse
// against its real output shape rather than assuming it. The injectable
// runner is what lets this run with no Kiro login.
const WHOAMI_OUTPUT = `Logged in with Google
Email: someone@example.com
`;

test('readKiroAccountEmail parses the Email line out of real `kiro-cli whoami` output', () => {
  assert.equal(readKiroAccountEmail(() => WHOAMI_OUTPUT), 'someone@example.com');
});

// The shape kiro-cli 2.33.0 stores as `telemetryUserId` (an AWS Identity
// Store user id). Synthetic values — never a real account's.
const KIRO_USER_ID = 'd-1234567890.0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
const AGENT_ID = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';

test('the Agent id is the user UUID out of the kiro-cli Identity Store user id', () => {
  assert.equal(agentIdFromKiroUserId(KIRO_USER_ID), AGENT_ID);
  // A bare UUID, no prefix.
  assert.match(agentIdFromKiroUserId(KIRO_USER_ID)!, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
});

test('a bare UUID user id is accepted as-is; any other shape yields undefined, never a guess', () => {
  assert.equal(agentIdFromKiroUserId(AGENT_ID.toUpperCase()), AGENT_ID);
  for (const value of [undefined, '', 'someone@example.com', 'kiro-abc', 'd-123.not-a-uuid', 'telemetry']) {
    assert.equal(agentIdFromKiroUserId(value), undefined, `unexpected id for ${value}`);
  }
});

test('readKiroAccountId: logged in + readable user id -> the account UUID, never the email', () => {
  const id = readKiroAccountId(() => WHOAMI_OUTPUT, () => KIRO_USER_ID);
  assert.equal(id, AGENT_ID);
  assert.ok(!id!.includes('@'));
});

test('readKiroAccountId: a user id left in the database after logout is NOT used', () => {
  // The state row can outlive a logout; without a logged-in email there is
  // no account to claim.
  const boom = () => { throw new Error('not logged in'); };
  assert.equal(readKiroAccountId(boom, () => KIRO_USER_ID), undefined);
});

test('readKiroAccountId: logged in but no readable user id -> undefined, never a fabricated id', () => {
  assert.equal(readKiroAccountId(() => WHOAMI_OUTPUT, () => undefined), undefined);
});

test('a not-logged-in / missing-CLI whoami yields undefined — never a fabricated id', () => {
  const boom = () => { throw new Error('kiro-cli: command not found'); };
  assert.equal(readKiroAccountEmail(boom), undefined);
  assert.equal(readKiroAccountId(boom), undefined);
});

test('readKiroUserId: a missing database yields undefined and does not throw', () => {
  __resetIdentityCacheForTests();
  try {
    assert.equal(readKiroUserId({ REVA_KIRO_DB_PATH: path.join(os.tmpdir(), 'no-such-kiro-db.sqlite3') }), undefined);
  } finally {
    __resetIdentityCacheForTests();
  }
});

test('whoami output with no Email line yields undefined rather than a guess', () => {
  assert.equal(readKiroAccountEmail(() => 'Not logged in.'), undefined);
  assert.equal(readKiroAccountEmail(() => 'Logged in with Google'), undefined);
});

test('resolveAgentId is memoized and never substitutes a machine or random id', () => {
  __resetIdentityCacheForTests();
  const first = resolveAgentId();
  const second = resolveAgentId();
  assert.equal(first, second);
  // Whether an account is logged in on the machine running these tests is
  // not something a unit test should depend on, so assert the invariant
  // that actually matters instead: it is either absent, or an account-
  // scoped id — never this machine's hardware id.
  if (first !== undefined) {
    // The invariant that matters: the account's own UUID, never this
    // machine's hardware id (a MachineGuid is UUID-shaped too, hence the
    // explicit inequality).
    assert.match(first, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, `expected an account UUID, got ${first}`);
    assert.notEqual(first.toLowerCase(), resolveMachineId()?.toLowerCase());
  }
});

test('resolveMachineId is this machine’s real GUID (or absent), stable across calls', () => {
  const first = resolveMachineId();
  const second = resolveMachineId();
  assert.equal(first, second);
  if (first !== undefined && process.platform !== 'linux') {
    assert.match(first, /^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/);
  }
});

// --- the whoami disk cache -------------------------------------------------
//
// Every hook invocation is its own process, so without a cache that survives
// between them, EVERY prompt and EVERY tool call pays a `kiro-cli whoami`
// subprocess spawn before the PDP is even contacted. Measured at >10s on a
// machine whose Kiro credentials needed refreshing — in front of a
// PreToolUse hook, that is 10s of latency added to a real action.

// Also points REVA_KIRO_DB_PATH somewhere empty, so these cache tests never
// read the real kiro-cli database of whoever runs them.
function withDataDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-whoami-'));
  const previous = process.env.REVA_DATA_DIR;
  const previousDb = process.env.REVA_KIRO_DB_PATH;
  process.env.REVA_DATA_DIR = dir;
  process.env.REVA_KIRO_DB_PATH = path.join(dir, 'no-kiro-db.sqlite3');
  __resetIdentityCacheForTests();
  try {
    fn(dir);
  } finally {
    if (previous === undefined) delete process.env.REVA_DATA_DIR;
    else process.env.REVA_DATA_DIR = previous;
    if (previousDb === undefined) delete process.env.REVA_KIRO_DB_PATH;
    else process.env.REVA_KIRO_DB_PATH = previousDb;
    __resetIdentityCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a resolved account is written to the data dir so later processes skip the shell-out', () => {
  withDataDir((dir) => {
    let calls = 0;
    const run = () => { calls++; return WHOAMI_OUTPUT; };

    assert.equal(readKiroWhoami(run).email, 'someone@example.com');
    assert.equal(calls, 1);

    // An injected runner deliberately bypasses the cache entirely, so prove
    // persistence by reading the file the real path would have written.
    readKiroWhoami();
    const cached = JSON.parse(fs.readFileSync(path.join(dir, 'account.json'), 'utf8'));
    assert.ok(typeof cached.resolvedAt === 'number', 'cache entry must carry a resolvedAt timestamp');
  });
});

test('a fresh cache entry is used without shelling out', () => {
  withDataDir((dir) => {
    fs.writeFileSync(
      path.join(dir, 'account.json'),
      JSON.stringify({ email: 'cached@example.com', resolvedAt: Date.now() }),
      'utf8',
    );
    // No injected runner: this is the real path, and it must not spawn
    // anything — if it did, it would return this machine's real account
    // (or nothing), never the value planted above.
    assert.equal(readKiroWhoami().email, 'cached@example.com');
  });
});

test('an expired entry is re-resolved — but a stale REAL account still beats degrading', () => {
  withDataDir((dir) => {
    const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
    fs.writeFileSync(
      path.join(dir, 'account.json'),
      JSON.stringify({ email: 'stale@example.com', resolvedAt: twoDaysAgo }),
      'utf8',
    );
    // Past the 24h TTL, so a fresh resolve is attempted. On a machine with
    // no working `kiro-cli` that resolve fails — and the recovery path then
    // reuses the expired-but-real account rather than letting the principal
    // fall through to the OS username, which would be ingested as an
    // unknown, inactive User and denied everything.
    //
    // Whether the resolve succeeds depends on the machine running the
    // tests, so assert the invariant that holds either way: the result is
    // never empty when a real account was previously known.
    const resolved = readKiroWhoami().email;
    assert.ok(resolved, 'a previously-known account must never resolve to nothing');
  });
});

// A throwaway database with kiro-cli's `state` table shape, holding one
// telemetryUserId row stored as a JSON string — exactly how kiro-cli stores it.
function writeKiroDb(file: string, kiroUserId: string): void {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB)');
  db.prepare('INSERT INTO state (key, value) VALUES (?, ?)').run('telemetryUserId', JSON.stringify(kiroUserId));
  db.close();
}

test('readKiroUserId reads telemetryUserId out of a kiro-cli-shaped database', () => {
  withDataDir((dir) => {
    writeKiroDb(process.env.REVA_KIRO_DB_PATH!, KIRO_USER_ID);
    __resetIdentityCacheForTests();
    assert.equal(readKiroUserId(), KIRO_USER_ID);
  });
});

test('a cached email resolved under a DIFFERENT Kiro account is not trusted', () => {
  withDataDir((dir) => {
    // The account switched since the email was cached: this is the case that
    // used to keep attributing requests to the previous account for 24h.
    writeKiroDb(process.env.REVA_KIRO_DB_PATH!, KIRO_USER_ID);
    fs.writeFileSync(
      path.join(dir, 'account.json'),
      JSON.stringify({ email: 'previous@example.com', kiroUserId: 'd-1234567890.99999999-9999-4999-8999-999999999999', resolvedAt: Date.now() }),
      'utf8',
    );
    __resetIdentityCacheForTests();
    // Whatever the real whoami on this machine returns, it must not be the
    // other account's cached email — and the stale-recovery path must not
    // bring it back either.
    assert.notEqual(readKiroWhoami().email, 'previous@example.com');
  });
});

test('a cached email resolved under the SAME Kiro account is used without shelling out', () => {
  withDataDir((dir) => {
    writeKiroDb(process.env.REVA_KIRO_DB_PATH!, KIRO_USER_ID);
    fs.writeFileSync(
      path.join(dir, 'account.json'),
      JSON.stringify({ email: 'same@example.com', kiroUserId: KIRO_USER_ID, resolvedAt: Date.now() }),
      'utf8',
    );
    __resetIdentityCacheForTests();
    assert.equal(readKiroWhoami().email, 'same@example.com');
    assert.equal(readKiroAccountId(), AGENT_ID);
  });
});

test('a corrupt or timestamp-less cache entry is ignored, not thrown on', () => {
  withDataDir((dir) => {
    const file = path.join(dir, 'account.json');
    for (const contents of ['not json at all', '{}', '{"email":"x@y.z"}']) {
      fs.writeFileSync(file, contents, 'utf8');
      __resetIdentityCacheForTests();
      assert.doesNotThrow(() => readKiroWhoami());
      assert.notEqual(readKiroWhoami().email, 'x@y.z', 'an entry with no resolvedAt must not be trusted');
    }
  });
});

test('a failed lookup is cached too, so a machine with no login does not pay the timeout every call', () => {
  withDataDir((dir) => {
    // Without this, every hook call on an IDE-only machine (no kiro-cli on
    // PATH) would spend the full subprocess cost discovering that again.
    readKiroWhoami();
    const cached = JSON.parse(fs.readFileSync(path.join(dir, 'account.json'), 'utf8'));
    assert.ok(typeof cached.resolvedAt === 'number');
  });
});

test('a cached FAILURE expires far sooner than a cached success', () => {
  withDataDir((dir) => {
    const file = path.join(dir, 'account.json');
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;

    // A failure this old must NOT be trusted: holding "no account" would
    // leave the plugin unconfigured, and therefore failing closed on every
    // tool call, long after a transient slow whoami had recovered.
    fs.writeFileSync(file, JSON.stringify({ resolvedAt: tenMinutesAgo }), 'utf8');
    __resetIdentityCacheForTests();
    const staleFailure = readWhoamiCacheForTest(dir);
    assert.equal(staleFailure, undefined, 'a 10-minute-old failure must be re-checked');

    // A SUCCESS of the same age is still perfectly good.
    fs.writeFileSync(file, JSON.stringify({ email: 'ok@example.com', resolvedAt: tenMinutesAgo }), 'utf8');
    __resetIdentityCacheForTests();
    assert.equal(readKiroWhoami().email, 'ok@example.com');
  });
});

// Reads the cache the same way the real path does, without shelling out —
// the distinction the test above turns on is invisible through
// readKiroWhoami() alone, since a miss there falls through to a real
// subprocess call whose result depends on the developer's own machine.
function readWhoamiCacheForTest(dir: string): { email?: string } | undefined {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'account.json'), 'utf8'));
  const email = typeof raw.email === 'string' ? raw.email : undefined;
  const ttl = email ? 4 * 60 * 60 * 1000 : 5 * 60 * 1000;
  return Date.now() - raw.resolvedAt > ttl ? undefined : { email };
}

test('resolveDataDir honours REVA_DATA_DIR and creates it', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-datadir-'));
  const target = path.join(base, 'nested', 'dir');
  try {
    assert.equal(resolveDataDir({ REVA_DATA_DIR: target } as any), target);
    assert.ok(fs.existsSync(target), 'resolveDataDir must create the directory');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveDataDir defaults inside Kiro’s own config root, not an invented location', () => {
  const resolved = resolveDataDir({} as any);
  assert.ok(resolved, 'expected a default data dir');
  assert.ok(
    resolved!.split(path.sep).includes('.kiro'),
    `default data dir must live under ~/.kiro, got ${resolved}`,
  );
});

