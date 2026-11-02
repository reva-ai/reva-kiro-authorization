"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const os = __importStar(require("node:os"));
const activeSessions_1 = require("./activeSessions");
const config_1 = require("./config");
const debug_1 = require("./debug");
const kiroSettings_1 = require("./kiroSettings");
const deviceId_1 = require("./deviceId");
const ingestionClient_1 = require("./ingestionClient");
const identity_1 = require("./identity");
const host_1 = require("./host");
const kiroSession_1 = require("./kiroSession");
const launchModel_1 = require("./launchModel");
const mcpConfig_1 = require("./mcpConfig");
const sessionIngestion_1 = require("./sessionIngestion");
const stdin_1 = require("./stdin");
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
async function main() {
    (0, kiroSettings_1.applyKiroCliEnv)();
    const raw = await (0, stdin_1.readStdin)();
    (0, debug_1.debugLog)(`raw SessionStart stdin: ${raw}`);
    const input = (0, host_1.normalizeInput)(JSON.parse(raw), 'SessionStart');
    (0, kiroSettings_1.applyKiroCliEnv)(process.env, { cwd: input.cwd });
    (0, debug_1.debugLog)(`host=${(0, host_1.hostLabel)(input.host)}`);
    const pluginDataDir = (0, config_1.resolveDataDir)();
    // The model a kiro-cli session was launched with (`--model`), recorded
    // once here so the first turn's hooks report it — Kiro itself only
    // records the model after that turn ends. ~2s on Windows, which is why it
    // runs at session start and not per tool call. See launchModel.ts.
    if (input.host === 'kiro-cli' && input.sessionId) {
        try {
            const launched = (0, launchModel_1.readLaunchModelFlag)();
            if (launched)
                (0, kiroSession_1.recordLaunchModel)(input.sessionId, launched, pluginDataDir);
            (0, debug_1.debugLog)(`sessionStart: launch model flag = ${launched ?? '(none — Kiro default or chat.defaultModel)'}`);
        }
        catch (err) {
            (0, debug_1.debugLog)(`sessionStart: launch model lookup failed — ${err?.message || String(err)}`);
        }
    }
    // Kiro's own default model, for sessions that choose none — cached for a
    // day because asking kiro-cli costs ~2.4s. Hooks only ever read the cache.
    try {
        const cached = (0, kiroSession_1.readCachedKiroDefaultModel)(pluginDataDir);
        if (!cached.fresh) {
            const kiroDefault = (0, launchModel_1.readKiroDefaultModel)();
            if (kiroDefault)
                (0, kiroSession_1.recordKiroDefaultModel)(kiroDefault, pluginDataDir);
            (0, debug_1.debugLog)(`sessionStart: Kiro default model = ${kiroDefault ?? cached.model ?? '(unknown — kiro-cli not reachable)'}`);
        }
    }
    catch (err) {
        (0, debug_1.debugLog)(`sessionStart: Kiro default model lookup failed — ${err?.message || String(err)}`);
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
    if (!spawned && !(0, sessionIngestion_1.claimSessionIngestion)(input.sessionId, pluginDataDir)) {
        (0, debug_1.debugLog)('sessionStart: ingestion already claimed for this session — nothing to do');
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
    const agentId = process.env.REVA_AGENT_ID || (0, deviceId_1.resolveAgentId)();
    if (!agentId) {
        (0, debug_1.debugLog)('sessionStart: skipped active-session tracking — no account id available and REVA_AGENT_ID not set');
    }
    else {
        try {
            // sessionEntryPoint is the detected host ('kiro-ide' / 'kiro-cli'),
            // which is a real, observed fact rather than a guessed env var —
            // host.ts derives it from the trigger name the payload actually
            // carried. It also makes the active-session count meaningful when
            // someone runs the IDE and the CLI at the same time.
            (0, activeSessions_1.markSessionActive)(agentId, input.sessionId, (0, host_1.sessionEntrypoint)(input.host), pluginDataDir);
        }
        catch (err) {
            (0, debug_1.debugLog)(`sessionStart: markSessionActive failed — ${err?.message || String(err)}`);
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
        const cfg = (0, config_1.loadConfig)();
        const userEmail = (0, identity_1.resolveUserEmail)();
        try {
            const { userEntityTypeId, agentEntityTypeId, mcpServerEntityTypeId } = await (0, ingestionClient_1.resolveEntityTypeIds)(cfg, pluginDataDir);
            if (!userEntityTypeId) {
                (0, debug_1.debugLog)('sessionStart: skipped User ingestion — could not resolve entity type id');
            }
            else {
                // machineId is THIS machine's hardware id, deliberately not
                // cfg.agentId (the account id) — registeredMachineIds needs to
                // distinguish machines, which the account id can't do since it's
                // meant to be the same across every machine the account uses.
                // cfg.agentId is passed too, separately, so ingestUser() can link
                // this User back to its Agent(s) via the User.agents attribute — a
                // different relationship than registeredMachineIds, so a different
                // parameter.
                const machineId = (0, deviceId_1.resolveMachineId)(pluginDataDir);
                await (0, ingestionClient_1.ingestUser)(cfg, userEntityTypeId, userEmail, machineId, cfg.agentId).catch((err) => (0, debug_1.debugLog)(`sessionStart: ingest User failed — ${err}`));
            }
            if (!agentEntityTypeId) {
                (0, debug_1.debugLog)('sessionStart: skipped Agent ingestion — could not resolve entity type id');
            }
            else {
                // userEmail here is ALSO sent as an ATTRIBUTE on the Agent entity
                // (a reference back to who's using this machine) — separate from,
                // and in addition to, the direct User ingestion above.
                await (0, ingestionClient_1.ingestAgent)(cfg, agentEntityTypeId, cfg.agentId, userEmail, (0, kiroSession_1.resolveSessionModel)(input.sessionId, process.env, os.homedir(), pluginDataDir)).catch((err) => (0, debug_1.debugLog)(`sessionStart: ingest Agent failed — ${err}`));
            }
            // A local file read plus one write per not-yet-registered server, so
            // it runs every session — no throttle needed. A server added
            // mid-session is picked up by the prompt hook's 15-minute recheck or
            // on its first tool call (mcpIngestionTrigger.ts); recording this pass
            // starts that 15-minute window now instead of re-reading right away.
            (0, ingestionClient_1.recordMcpDiscoveryTriggered)(cfg, pluginDataDir);
            await (0, ingestionClient_1.ingestMcpServers)(cfg, { userEntityTypeId, mcpServerEntityTypeId }, userEmail, (0, mcpConfig_1.readKiroMcpServers)(input.cwd || process.cwd()), pluginDataDir).catch((err) => (0, debug_1.debugLog)(`sessionStart: ingest MCP servers failed — ${err}`));
        }
        catch (err) {
            (0, debug_1.debugLog)(`sessionStart: ingestion error — continuing (${err?.message || String(err)})`);
        }
    }
    catch (err) {
        (0, debug_1.debugLog)(`sessionStart: unexpected error — continuing (${err?.message || String(err)})`);
    }
    process.exit(0); // clean no-op pass-through — no stdout, nothing to block on
}
main().catch(() => process.exit(0));
