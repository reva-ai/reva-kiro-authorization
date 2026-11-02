import * as os from 'node:os';
import { markSessionActive } from './activeSessions';
import { loadConfig, resolveDataDir } from './config';
import { debugLog } from './debug';
import { applyKiroCliEnv } from './kiroSettings';
import { resolveAgentId, resolveMachineId } from './deviceId';
import { ingestAgent, ingestMcpServers, ingestUser, recordMcpDiscoveryTriggered, resolveEntityTypeIds } from './ingestionClient';
import { resolveUserEmail } from './identity';
import { hostLabel, normalizeInput, sessionEntrypoint } from './host';
import { readCachedKiroDefaultModel, recordKiroDefaultModel, recordLaunchModel, resolveSessionModel } from './kiroSession';
import { readKiroDefaultModel, readLaunchModelFlag } from './launchModel';
import { readKiroMcpServers } from './mcpConfig';
import { claimSessionIngestion } from './sessionIngestion';
import { readStdin } from './stdin';

// Wired to Kiro's `SessionStart` hook trigger (kiro.dev/docs/hooks/ lists
// it among the supported trigger types). UNCONFIRMED whether Kiro's
// SessionStart has any blocking/decision-control mechanism at all — assumed
// here that it has none, on the principle that ingestion must never be able
// to block a session, so this file is written the same defensive way
// regardless: nothing in it may ever throw out of main(), and the whole
// function always ends in a clean, silent exit. Confirm this assumption before shipping — if Kiro's
// SessionStart CAN block, that's still fine (this file just never uses that
// capability), but the reverse (assuming non-blocking when it actually can
// block) would be the dangerous mistake.
//
// User and Agent ingestion both run every session, unconditionally — no
// local change-detection cache for either. ingestUser()/ingestAgent()
// (ingestionClient.ts) each do their own GET-then-branch against the
// ingestion API directly, so the live GET result is the only source of
// truth for whether a POST is actually needed — a local "already did this"
// flag would just go stale the moment the record is deleted/changed on the
// Reva side.

// UNCONFIRMED FOR KIRO — see the file-level comment on types.ts. The payload
// shape is the best available reference; verify against a real captured Kiro
// payload.
async function main(): Promise<void> {
  applyKiroCliEnv();
  const raw = await readStdin();
  debugLog(`raw SessionStart stdin: ${raw}`);
  const input = normalizeInput(JSON.parse(raw), 'SessionStart');
  applyKiroCliEnv(process.env, { cwd: input.cwd });
  debugLog(`host=${hostLabel(input.host)}`);
  const pluginDataDir = resolveDataDir();

  // The model a kiro-cli session was launched with (`--model`), recorded
  // once here so the first turn's hooks report it — Kiro itself only
  // records the model after that turn ends. ~2s on Windows, which is why it
  // runs at session start and not per tool call. See launchModel.ts.
  if (input.host === 'kiro-cli' && input.sessionId) {
    try {
      const launched = readLaunchModelFlag();
      if (launched) recordLaunchModel(input.sessionId, launched, pluginDataDir);
      debugLog(`sessionStart: launch model flag = ${launched ?? '(none — Kiro default or chat.defaultModel)'}`);
    } catch (err: any) {
      debugLog(`sessionStart: launch model lookup failed — ${err?.message || String(err)}`);
    }
  }

  // Kiro's own default model, for sessions that choose none — cached for a
  // day because asking kiro-cli costs ~2.4s. Hooks only ever read the cache.
  try {
    const cached = readCachedKiroDefaultModel(pluginDataDir);
    if (!cached.fresh) {
      const kiroDefault = readKiroDefaultModel();
      if (kiroDefault) recordKiroDefaultModel(kiroDefault, pluginDataDir);
      debugLog(`sessionStart: Kiro default model = ${kiroDefault ?? cached.model ?? '(unknown — kiro-cli not reachable)'}`);
    }
  } catch (err: any) {
    debugLog(`sessionStart: Kiro default model lookup failed — ${err?.message || String(err)}`);
  }

  // Both this hook and the first userPromptSubmit of a session try to claim
  // the ingestion pass; the filesystem decides which one wins. On a host
  // where agentSpawn fires normally that is this process, and the prompt
  // hook then skips. On kiro-cli 2.21.3, where agentSpawn does not fire at
  // all, the prompt hook wins and re-invokes this same script detached.
  //
  // KIRO_SESSION_ID is how that detached re-invocation carries the session
  // id, so the claim below recognizes it as already-claimed and this run
  // proceeds rather than bailing — see the `spawned` check.
  const spawned = process.env.REVA_INGESTION_SPAWNED === '1';
  if (!spawned && !claimSessionIngestion(input.sessionId, pluginDataDir)) {
    debugLog('sessionStart: ingestion already claimed for this session — nothing to do');
    process.exit(0);
  }

  // Independent of Reva config being valid at all — this is purely local
  // bookkeeping (which session_ids are active on this machine right now),
  // resolved the same way loadConfig() would derive agentId (same
  // REVA_AGENT_ID precedence), but without needing the rest of loadConfig()
  // to succeed first. resolveAgentId() has no fallback (see deviceId.ts) —
  // until a Kiro account-id source is confirmed and wired in, this always
  // falls through to REVA_AGENT_ID; if that isn't set either, there's no
  // honest id to key this local cache by, so tracking is skipped for this
  // session rather than guessing one.
  const agentId = process.env.REVA_AGENT_ID || resolveAgentId();
  if (!agentId) {
    debugLog('sessionStart: skipped active-session tracking — no account id available and REVA_AGENT_ID not set');
  } else {
    try {
      // sessionEntryPoint is the detected host ('kiro-ide' / 'kiro-cli'),
      // which is a real, observed fact rather than a guessed env var —
      // host.ts derives it from the trigger name the payload actually
      // carried. It also makes the active-session count meaningful when
      // someone runs the IDE and the CLI at the same time.
      markSessionActive(agentId, input.sessionId, sessionEntrypoint(input.host), pluginDataDir);
    } catch (err: any) {
      debugLog(`sessionStart: markSessionActive failed — ${err?.message || String(err)}`);
    }
  }

  try {
    // loadConfig() throws if the auth token or agentId is missing —
    // expected and common here, since a session can start perfectly well
    // with nothing configured at all yet. Caught below, same as any other
    // best-effort ingestion failure, rather than treated as a special case.
    // No separate ingestion token/gate: the same auth token that's already
    // required for evaluation authenticates ingestion too, so ingestion is
    // attempted whenever the plugin is configured at all.
    const cfg = loadConfig();
    const userEmail = resolveUserEmail();

    try {
      const { userEntityTypeId, agentEntityTypeId, mcpServerEntityTypeId } = await resolveEntityTypeIds(cfg, pluginDataDir);

      if (!userEntityTypeId) {
        debugLog('sessionStart: skipped User ingestion — could not resolve entity type id');
      } else {
        // machineId is THIS machine's hardware id, deliberately not
        // cfg.agentId (the account id) — registeredMachineIds needs to
        // distinguish machines, which the account id can't do since it's
        // meant to be the same across every machine the account uses.
        // cfg.agentId is passed too, separately, so ingestUser() can link
        // this User back to its Agent(s) via the User.agents attribute — a
        // different relationship than registeredMachineIds, so a different
        // parameter.
        const machineId = resolveMachineId(pluginDataDir);
        await ingestUser(cfg, userEntityTypeId, userEmail, machineId, cfg.agentId).catch((err) =>
          debugLog(`sessionStart: ingest User failed — ${err}`),
        );
      }

      if (!agentEntityTypeId) {
        debugLog('sessionStart: skipped Agent ingestion — could not resolve entity type id');
      } else {
        // userEmail here is ALSO sent as an ATTRIBUTE on the Agent entity
        // (a reference back to who's using this machine) — separate from,
        // and in addition to, the direct User ingestion above.
        await ingestAgent(cfg, agentEntityTypeId, cfg.agentId, userEmail, resolveSessionModel(input.sessionId, process.env, os.homedir(), pluginDataDir)).catch((err) =>
          debugLog(`sessionStart: ingest Agent failed — ${err}`),
        );
      }

      // A local file read plus one write per not-yet-registered server, so
      // it runs every session — no throttle needed. A server added
      // mid-session is picked up by the prompt hook's 15-minute recheck or
      // on its first tool call (mcpIngestionTrigger.ts); recording this pass
      // starts that 15-minute window now instead of re-reading right away.
      recordMcpDiscoveryTriggered(cfg, pluginDataDir);
      await ingestMcpServers(
        cfg,
        { userEntityTypeId, mcpServerEntityTypeId },
        userEmail,
        readKiroMcpServers(input.cwd || process.cwd()),
        pluginDataDir,
      ).catch((err) => debugLog(`sessionStart: ingest MCP servers failed — ${err}`));
    } catch (err: any) {
      debugLog(`sessionStart: ingestion error — continuing (${err?.message || String(err)})`);
    }
  } catch (err: any) {
    debugLog(`sessionStart: unexpected error — continuing (${err?.message || String(err)})`);
  }

  process.exit(0); // clean no-op pass-through — no stdout, nothing to block on
}

main().catch(() => process.exit(0));
