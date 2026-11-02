import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { debugLog } from './debug';
import {
  isMcpDiscoveryDue,
  isMcpInvokeIngestDue,
  isMcpServerKnown,
  recordMcpDiscoveryTriggered,
  recordMcpInvokeIngestTriggered,
} from './ingestionClient';
import { RevaConfig } from './types';

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

export function spawnMcpIngestion(cwd: string, invokedServer?: string): void {
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'ingestMcpServers.js')], {
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
    child.on('error', (err) => debugLog(`spawnMcpIngestion: spawn error — ${err?.message || String(err)}`));
    child.unref();
    debugLog(`spawnMcpIngestion: spawned MCP pass${invokedServer ? ` for invoked server "${invokedServer}"` : ''}`);
  } catch (err: any) {
    debugLog(`spawnMcpIngestion: failed to spawn ingestMcpServers — ${err?.message || String(err)}`);
  }
}

export function triggerMcpDiscoveryIfDue(
  cfg: RevaConfig,
  cwd: string,
  pluginDataDir?: string,
  isDue: (cfg: RevaConfig, pluginDataDir?: string) => boolean = isMcpDiscoveryDue,
  recordTriggered: (cfg: RevaConfig, pluginDataDir?: string) => void = recordMcpDiscoveryTriggered,
  spawnIngestion: (cwd: string, invokedServer?: string) => void = spawnMcpIngestion,
): void {
  if (!isDue(cfg, pluginDataDir)) return;
  recordTriggered(cfg, pluginDataDir);
  spawnIngestion(cwd);
}

// The known-name check runs first and is one cached file read, so an
// already-registered server costs PreToolUse nothing more than that.
export function triggerMcpIngestionForInvokedServer(
  cfg: RevaConfig,
  userEmail: string,
  serverName: string,
  cwd: string,
  pluginDataDir?: string,
  isKnown: (cfg: RevaConfig, userEmail: string, name: string, pluginDataDir?: string) => boolean = isMcpServerKnown,
  isDue: (cfg: RevaConfig, pluginDataDir?: string) => boolean = isMcpInvokeIngestDue,
  recordTriggered: (cfg: RevaConfig, pluginDataDir?: string) => void = recordMcpInvokeIngestTriggered,
  spawnIngestion: (cwd: string, invokedServer?: string) => void = spawnMcpIngestion,
): void {
  if (!serverName) return;
  if (isKnown(cfg, userEmail, serverName, pluginDataDir)) return;
  if (!isDue(cfg, pluginDataDir)) return;
  recordTriggered(cfg, pluginDataDir);
  spawnIngestion(cwd, serverName);
}
