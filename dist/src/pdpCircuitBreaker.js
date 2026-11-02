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
exports.isCircuitOpen = isCircuitOpen;
exports.openCircuit = openCircuit;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const debug_1 = require("./debug");
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
function cacheDir(pluginDataDir) {
    return pluginDataDir ? path.join(pluginDataDir, 'pdp-circuit-breaker') : undefined;
}
function cacheFile(sessionId, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    if (!dir || !sessionId)
        return undefined;
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(dir, `${safe}.json`);
}
function isCircuitOpen(sessionId, pluginDataDir) {
    const file = cacheFile(sessionId, pluginDataDir);
    if (!file)
        return { open: false };
    try {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
            open: true,
            openedAt: state.openedAt,
            triggeredStatus: state.triggeredStatus,
            errorType: state.errorType,
        };
    }
    catch {
        return { open: false };
    }
}
function openCircuit(sessionId, triggeredStatus, errorType, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    const file = cacheFile(sessionId, pluginDataDir);
    if (!dir || !file)
        return;
    const state = { openedAt: Date.now(), triggeredStatus, errorType };
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state), 'utf8');
        sweepStale(dir);
    }
    catch (err) {
        (0, debug_1.debugLog)(`openCircuit: could not persist the latch for this session — every later call will re-hit the PDP (${err?.message || String(err)})`);
    }
}
function sweepStale(dir) {
    try {
        const cutoff = Date.now() - STALE_AFTER_MS;
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.json'))
                continue;
            const file = path.join(dir, name);
            try {
                if (fs.statSync(file).mtimeMs < cutoff)
                    fs.rmSync(file, { force: true });
            }
            catch {
                // another process got there first
            }
        }
    }
    catch {
        // directory unreadable — the latch above still landed
    }
}
