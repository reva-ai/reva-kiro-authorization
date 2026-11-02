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
exports.startTurnHops = startTurnHops;
exports.loadAgentHops = loadAgentHops;
exports.enqueuePendingSpawnLineage = enqueuePendingSpawnLineage;
exports.resolveSubAgentLineage = resolveSubAgentLineage;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const EMPTY_STATE = { agentHops: [], pendingSubAgentLineages: [], boundLineages: {} };
// No fallback: only ever writes inside REVA_DATA_DIR — a plugin-owned env
// var (see src/config.ts), not a host-provided one. Kiro has no confirmed
// durable, host-blessed per-plugin data directory, so rather than inventing
// a host-sanctioned-looking fallback location, this plugin defines and
// documents its own directory and requires the user to point REVA_DATA_DIR
// at it. Without it, there is nothing honest to write to, so load/save just
// no-op — turn/hop/spawn tracking degrades gracefully to "nothing persists
// across hook calls" rather than failing.
function cacheDir(pluginDataDir) {
    return pluginDataDir ? path.join(pluginDataDir, 'hops') : undefined;
}
function cacheFile(sessionId, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    if (!dir)
        return undefined;
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(dir, `${safe}.json`);
}
function loadState(sessionId, pluginDataDir) {
    const file = cacheFile(sessionId, pluginDataDir);
    if (!file)
        return EMPTY_STATE;
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return EMPTY_STATE;
    }
}
function saveState(sessionId, state, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    const file = cacheFile(sessionId, pluginDataDir);
    if (!dir || !file)
        return;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state), 'utf8');
    }
    catch {
        // best effort — subsequent requests just see an empty chain
    }
}
// Called once per turn, from PromptSubmit, right after the invokeAgent
// decision is evaluated. Resets the chain for this session: a new user
// turn starts its own fresh lineage rather than accumulating across the
// whole session, and any subagents from a previous turn no longer apply.
function startTurnHops(sessionId, invokeAgentHop, pluginDataDir) {
    saveState(sessionId, { agentHops: [invokeAgentHop], pendingSubAgentLineages: [], boundLineages: {} }, pluginDataDir);
}
// The lineage for the main session's own tool calls this turn.
function loadAgentHops(sessionId, pluginDataDir) {
    return loadState(sessionId, pluginDataDir).agentHops;
}
// Called from a spawn action's authorization: queues the lineage the new
// subagent should inherit (the spawner's own current lineage, plus this
// spawn) for the next unbound subagent id seen this session.
function enqueuePendingSpawnLineage(sessionId, parentLineage, spawnHop, pluginDataDir) {
    const state = loadState(sessionId, pluginDataDir);
    state.pendingSubAgentLineages.push([...parentLineage, spawnHop]);
    saveState(sessionId, state, pluginDataDir);
}
// Called for every subagent tool call. Returns the subagent's own bound
// lineage if already resolved; otherwise binds the oldest still-pending
// spawn lineage to this subagent id (first subagent tool call this session
// ⇒ first pending spawn, in order) and persists the binding for its later
// calls. Returns [] if there's nothing pending (shouldn't normally happen —
// a subagent's own calls always follow its spawn — but keeps this from
// crashing if it does).
function resolveSubAgentLineage(sessionId, subAgentId, pluginDataDir) {
    const state = loadState(sessionId, pluginDataDir);
    const existing = state.boundLineages[subAgentId];
    if (existing)
        return existing;
    const lineage = state.pendingSubAgentLineages.shift();
    if (!lineage)
        return [];
    state.boundLineages[subAgentId] = lineage;
    saveState(sessionId, state, pluginDataDir);
    return lineage;
}
