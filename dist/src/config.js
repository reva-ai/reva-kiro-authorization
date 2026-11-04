"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveDataDir = exports.DEFAULT_POLICY_STORE_HEADER = exports.DEFAULT_HOST = void 0;
exports.urlFromHost = urlFromHost;
exports.loadConfig = loadConfig;
const deviceId_1 = require("./deviceId");
const kiroSettings_1 = require("./kiroSettings");
const DEFAULT_TIMEOUT_MS = 25000;
const PDP_PATH = '/pdp/v2/ai/evaluation';
const INGESTION_PATH = '/ingestion/v2';
//  REVA_HOST overrides this.
exports.DEFAULT_HOST = 'api.reva.ai';
// The header carrying REVA_POLICY_STORE_ID when one is configured.
//
// This name is NOT a guess. `scripts/mock-pdp-server.mjs`, which speaks
// Reva's wire contract, reads exactly `req.headers.policystoreid` when
// logging an incoming request. Node lowercases every incoming header name,
// so the wire name it was written against is `policyStoreId`. That mock is
// the closest thing to a captured request available here. An earlier draft
// of this constant used `X-Policy-Store-Id` purely from convention and was
// wrong.
//
// Still worth confirming against a live deployment: no captured request
// carried a store id at all, because every known deployment resolves the
// store from the auth token instead (the ingestion API returns it as
// `ownerStoreId`). So this is "corroborated by Reva's own mock" rather than
// "seen on the wire" — a real difference, hence REVA_POLICY_STORE_HEADER
// existing at all.
//
// Why a HEADER and not the request body: `context` is closed per Cedar
// action, so an undeclared body field is a schema violation that gets the
// whole request rejected. An unrecognized header is ignored by every HTTP
// server, so a wrong name here degrades to "no effect" rather than a broken
// call.
exports.DEFAULT_POLICY_STORE_HEADER = 'policyStoreId';
// Deliberately much shorter than the evaluation timeout — ingestion is
// best-effort with zero user-facing value on failure (see sessionStart.ts),
// so there's no reason to let it stall session startup anywhere near as
// long as an evaluation call, which is actually gating a real action.
const DEFAULT_INGESTION_TIMEOUT_MS = 5000;
// Configuration sources, in precedence order (later wins when non-empty):
//
//   1. ~/.kiro/settings/cli.json → top-level `env` (durable; see kiroSettings.ts)
//   2. <cwd>/.kiro/settings/cli.json → same shape (workspace override)
//   3. process.env REVA_* (one-shot shell export still overrides the file)
//
// Kiro Powers have no install-time configuration prompt, so cli.json `env`
// is the durable path and process.env remains the override.
function readEnv(env, revaVar) {
    return env[revaVar] || '';
}
// Re-exported from deviceId.ts, which owns it — deviceId.ts needs the same
// directory for its own account cache and cannot import this file (config.ts
// imports deviceId.ts, so that would be a cycle). See resolveDataDir there
// for why ~/.kiro/reva-governance is the default and why that is not an
// invented fallback location.
var deviceId_2 = require("./deviceId");
Object.defineProperty(exports, "resolveDataDir", { enumerable: true, get: function () { return deviceId_2.resolveDataDir; } });
function normalizeHost(raw) {
    return raw.trim().replace(/\/+$/, '').replace(/^https?:\/\//, '');
}
function schemeForHost(host) {
    const h = host.toLowerCase();
    if (h.startsWith('localhost') || h.startsWith('127.0.0.1') || h.startsWith('[::1]')) {
        return 'http';
    }
    return 'https';
}
function urlFromHost(host, path) {
    const normalized = normalizeHost(host);
    return `${schemeForHost(normalized)}://${normalized}${path}`;
}
/**
 * `settingsPath` is for tests only — pins a single cli.json instead of the
 * global/workspace lookup.
 *
 * cli.json is consulted when:
 *   - `settingsPath` is passed (tests), or
 *   - `env` is the live `process.env` (hook entrypoints)
 *
 * Synthetic env objects in unit tests are used as-is, so they never bleed
 * in whatever happens to sit in ~/.kiro/settings/cli.json on the machine
 * running the suite.
 */
function loadConfig(env = process.env, settingsPath) {
    const effective = settingsPath !== undefined || env === process.env
        ? (0, kiroSettings_1.mergeEnvWithKiroCli)(env, { settingsPath })
        : env;
    // Host resolution: REVA_HOST if set, otherwise the built-in default.
    // Paths are fixed in code.
    const host = effective.REVA_HOST?.trim() || exports.DEFAULT_HOST;
    const pdpUrl = urlFromHost(host, PDP_PATH);
    const ingestionUrl = urlFromHost(host, INGESTION_PATH);
    // One token authenticates everything this plugin does — evaluation AND
    // ingestion. No separate ingestion credential, no fallback logic: there's
    // only ever one token to set, here.
    const authorization = readEnv(effective, 'REVA_AUTH_TOKEN');
    // Auth token is the only required value — an empty token would just
    // produce a guaranteed, confusing 401 several steps later. Fail immediately
    // with a specific reason instead: authorize.ts/authorizePrompt.ts's
    // existing main().catch(...) turns this into a clear fail-closed deny;
    // sessionStart.ts's own try/catch turns it into a clear skip reason
    // without ever blocking the session.
    if (!authorization) {
        throw new Error('Reva governance is not configured — missing: REVA_AUTH_TOKEN ' +
            '(set env.REVA_AUTH_TOKEN in ~/.kiro/settings/cli.json, or export REVA_AUTH_TOKEN)');
    }
    // Defaults to the logged-in Kiro account's own user id, read from
    // kiro-cli's local state database (see deviceId.ts), so the Agent's Cedar
    // identity is the id Kiro assigns the account and is stable across every
    // machine that account uses. No fallback to a hardware id or a made-up
    // one — see deviceId.ts for why that would be dishonest for the Agent's
    // own identity specifically.
    // When no account is logged in, or kiro-cli's database can't be read
    // (an IDE-only install, Node older than 22.5), fail loudly here.
    const agentId = effective.REVA_AGENT_ID || (0, deviceId_1.resolveAgentId)();
    if (!agentId) {
        throw new Error('Reva governance is not configured — missing: REVA_AGENT_ID. ' +
            'Could not resolve the Kiro account id: either no account is logged in (`kiro-cli whoami` returned ' +
            'no Email line, is not on PATH, or timed out), or kiro-cli\'s local database could not be read ' +
            '(it needs Node 22.5+; set REVA_KIRO_DB_PATH if data.sqlite3 lives somewhere unusual). ' +
            'Fix by setting REVA_AGENT_ID in ~/.kiro/settings/cli.json env, or exporting it — recommended for any ' +
            'non-interactive or latency-sensitive setup — or by running `kiro-cli login` and re-running ' +
            '`npm run install-hooks` to pre-warm the cache.');
    }
    return {
        pdpUrl,
        authorization,
        agentId,
        // Optional. Unset (the default) sends no header at all, which is how
        // every deployment confirmed so far works — the PDP resolves the store
        // from the auth token. Set it when a deployment serves more than one
        // store behind one token, or when a dev server asks for it explicitly.
        policyStoreId: effective.REVA_POLICY_STORE_ID?.trim() || '',
        policyStoreHeader: effective.REVA_POLICY_STORE_HEADER?.trim() || exports.DEFAULT_POLICY_STORE_HEADER,
        timeoutMs: Number(effective.REVA_PDP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
        ingestionUrl,
        ingestionTimeoutMs: Number(effective.REVA_INGESTION_TIMEOUT_MS) || DEFAULT_INGESTION_TIMEOUT_MS,
    };
}
