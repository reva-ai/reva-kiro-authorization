import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseMcpJson, readKiroMcpServers } from '../src/mcpConfig';

function withTempDirs(fn: (home: string, cwd: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-mcpconfig-'));
  const home = path.join(root, 'kiro-home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(path.join(home, 'settings'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.kiro', 'settings'), { recursive: true });
  try {
    fn(home, cwd);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Exactly what `kiro-cli mcp add --scope global` wrote on kiro-cli 2.33.0.
const LIVE_GLOBAL_MCP_JSON = JSON.stringify({
  mcpServers: {
    deepwiki: { url: 'https://mcp.deepwiki.com/mcp' },
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\someone\\Downloads'],
      env: {},
    },
  },
});

test('parseMcpJson: remote servers keep their url, local servers get none', () => {
  assert.deepEqual(parseMcpJson(LIVE_GLOBAL_MCP_JSON), [
    { name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' },
    { name: 'filesystem' },
  ]);
});

test('parseMcpJson: names are kept verbatim — they must match the "@<name>/tool" key mapping.ts uses', () => {
  const parsed = parseMcpJson(JSON.stringify({ mcpServers: { My_Server: { url: 'https://x.test/mcp' } } }));
  assert.equal(parsed[0].name, 'My_Server');
});

test('parseMcpJson: honors the `type` discriminator and skips disabled servers', () => {
  const parsed = parseMcpJson(
    JSON.stringify({
      mcpServers: {
        sse: { type: 'sse', url: 'https://sse.test/mcp' },
        stdioWithUrl: { type: 'stdio', url: 'https://ignored.test', command: 'x' },
        off: { url: 'https://off.test/mcp', disabled: true },
      },
    }),
  );
  assert.deepEqual(parsed, [{ name: 'sse', url: 'https://sse.test/mcp' }, { name: 'stdioWithUrl' }]);
});

test('parseMcpJson: malformed or shapeless input yields nothing, never throws', () => {
  assert.deepEqual(parseMcpJson('{ not json'), []);
  assert.deepEqual(parseMcpJson('{}'), []);
  assert.deepEqual(parseMcpJson(JSON.stringify({ mcpServers: [] })), []);
});

test('readKiroMcpServers: reads the global settings/mcp.json under KIRO_HOME', () => {
  withTempDirs((home, cwd) => {
    fs.writeFileSync(path.join(home, 'settings', 'mcp.json'), LIVE_GLOBAL_MCP_JSON);
    const names = readKiroMcpServers(cwd, { KIRO_HOME: home }).map((s) => s.name);
    assert.deepEqual(names, ['deepwiki', 'filesystem']);
  });
});

test('readKiroMcpServers: workspace .kiro/settings/mcp.json is merged and wins on a name clash', () => {
  withTempDirs((home, cwd) => {
    fs.writeFileSync(path.join(home, 'settings', 'mcp.json'), LIVE_GLOBAL_MCP_JSON);
    fs.writeFileSync(
      path.join(cwd, '.kiro', 'settings', 'mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { url: 'https://workspace.test/mcp' }, git: { command: 'uvx' } } }),
    );
    const servers = readKiroMcpServers(cwd, { KIRO_HOME: home });
    assert.deepEqual(servers, [
      { name: 'deepwiki', url: 'https://workspace.test/mcp' },
      { name: 'filesystem' },
      { name: 'git' },
    ]);
  });
});

test('readKiroMcpServers: still reads a power-bundled <cwd>/mcp.json', () => {
  withTempDirs((home, cwd) => {
    fs.writeFileSync(path.join(cwd, 'mcp.json'), JSON.stringify({ mcpServers: { bundled: { url: 'https://b.test' } } }));
    assert.deepEqual(readKiroMcpServers(cwd, { KIRO_HOME: home }), [{ name: 'bundled', url: 'https://b.test' }]);
  });
});

test('readKiroMcpServers: no config files at all -> empty list', () => {
  withTempDirs((home, cwd) => {
    assert.deepEqual(readKiroMcpServers(cwd, { KIRO_HOME: home }), []);
  });
});
