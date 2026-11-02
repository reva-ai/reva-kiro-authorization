"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const debug_1 = require("./debug");
const identity_1 = require("./identity");
const ingestionClient_1 = require("./ingestionClient");
const kiroSettings_1 = require("./kiroSettings");
const mcpConfig_1 = require("./mcpConfig");
// Detached child spawned by mcpIngestionTrigger.ts for a mid-session MCP
// pass. Best-effort posture, like sessionStart.ts: nothing may throw out of
// main(), and it always exits 0 with no output.
//
// REVA_SESSION_CWD — the hook's cwd, for the workspace mcp.json files.
// REVA_INVOKED_MCP_SERVER — set when PreToolUse spawned this for a server
// whose tool was just called. It is merged into the list so a server that
// no mcp.json declares is still registered (by name only — there is no
// URL to give it an MCPServer entity, and none is invented).
async function main() {
    try {
        (0, kiroSettings_1.applyKiroCliEnv)();
        const cwd = process.env.REVA_SESSION_CWD?.trim() || process.cwd();
        (0, kiroSettings_1.applyKiroCliEnv)(process.env, { cwd });
        const pluginDataDir = (0, config_1.resolveDataDir)();
        const servers = (0, mcpConfig_1.readKiroMcpServers)(cwd);
        const invoked = process.env.REVA_INVOKED_MCP_SERVER?.trim();
        if (invoked && !servers.some((s) => s.name === invoked)) {
            (0, debug_1.debugLog)(`ingestMcpServers: including invoked server "${invoked}" not found in any mcp.json`);
            servers.push({ name: invoked });
        }
        const cfg = (0, config_1.loadConfig)();
        const userEmail = (0, identity_1.resolveUserEmail)();
        const { userEntityTypeId, mcpServerEntityTypeId } = await (0, ingestionClient_1.resolveEntityTypeIds)(cfg, pluginDataDir);
        await (0, ingestionClient_1.ingestMcpServers)(cfg, { userEntityTypeId, mcpServerEntityTypeId }, userEmail, servers, pluginDataDir).catch((err) => (0, debug_1.debugLog)(`ingestMcpServers: mid-session pass failed — ${err}`));
    }
    catch (err) {
        (0, debug_1.debugLog)(`ingestMcpServers: unexpected error — continuing (${err?.message || String(err)})`);
    }
    process.exit(0);
}
main().catch(() => process.exit(0));
