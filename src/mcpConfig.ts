import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveKiroHome } from './kiroSettings';

// Reads the MCP servers Kiro itself is configured with, so ingestion can
// register them with Reva before the first tool call reaches the PDP.
//
// Kiro keeps MCP servers in plain JSON, in these places (later wins on a
// name clash, matching Kiro's own workspace-over-global merge):
//
//   1. <cwd>/mcp.json                     a Kiro power's bundled servers
//   2. $KIRO_HOME/settings/mcp.json       global (what `kiro-cli mcp add
//                                         --scope global` writes)
//   3. <cwd>/.kiro/settings/mcp.json      workspace
//
// Shape confirmed on a real install (kiro-cli 2.33.0, written by
// `kiro-cli mcp add`):
//
//   { "mcpServers": {
//       "deepwiki":   { "url": "https://mcp.deepwiki.com/mcp" },
//       "filesystem": { "command": "npx", "args": [...], "env": {} } } }
//
// A remote server has a `url`; a local (stdio) one has `command` instead.
// The optional `type` discriminator from the Agent Plugins spec
// ("stdio" | "streamable-http" | "sse" | "http") is honored when present.
//
// Server names are kept VERBATIM, not slugified: kiro-cli namespaces MCP
// tools as "@<config key>/<tool>", and mapping.ts uses that key as the
// MCPServer parent id on every evaluation. Using the same raw key here is
// what lets an ingested MCPServer and an evaluated tool call refer to the
// same entity.
//
// Missing or malformed files are skipped silently — having no MCP servers
// is the common case, not an error.

export interface KiroMcpServer {
  name: string;
  // Only for remote servers. Never invented for a stdio server.
  url?: string;
}

const REMOTE_TYPES = new Set(['streamable-http', 'sse', 'http']);

export function mcpConfigPaths(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    path.join(cwd, 'mcp.json'),
    path.join(resolveKiroHome(env), 'settings', 'mcp.json'),
    path.join(cwd, '.kiro', 'settings', 'mcp.json'),
  ];
}

export function parseMcpJson(raw: string): KiroMcpServer[] {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const servers = data?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];

  const out: KiroMcpServer[] = [];
  for (const [name, entry] of Object.entries<any>(servers)) {
    if (!name || !entry || typeof entry !== 'object') continue;
    // Kiro does not load a disabled server, so it is not part of what this
    // agent can reach.
    if (entry.disabled === true) continue;
    const remote =
      typeof entry.url === 'string' && entry.url.trim() && (!entry.type || REMOTE_TYPES.has(entry.type));
    out.push(remote ? { name, url: entry.url.trim() } : { name });
  }
  return out;
}

export function readKiroMcpServers(cwd: string, env: NodeJS.ProcessEnv = process.env): KiroMcpServer[] {
  const byName = new Map<string, KiroMcpServer>();
  for (const file of mcpConfigPaths(cwd, env)) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const server of parseMcpJson(raw)) byName.set(server.name, server);
  }
  return [...byName.values()];
}
