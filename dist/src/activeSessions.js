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
exports.markSessionActive = markSessionActive;
exports.getActiveSessions = getActiveSessions;
exports.getActiveSessionCount = getActiveSessionCount;
exports.getSessionEntry = getSessionEntry;
exports.markSessionInactive = markSessionInactive;
// Manages tracking of active sessions on this machine.
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const pdpCircuitBreaker_1 = require("./pdpCircuitBreaker");
const ACTIVE_TTL_MS = 10 * 60 * 1000;
function cacheDir(pluginDataDir) {
    return pluginDataDir ? path.join(pluginDataDir, 'active-sessions') : undefined;
}
function cacheFile(agentId, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    if (!dir)
        return undefined;
    const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(dir, `${safe}.json`);
}
function loadState(agentId, pluginDataDir) {
    const file = cacheFile(agentId, pluginDataDir);
    if (!file)
        return { sessions: {} };
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        return { sessions: parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {} };
    }
    catch {
        return { sessions: {} };
    }
}
function saveState(agentId, state, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    const file = cacheFile(agentId, pluginDataDir);
    if (!dir || !file)
        return;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state), 'utf8');
    }
    catch {
        // best effort
    }
}
function pruneInactive(state, pluginDataDir) {
    const now = Date.now();
    const sessions = {};
    for (const [sessionId, entry] of Object.entries(state.sessions)) {
        if (now - entry.lastSeen < ACTIVE_TTL_MS && !(0, pdpCircuitBreaker_1.isCircuitOpen)(sessionId, pluginDataDir).open) {
            sessions[sessionId] = entry;
        }
    }
    return { sessions };
}
function markSessionActive(agentId, sessionId, entrypoint, pluginDataDir) {
    if (!sessionId || (0, pdpCircuitBreaker_1.isCircuitOpen)(sessionId, pluginDataDir).open)
        return undefined;
    const state = pruneInactive(loadState(agentId, pluginDataDir), pluginDataDir);
    const entry = { entrypoint, lastSeen: Date.now() };
    state.sessions[sessionId] = entry;
    saveState(agentId, state, pluginDataDir);
    return { sessionId, ...entry };
}
function getActiveSessions(agentId, pluginDataDir) {
    const state = pruneInactive(loadState(agentId, pluginDataDir), pluginDataDir);
    return Object.entries(state.sessions).map(([sessionId, entry]) => ({ sessionId, ...entry }));
}
function getActiveSessionCount(agentId, pluginDataDir) {
    return getActiveSessions(agentId, pluginDataDir).length;
}
function getSessionEntry(agentId, sessionId, pluginDataDir) {
    return getActiveSessions(agentId, pluginDataDir).find((s) => s.sessionId === sessionId);
}
// Explicit removal from Stop (sessionEnd.ts). TTL above stays as the fallback
// when Stop never fires (killed process, closed terminal).
function markSessionInactive(agentId, sessionId, pluginDataDir) {
    if (!sessionId)
        return;
    const state = pruneInactive(loadState(agentId, pluginDataDir), pluginDataDir);
    if (sessionId in state.sessions) {
        delete state.sessions[sessionId];
        saveState(agentId, state, pluginDataDir);
    }
}
