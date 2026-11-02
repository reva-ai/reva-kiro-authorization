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
exports.truncatePrompt = truncatePrompt;
exports.startTurn = startTurn;
exports.loadTurn = loadTurn;
exports.loadOrStartTurn = loadOrStartTurn;
exports.directSessionFromTurn = directSessionFromTurn;
exports.conversationFromTurn = conversationFromTurn;
exports.resolveTurnTraceId = resolveTurnTraceId;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const trace_1 = require("./trace");
const MAX_PROMPT_LENGTH = 2000;
// No fallback: only ever writes inside REVA_DATA_DIR — a plugin-owned env
// var (see src/config.ts and hopChain.ts's comment on why this isn't a
// Kiro-provided path). Without it, there is nothing honest to write to.
function cacheDir(pluginDataDir) {
    return pluginDataDir ? path.join(pluginDataDir, 'turns') : undefined;
}
function cacheFile(sessionId, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    if (!dir)
        return undefined;
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(dir, `${safe}.json`);
}
function truncatePrompt(prompt) {
    return prompt.length > MAX_PROMPT_LENGTH ? `${prompt.slice(0, MAX_PROMPT_LENGTH)}…` : prompt;
}
// Call once per turn, from PromptSubmit. Mints a fresh trace id and
// persists it (overwriting any previous turn's entry for this session) so
// this turn's PreToolUse calls can read it back. Returns the full turn entry.
function saveTurn(sessionId, entry, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    const file = cacheFile(sessionId, pluginDataDir);
    if (!dir || !file)
        return;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
    }
    catch {
        // best effort — later hooks can reconstruct metadata from what they see
    }
}
function startTurn(sessionId, prompt, pluginDataDir) {
    const previous = loadTurn(sessionId, pluginDataDir);
    const observedAt = new Date().toISOString();
    const turn = (previous?.turn || 0) + 1;
    // A minted trace id only works if it can be PERSISTED — every later hook in
    // this turn is a separate process and reads it back from the cache. With no
    // pluginDataDir there is nowhere to write it, so minting would hand each
    // process a different random id and the turn would fragment into one trace
    // per PDP call. Derive deterministically in that case instead: every
    // process computes the same value from (session, turn) with no shared
    // state, which is the same guarantee the cache would have provided.
    const traceId = cacheFile(sessionId, pluginDataDir) ? (0, trace_1.mintTraceId)() : (0, trace_1.deriveTraceId)(sessionId, turn);
    const entry = {
        traceId,
        ...(prompt ? { prompt: truncatePrompt(prompt) } : {}),
        promptTimestamp: observedAt,
        turn,
        startedAt: previous?.startedAt || observedAt,
    };
    saveTurn(sessionId, entry, pluginDataDir);
    return entry;
}
function loadTurn(sessionId, pluginDataDir) {
    const file = cacheFile(sessionId, pluginDataDir);
    if (!file)
        return undefined;
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
// Pre/Post hooks normally follow PromptSubmit. If a host invokes them
// without that boundary, record the first event we genuinely observed rather
// than fabricating session metadata or sending an invalid direct-AI request.
function loadOrStartTurn(sessionId, pluginDataDir) {
    const existing = loadTurn(sessionId, pluginDataDir);
    if (existing?.turn && existing.startedAt && existing.promptTimestamp)
        return existing;
    return startTurn(sessionId, existing?.prompt, pluginDataDir);
}
function directSessionFromTurn(sessionId, turn) {
    return { id: sessionId, turn: turn.turn, startedAt: turn.startedAt };
}
function conversationFromTurn(turn) {
    if (!turn.prompt?.trim())
        return [];
    return [
        {
            seq: 1,
            role: 'user',
            contentType: 'text/plain',
            content: turn.prompt,
            timestamp: turn.promptTimestamp,
        },
    ];
}
// The trace id every hook in this turn must agree on. Normally read straight
// from the cache entry PromptSubmit wrote. The fallback covers an entry
// written before traceId existed, or a turn whose cache write failed: it is
// derived from (session, turn number), so separate hook processes still
// compute the SAME value for the same turn without needing the cache.
function resolveTurnTraceId(sessionId, turn) {
    return turn.traceId || (0, trace_1.deriveTraceId)(sessionId, turn.turn);
}
