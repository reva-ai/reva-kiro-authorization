import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { debugLog } from './debug';
import { osFamily } from './kiroSession';
import { KiroMcpServer } from './mcpConfig';
import { RevaConfig } from './types';

// Registers known entities (User, Agent, and — best-effort — MCPServer)
// with Reva's directory ahead of time, so evaluation requests aren't the
// first time the PDP hears about them. Called from sessionStart.ts, which
// treats every function here as best-effort: a failure must never block a
// Kiro session from starting, unlike pdpClient.ts's evaluate(). Only the
// exact endpoint paths/shapes should ever need reconfirming against the
// real Reva API for a new deployment; Kiro-specific bits are isolated to
// ingestMcpServers below (and the config reader in mcpConfig.ts).
//
// User is checked (GET) and ingested every session — NOT gated behind any
// PDP-side "principal exists" check — a separate, ingestion-side GET
// instead. If the GET finds no User yet, one is created via a single POST
// with attributes: [{name: "active", value: "false"}, {name:
// "registeredMachineIds", value: machineId}, {name: "agents", value:
// agentId}] — no separate PATCH needed on that path, since every value can
// just be included at creation time. `active` is never touched again once
// created; this plugin has no way to vet a human, so it never claims the
// record is a real, active user — a human/admin verification flow on the
// Reva side is expected to flip that flag once the person is confirmed. If
// the GET finds a User already there, registeredMachineIds and agents are
// instead PATCH-ADDed, each on its own (both Sets — must accumulate, not
// overwrite, since a different machine or a different account may have
// registered one already), every session, so logging in from a new machine
// or a new account gets appended rather than replacing what's already there.
//
// Confirmed shapes (from the user, not guessed):
//   GET   {ingestionUrl}/policy-store/entity-types
//         -> [{id, name, schemaName}, ...]
//   POST  {ingestionUrl}/entity?entityTypeId={id}
//         body: { entityId, attributes: [{name,value}...], parents: [], children: [] }
//   PATCH {ingestionUrl}/entity/{entityId}?entityTypeId={id}
//         body: { attributeValue: {name, value}, op: "ADD", path: "ATTRIBUTE" }
//         used by addAttributeValue() below — exactly one attributeValue per
//         call, so updating N Set attributes on one entity is N separate
//         PATCH calls, not one. Confirmed uses: User.registeredMachineIds
//         and User.agents, both genuine Sets that must accumulate rather
//         than be overwritten. Also reused for Agent.agentType even though
//         that one is scalar (see ingestAgent() below) — this ADD-op PATCH
//         is the only write-an-attribute shape confirmed so far, so an
//         existing Agent's agentType is updated through it too rather than
//         inventing an unconfirmed "overwrite" shape.
//   GET   {ingestionUrl}/entity/{entityId}?entityTypeId={id}
//         -> 200 { id, entityType, source, ownerStoreId,
//                  entityAttributes: [{name,value}...], createdOn, updatedOn, name }
//         -> 404 or 400, both treated as not found (some backends return
//            400 rather than a clean 404 for an unresolvable entityId here)
//         used by entityExists() below — this response's attributes aren't
//         otherwise inspected, only whether the GET resolves 200 vs 404.

interface EntityTypeRecord {
  id: string;
  name: string;
  schemaName: string;
}

interface EntityAttribute {
  name: string;
  value: string;
}

interface IngestionCacheEntry {
  userEntityTypeId?: string;
  agentEntityTypeId?: string;
  mcpServerEntityTypeId?: string;
  // MCP server names fully registered, keyed by User email — see
  // ingestMcpServers. A name whose writes failed is left out so the next
  // session retries it.
  ingestedMcpServers?: Record<string, string[]>;
  // When the last mid-session MCP pass was TRIGGERED (not finished) — see
  // isMcpDiscoveryDue / isMcpInvokeIngestDue below and mcpIngestionTrigger.ts.
  lastMcpDiscoveryTriggeredAt?: number;
  // Kept separate from lastMcpDiscoveryTriggeredAt: sharing it would mean a
  // server first used two minutes after a recheck waits out the rest of the
  // 15-minute window instead of being registered on first use.
  lastMcpInvokeIngestAt?: number;
}

// No fallback: only ever writes inside REVA_DATA_DIR — a plugin-owned env
// var, not a Kiro-provided one (see config.ts and hopChain.ts's comment for
// why). Without it, there is nothing honest to write to — every
// change-signature check just always reports "changed," so ingestion is
// simply attempted fresh on every session rather than caching anything.
function cacheDir(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'entity-types') : undefined;
}

// The cached entity-type ids are UUIDs belonging to ONE policy store. Point
// the plugin at a different store (or a different host) and every one of
// them is wrong: ingestion would keep POSTing `?entityTypeId=<the old
// store's User type>` at the new store, which fails or — worse — writes
// somewhere unintended.
//
// So the cache file is keyed by the ingestion URL, the configured store id,
// AND the auth token. The token matters because REVA_POLICY_STORE_ID is
// normally unset — the backend resolves the store from the token — so
// moving to a new store usually means swapping only REVA_AUTH_TOKEN.
// Without the token in the key, that swap kept the old store's ids and
// silently wrote the User/Agent into the OLD store. Switching any of the
// three lands on a different file and re-resolves from scratch, with no
// manual cleanup and no stale-cache window. The old file stays behind
// harmlessly and becomes live again if you switch back. (A rotated token
// for the same store just costs one extra entity-types GET.)
//
// Hashed rather than used literally because a URL contains characters that
// are not safe in a filename, and the token must never land on disk in the
// clear; 16 hex chars is far more than enough to keep a handful of stores
// on one machine distinct.
export function cacheScopeKey(cfg: RevaConfig): string {
  return createHash('sha256')
    .update(`${cfg.ingestionUrl}|${cfg.policyStoreId}|${cfg.authorization}`)
    .digest('hex')
    .slice(0, 16);
}

// Shared across every concurrently-open Kiro session on the machine. Worst
// case on a cold-cache race between two sessions is a harmless duplicate
// GET/POST, not corruption.
export function cacheFile(cfg: RevaConfig, pluginDataDir?: string): string | undefined {
  const dir = cacheDir(pluginDataDir);
  return dir ? path.join(dir, `catalog-${cacheScopeKey(cfg)}.json`) : undefined;
}

function loadIngestionCache(cfg: RevaConfig, pluginDataDir?: string): IngestionCacheEntry | undefined {
  const file = cacheFile(cfg, pluginDataDir);
  if (!file) return undefined;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as IngestionCacheEntry;
  } catch {
    return undefined;
  }
}

function saveIngestionCache(entry: IngestionCacheEntry, cfg: RevaConfig, pluginDataDir?: string): void {
  const dir = cacheDir(pluginDataDir);
  const file = cacheFile(cfg, pluginDataDir);
  if (!dir || !file) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Merge onto whatever's already cached (entity-type ids and ingested
    // signatures are written independently, at different points in
    // sessionStart.ts's flow) rather than clobbering one with the other.
    const existing = loadIngestionCache(cfg, pluginDataDir) || {};
    fs.writeFileSync(file, JSON.stringify({ ...existing, ...entry }), 'utf8');
  } catch {
    // best effort — a fetch/ingest just happens again next session
  }
}

async function ingestionFetch(cfg: RevaConfig, url: string, method: string, body?: unknown): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.ingestionTimeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.authorization ? { 'X-API-Token': cfg.authorization } : {}),
        // Same header as evaluation — one store id for everything this
        // plugin does, exactly like the single auth token above.
        ...(cfg.policyStoreId ? { [cfg.policyStoreHeader]: cfg.policyStoreId } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ingestion API returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return await res.json().catch(() => undefined);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEntityTypes(cfg: RevaConfig): Promise<EntityTypeRecord[]> {
  const url = `${cfg.ingestionUrl}/policy-store/entity-types`;
  const raw = await ingestionFetch(cfg, url, 'GET');
  return Array.isArray(raw) ? raw : [];
}

// Resolves the entity-type ids ingestion calls need to pass as
// `entityTypeId`, caching them so a normal session start doesn't cost a
// network round-trip once they're known. Falls back to whatever was already
// cached if a fresh fetch fails.
export async function resolveEntityTypeIds(
  cfg: RevaConfig,
  pluginDataDir?: string,
): Promise<{ userEntityTypeId?: string; agentEntityTypeId?: string; mcpServerEntityTypeId?: string }> {
  const cached = loadIngestionCache(cfg, pluginDataDir);
  // All three must be resolved for the cache to count as fresh — a partial
  // result (e.g. MCPServer missing because it wasn't yet in the catalog on
  // an earlier fetch) keeps retrying on future sessions instead of getting
  // stuck on the same gap forever.
  if (cached?.userEntityTypeId && cached?.agentEntityTypeId && cached?.mcpServerEntityTypeId) {
    return cached;
  }

  try {
    const types = await fetchEntityTypes(cfg);
    // Matched by name alone — confirmed against Reva's real API that
    // there's exactly one entity type per name in this catalog, so a
    // schemaName filter is unnecessary complexity. Warn (not fail) if that
    // assumption is ever violated, so a silent misresolution at least
    // leaves a trace under REVA_DEBUG=1.
    for (const name of ['User', 'Agent', 'MCPServer']) {
      const matches = types.filter((t) => t.name === name);
      if (matches.length > 1) {
        debugLog(`resolveEntityTypeIds: multiple entity types named "${name}" — using the first (id=${matches[0].id})`);
      }
    }
    const entry: IngestionCacheEntry = {
      userEntityTypeId: types.find((t) => t.name === 'User')?.id,
      agentEntityTypeId: types.find((t) => t.name === 'Agent')?.id,
      mcpServerEntityTypeId: types.find((t) => t.name === 'MCPServer')?.id,
    };
    saveIngestionCache(entry, cfg, pluginDataDir);
    return entry;
  } catch {
    return cached || {};
  }
}

async function postEntity(cfg: RevaConfig, entityTypeId: string, entityId: string, attributes: EntityAttribute[]): Promise<void> {
  const url = `${cfg.ingestionUrl}/entity?entityTypeId=${encodeURIComponent(entityTypeId)}`;
  await ingestionFetch(cfg, url, 'POST', { entityId, attributes, parents: [], children: [] });
}

// Confirmed shape: PATCH /entity/{entityId}?entityTypeId={id}, body
// {attributeValue: {name, value}, op: "ADD", path: "ATTRIBUTE"}. The
// confirmed, load-bearing use is User.registeredMachineIds — a genuine Set
// (one User can log in from multiple machines), where a plain overwrite
// would let whichever call lands last clobber what an earlier one already
// recorded, so ADD accumulates instead. Also used to update an existing
// Agent's agentType (see ingestAgent() below) — that one is scalar, not a
// Set, but this ADD-op PATCH is the only confirmed way to write an
// attribute onto an already-existing entity, so it's reused as-is rather
// than guessing at an unconfirmed "overwrite" shape.
async function addAttributeValue(cfg: RevaConfig, entityTypeId: string, entityId: string, attribute: EntityAttribute): Promise<void> {
  const url = `${cfg.ingestionUrl}/entity/${encodeURIComponent(entityId)}?entityTypeId=${encodeURIComponent(entityTypeId)}`;
  await ingestionFetch(cfg, url, 'PATCH', { attributeValue: attribute, op: 'ADD', path: 'ATTRIBUTE' });
}

// Confirmed shape:
//   GET {ingestionUrl}/entity/{entityId}?entityTypeId={id}
//   200 -> a full entity record (id/entityAttributes/createdOn/...) — exists
//   404 or 400 -> not found (some backends return 400 rather than a clean
//                 404 for an unresolvable entityId on this lookup)
// Nothing in the 200 body is otherwise inspected — this only answers "does
// this entity already exist," which ingestUser()/ingestAgent() both use to
// decide whether to POST a new one. Generic over entity type/id — the
// mechanics are identical for User and Agent, only which
// entityTypeId/entityId gets passed differs. Any status/error other than a
// clean 200/404/400 is a genuine failure, not a decision either way —
// thrown, not swallowed here, so the caller can choose how to treat
// "inconclusive".
async function entityExists(cfg: RevaConfig, entityTypeId: string, entityId: string): Promise<boolean> {
  const url = `${cfg.ingestionUrl}/entity/${encodeURIComponent(entityId)}?entityTypeId=${encodeURIComponent(entityTypeId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.ingestionTimeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        ...(cfg.authorization ? { 'X-API-Token': cfg.authorization } : {}),
      },
      signal: controller.signal,
    });
    // 404 is the obvious "not found." 400 is also treated as not-found —
    // some backends return it for an unresolvable entityId on this v1
    // lookup rather than a clean 404, and there's nothing else a 400 on a
    // plain GET-by-id could mean here (no request body to be malformed).
    if (res.status === 404 || res.status === 400) return false;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ingestion GET entity returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

// A hardcoded constant naming *which coding tool this is* — not detected at
// runtime, since this plugin only ever runs loaded through Kiro's own
// hook/power system, so there's no real signal to detect from inside this
// codebase. Exported since context.ts also sends this as context.agentType
// on every evaluation request, not just ingestion's Agent.agentType — one
// constant, kept in sync everywhere.
export const AGENT_TYPE = 'Kiro';

// GET-then-branch, every session: entityExists() (GET, above) decides
// whether to POST a new User at all — never re-created if one's already
// there. Not found: a single POST creates the User with `active`,
// registeredMachineIds, AND agents already set — no follow-up PATCH
// needed, since there's nothing to accumulate onto yet on a brand-new
// entity. Found: no POST (never re-created), just two PATCH-ADDs — one for
// registeredMachineIds, one for agents — each on its own, since this
// existing User's Sets may already hold values (a different machine, a
// different account) that must be kept, not overwritten (see
// addAttributeValue). Two separate PATCH calls, not one, because the
// confirmed wire shape carries exactly one attributeValue per PATCH — there
// is no confirmed way to ADD to two different Set attributes in one call.
// Logging in from the same machine/account twice is a harmless repeat ADD
// either way (Set semantics).
//
// agents links this User back to every Agent (account id) it's associated
// with — a Set, deliberately, since one human could in principle be linked
// to more than one account over time (a re-auth, a second account); value
// is always cfg.agentId, the same id ingestAgent() below uses as the Agent
// entity's own id.
//
// `active` is only ever sent once, in that creation POST, as "false" —
// this plugin has no basis to vouch for the human behind userEmail, and
// never touches `active` again once a User is found to already exist. A
// human/admin verification flow on the Reva side, not this plugin, is what's
// expected to flip active to true.
//
// On an inconclusive existence check (anything other than a clean
// found/not-found — network error, 5xx, timeout), this deliberately does
// NOT guess "not found": erring toward "assume it might already exist,
// don't risk a duplicate/conflicting create" is safer than a wrong POST,
// and the whole check just runs again next session once the underlying
// problem clears. That means an inconclusive check takes the same
// PATCH-only path as "found" — if the User genuinely doesn't exist yet,
// those PATCHes fail harmlessly (logged, not fatal) and the whole thing
// retries next session same as the rest of this file's best-effort calls.
export async function ingestUser(
  cfg: RevaConfig,
  userEntityTypeId: string,
  userEmail: string,
  // This machine's real hardware GUID, or undefined when it could not be
  // read — then no machine is registered for this session rather than an
  // invented id (see deviceId.ts resolveMachineId).
  machineId: string | undefined,
  agentId: string,
): Promise<void> {
  const exists = await entityExists(cfg, userEntityTypeId, userEmail).catch((err) => {
    debugLog(`ingestUser: existence check failed (assuming exists, skipping create) — ${err}`);
    return true;
  });

  if (!exists) {
    await postEntity(cfg, userEntityTypeId, userEmail, [
      { name: 'active', value: 'false' },
      ...(machineId ? [{ name: 'registeredMachineIds', value: machineId }] : []),
      { name: 'agents', value: agentId },
    ]).catch((err) => debugLog(`ingestUser: POST failed — ${err}`));
  } else {
    if (machineId) {
      await addAttributeValue(cfg, userEntityTypeId, userEmail, { name: 'registeredMachineIds', value: machineId }).catch(
        (err) => debugLog(`ingestUser: PATCH registeredMachineIds failed — ${err}`),
      );
    } else {
      debugLog('ingestUser: hardware GUID unavailable — no machine registered this session (nothing invented)');
    }
    await addAttributeValue(cfg, userEntityTypeId, userEmail, { name: 'agents', value: agentId }).catch((err) =>
      debugLog(`ingestUser: PATCH agents failed — ${err}`),
    );
  }
}

// Same GET-then-branch pattern as ingestUser() above, restructured the same
// way: entityExists() (GET) decides whether to POST a new Agent at all —
// never re-created (with a fresh, possibly-stale `user` attribute) if one's
// already there for this account. Not found: a single POST creates the
// Agent with both `user` and agentType already set — no follow-up PATCH
// needed. Found: no POST, just an update of agentType on its own, via the
// same ADD-op PATCH addAttributeValue() also uses for genuine Sets (see its
// own comment) — the only confirmed write-an-attribute shape available.
//
// agentType is a scalar, not a Set — Agent's id is the stable account id
// (see deviceId.ts's resolveAgentId), and from this plugin's own
// perspective that account is always talking to Reva through exactly one
// tool, this one, so there's nothing to accumulate: agentType is always
// AGENT_TYPE ("Kiro"), full stop.
//
// userEmail here is only ever sent as an ATTRIBUTE VALUE on the Agent
// entity (a reference back to which human this account belongs to) — this
// never creates, updates, or otherwise writes to the User entity itself
// (ingestUser() above does, separately).
//
// Same inconclusive-check handling as ingestUser(): anything other than a
// clean found/not-found (network error, 5xx, timeout) assumes "exists,"
// taking the same PATCH-only path as a genuine "found" rather than risking
// a wrong POST — the whole check just runs again next session. If the
// Agent genuinely doesn't exist yet, that PATCH fails harmlessly (logged,
// not fatal) and retries next session same as the rest of this file's
// best-effort calls.
// Attribute names follow the CodingAgent schema's vocabulary exactly — a
// singular scalar `agentType`, plus the plural Sets `operatingSystems` and
// `models`. That is the point of a fixed vocabulary: a Cedar policy written
// against `agentType == "Kiro"` matches as written. The Reva console also
// reads `agentType` to label the User's "Coding agent" field; an earlier
// version of this file sent a plural `agentTypes`, which nothing else uses,
// so the console fell back to showing the raw Agent id.
//
// Each attribute gets its own PATCH, and each is caught separately, so a
// schema that declares `agentType` but not `operatingSystems` still records
// what it can rather than losing the whole update to one rejection.
export async function ingestAgent(
  cfg: RevaConfig,
  agentEntityTypeId: string,
  agentId: string,
  userEmail: string,
  model?: string,
): Promise<void> {
  const exists = await entityExists(cfg, agentEntityTypeId, agentId).catch((err) => {
    debugLog(`ingestAgent: existence check failed (assuming exists, skipping create) — ${err}`);
    return true;
  });

  if (!exists) {
    await postEntity(cfg, agentEntityTypeId, agentId, [
      { name: 'user', value: userEmail },
      { name: 'agentType', value: AGENT_TYPE },
      { name: 'operatingSystems', value: osFamily() },
      // Only when one was actually resolved from the session record —
      // never a placeholder. Kiro does not put the model on the wire at
      // all, so this is frequently absent, and absent is the honest answer.
      ...(model ? [{ name: 'models', value: model }] : []),
    ]).catch((err) => debugLog(`ingestAgent: POST failed — ${err}`));
    return;
  }

  await addAttributeValue(cfg, agentEntityTypeId, agentId, { name: 'agentType', value: AGENT_TYPE }).catch((err) =>
    debugLog(`ingestAgent: PATCH agentType failed — ${err}`),
  );
  await addAttributeValue(cfg, agentEntityTypeId, agentId, {
    name: 'operatingSystems',
    value: osFamily(),
  }).catch((err) => debugLog(`ingestAgent: PATCH operatingSystems failed (schema may not declare it) — ${err}`));
  if (model) {
    await addAttributeValue(cfg, agentEntityTypeId, agentId, { name: 'models', value: model }).catch((err) =>
      debugLog(`ingestAgent: PATCH models failed (schema may not declare it) — ${err}`),
    );
  }
}


// Registers every MCP server Kiro is configured with (see mcpConfig.ts),
// in two independent halves:
//
//   1. User.registeredMcpServers — PATCH-ADD the server NAME onto the User,
//      for every server, local or remote. This is the Set the Reva console
//      lists as "Linked MCP Servers".
//   2. An MCPServer entity — only for a REMOTE server, because MCPServer's
//      schema requires `baseUrl` and a stdio server has none. A local
//      server is never given a fabricated one. GET first, so an MCPServer
//      that already exists (registered by another session or machine) is
//      not POSTed again.
//
// Replaces an earlier version that read only `<cwd>/mcp.json` and polled
// `kiro-cli mcp list`. Neither found anything on a real install: Kiro keeps
// its servers in `settings/mcp.json`, and `mcp list` prints names without
// URLs — and nothing at all to a non-interactive stdout on 2.33.0.
//
// A name is recorded as done only after every half it needed succeeded, so
// a failed write is retried next session rather than hidden forever. Done
// names are tracked PER USER: registeredMcpServers lives on the User, so a
// different account signing in on this machine still gets its own writes.
//
// Best-effort like the rest of this file: every write is caught and logged
// on its own, and nothing here throws to the caller.
export async function ingestMcpServers(
  cfg: RevaConfig,
  ids: { userEntityTypeId?: string; mcpServerEntityTypeId?: string },
  userEmail: string,
  servers: KiroMcpServer[],
  pluginDataDir?: string,
): Promise<void> {
  if (servers.length === 0) {
    debugLog('ingestMcpServers: no MCP servers configured');
    return;
  }

  const cached = loadIngestionCache(cfg, pluginDataDir);
  const done = new Set(cached?.ingestedMcpServers?.[userEmail] || []);

  for (const server of servers) {
    if (done.has(server.name)) continue;

    let userSideDone = false;
    if (ids.userEntityTypeId) {
      try {
        await addAttributeValue(cfg, ids.userEntityTypeId, userEmail, { name: 'registeredMcpServers', value: server.name });
        userSideDone = true;
      } catch (err) {
        debugLog(`ingestMcpServers: PATCH registeredMcpServers "${server.name}" failed — ${err}`);
      }
    }

    let serverSideDone = !server.url; // a local server has no MCPServer entity to create
    if (server.url && ids.mcpServerEntityTypeId) {
      try {
        const exists = await entityExists(cfg, ids.mcpServerEntityTypeId, server.name);
        if (!exists) {
          await postEntity(cfg, ids.mcpServerEntityTypeId, server.name, [
            { name: 'description', value: `MCP server "${server.name}"` },
            { name: 'transport', value: 'http' },
            { name: 'baseUrl', value: server.url },
            { name: 'connectionType', value: 'remote' },
          ]);
        }
        serverSideDone = true;
      } catch (err) {
        debugLog(`ingestMcpServers: MCPServer "${server.name}" failed — ${err}`);
      }
    }

    debugLog(
      `ingestMcpServers: "${server.name}" (${server.url ? 'remote' : 'local'}) — ` +
        `registeredMcpServers ${userSideDone ? 'ok' : 'FAILED'}` +
        (server.url ? `, MCPServer ${serverSideDone ? 'ok' : 'FAILED'}` : ''),
    );
    if (userSideDone && serverSideDone) done.add(server.name);
  }

  saveIngestionCache(
    { ingestedMcpServers: { ...(cached?.ingestedMcpServers || {}), [userEmail]: [...done] } },
    cfg,
    pluginDataDir,
  );
}

// Mid-session MCP pickup (mcpIngestionTrigger.ts). Throttles: a full re-read
// of Kiro's mcp.json files at most every 15 minutes from the prompt hook,
// and an ingest-on-invoke spawn at most once a minute from PreToolUse.
//
// Without a data dir there is nowhere to record "already triggered", so
// "due" would be true on every single hook call. Both report false instead
// — the once-per-session pass in sessionStart.ts still runs.
const MCP_DISCOVERY_RECHECK_INTERVAL_MS = 15 * 60 * 1000;
const MCP_INVOKE_INGEST_INTERVAL_MS = 60 * 1000;

export function isMcpDiscoveryDue(cfg: RevaConfig, pluginDataDir?: string): boolean {
  if (!pluginDataDir) return false;
  const cached = loadIngestionCache(cfg, pluginDataDir);
  return Date.now() - (cached?.lastMcpDiscoveryTriggeredAt ?? 0) >= MCP_DISCOVERY_RECHECK_INTERVAL_MS;
}

export function recordMcpDiscoveryTriggered(cfg: RevaConfig, pluginDataDir?: string): void {
  saveIngestionCache({ lastMcpDiscoveryTriggeredAt: Date.now() }, cfg, pluginDataDir);
}

// "Already registered for this User" — the same per-user done list
// ingestMcpServers maintains, so a name whose writes failed reads as
// unknown and is retried on its next use.
export function isMcpServerKnown(cfg: RevaConfig, userEmail: string, name: string, pluginDataDir?: string): boolean {
  const cached = loadIngestionCache(cfg, pluginDataDir);
  return (cached?.ingestedMcpServers?.[userEmail] || []).includes(name);
}

export function isMcpInvokeIngestDue(cfg: RevaConfig, pluginDataDir?: string): boolean {
  if (!pluginDataDir) return false;
  const cached = loadIngestionCache(cfg, pluginDataDir);
  return Date.now() - (cached?.lastMcpInvokeIngestAt ?? 0) >= MCP_INVOKE_INGEST_INTERVAL_MS;
}

export function recordMcpInvokeIngestTriggered(cfg: RevaConfig, pluginDataDir?: string): void {
  saveIngestionCache({ lastMcpInvokeIngestAt: Date.now() }, cfg, pluginDataDir);
}
