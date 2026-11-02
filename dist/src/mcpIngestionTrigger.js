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
exports.spawnMcpIngestion = spawnMcpIngestion;
exports.triggerMcpDiscoveryIfDue = triggerMcpDiscoveryIfDue;
exports.triggerMcpIngestionForInvokedServer = triggerMcpIngestionForInvokedServer;
const node_child_process_1 = require("node:child_process");
const path = __importStar(require("node:path"));
const debug_1 = require("./debug");
const ingestionClient_1 = require("./ingestionClient");
// Picks up MCP servers mid-session, in two ways. Before this, Kiro
// registered servers only in the once-per-session pass (sessionStart.ts), so a server added
// with `kiro-cli mcp add` mid-session stayed out of "Linked MCP Servers"
// until the next session.
//
//   1. triggerMcpDiscoveryIfDue — from the prompt hook, every turn, but
//      throttled to once per 15 minutes: re-reads Kiro's mcp.json files.
//   2. triggerMcpIngestionForInvokedServer — from PreToolUse, when a tool of
//      a server not yet registered for this User is actually called. The
//      server name is handed to the child, so it is registered even if no
//      mcp.json mentions it.
//
// Both only spawn ingestMcpServers.js as a detached, unref'd child and
// never wait on it: these are called from ENFORCEMENT entrypoints, and the
// best-effort ingestion posture must not reach into them. "Triggered" is
// recorded before spawning, so a burst of hooks inside the window cannot
// each start an overlapping pass.
function spawnMcpIngestion(cwd, invokedServer) {
    try {
        const child = (0, node_child_process_1.spawn)(process.execPath, [path.join(__dirname, 'ingestMcpServers.js')], {
            detached: true,
            // stdout must not be shared: it is Kiro's decision channel for the
            // hook that spawned this.
            stdio: 'ignore',
            env: {
                ...process.env,
                REVA_SESSION_CWD: cwd,
                ...(invokedServer ? { REVA_INVOKED_MCP_SERVER: invokedServer } : {}),
            },
            windowsHide: true,
        });
        child.on('error', (err) => (0, debug_1.debugLog)(`spawnMcpIngestion: spawn error — ${err?.message || String(err)}`));
        child.unref();
        (0, debug_1.debugLog)(`spawnMcpIngestion: spawned MCP pass${invokedServer ? ` for invoked server "${invokedServer}"` : ''}`);
    }
    catch (err) {
        (0, debug_1.debugLog)(`spawnMcpIngestion: failed to spawn ingestMcpServers — ${err?.message || String(err)}`);
    }
}
function triggerMcpDiscoveryIfDue(cfg, cwd, pluginDataDir, isDue = ingestionClient_1.isMcpDiscoveryDue, recordTriggered = ingestionClient_1.recordMcpDiscoveryTriggered, spawnIngestion = spawnMcpIngestion) {
    if (!isDue(cfg, pluginDataDir))
        return;
    recordTriggered(cfg, pluginDataDir);
    spawnIngestion(cwd);
}
// The known-name check runs first and is one cached file read, so an
// already-registered server costs PreToolUse nothing more than that.
function triggerMcpIngestionForInvokedServer(cfg, userEmail, serverName, cwd, pluginDataDir, isKnown = ingestionClient_1.isMcpServerKnown, isDue = ingestionClient_1.isMcpInvokeIngestDue, recordTriggered = ingestionClient_1.recordMcpInvokeIngestTriggered, spawnIngestion = spawnMcpIngestion) {
    if (!serverName)
        return;
    if (isKnown(cfg, userEmail, serverName, pluginDataDir))
        return;
    if (!isDue(cfg, pluginDataDir))
        return;
    recordTriggered(cfg, pluginDataDir);
    spawnIngestion(cwd, serverName);
}
