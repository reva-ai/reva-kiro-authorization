import { loadConfig, resolveDataDir } from './config';
import { debugLog } from './debug';
import { resolveUserEmail } from './identity';
import { ingestMcpServers, resolveEntityTypeIds } from './ingestionClient';
import { applyKiroCliEnv } from './kiroSettings';
import { readKiroMcpServers } from './mcpConfig';

// Detached child spawned by mcpIngestionTrigger.ts for a mid-session MCP
// pass. Best-effort posture, like sessionStart.ts: nothing may throw out of
// main(), and it always exits 0 with no output.
//
// REVA_SESSION_CWD — the hook's cwd, for the workspace mcp.json files.
// REVA_INVOKED_MCP_SERVER — set when PreToolUse spawned this for a server
// whose tool was just called. It is merged into the list so a server that
// no mcp.json declares is still registered (by name only — there is no
// URL to give it an MCPServer entity, and none is invented).
async function main(): Promise<void> {
  try {
    applyKiroCliEnv();
    const cwd = process.env.REVA_SESSION_CWD?.trim() || process.cwd();
    applyKiroCliEnv(process.env, { cwd });
    const pluginDataDir = resolveDataDir();

    const servers = readKiroMcpServers(cwd);
    const invoked = process.env.REVA_INVOKED_MCP_SERVER?.trim();
    if (invoked && !servers.some((s) => s.name === invoked)) {
      debugLog(`ingestMcpServers: including invoked server "${invoked}" not found in any mcp.json`);
      servers.push({ name: invoked });
    }

    const cfg = loadConfig();
    const userEmail = resolveUserEmail();
    const { userEntityTypeId, mcpServerEntityTypeId } = await resolveEntityTypeIds(cfg, pluginDataDir);
    await ingestMcpServers(cfg, { userEntityTypeId, mcpServerEntityTypeId }, userEmail, servers, pluginDataDir).catch(
      (err) => debugLog(`ingestMcpServers: mid-session pass failed — ${err}`),
    );
  } catch (err: any) {
    debugLog(`ingestMcpServers: unexpected error — continuing (${err?.message || String(err)})`);
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
