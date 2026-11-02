import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  cacheFile,
  isMcpDiscoveryDue,
  isMcpInvokeIngestDue,
  isMcpServerKnown,
  recordMcpDiscoveryTriggered,
  recordMcpInvokeIngestTriggered,
} from '../src/ingestionClient';
import { triggerMcpDiscoveryIfDue, triggerMcpIngestionForInvokedServer } from '../src/mcpIngestionTrigger';
import { RevaConfig } from '../src/types';

const cfg: RevaConfig = {
  pdpUrl: 'https://pdp.test/evaluate',
  authorization: 'eval-token',
  agentId: 'aa-bb-cc-dd-ee-ff',
  timeoutMs: 1000,
  ingestionUrl: 'https://pdp.test/ingestion/v2',
  modelContext: false,
  policyStoreId: '',
  policyStoreHeader: 'policyStoreId',
  ingestionTimeoutMs: 1000,
};

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reva-mcp-trigger-'));
}

function writeCache(dir: string, entry: object): void {
  const file = cacheFile(cfg, dir)!;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
}

test('isMcpDiscoveryDue: due on a cold cache, not due right after being recorded', () => {
  const dir = tmpDir();
  assert.equal(isMcpDiscoveryDue(cfg, dir), true);
  recordMcpDiscoveryTriggered(cfg, dir);
  assert.equal(isMcpDiscoveryDue(cfg, dir), false);
});

test('isMcpDiscoveryDue: due again once 15 minutes have passed', () => {
  const dir = tmpDir();
  writeCache(dir, { lastMcpDiscoveryTriggeredAt: Date.now() - 15 * 60 * 1000 - 1 });
  assert.equal(isMcpDiscoveryDue(cfg, dir), true);
});

test('isMcpInvokeIngestDue: independent of the discovery window, 1 minute throttle', () => {
  const dir = tmpDir();
  recordMcpDiscoveryTriggered(cfg, dir);
  assert.equal(isMcpInvokeIngestDue(cfg, dir), true);
  recordMcpInvokeIngestTriggered(cfg, dir);
  assert.equal(isMcpInvokeIngestDue(cfg, dir), false);
  writeCache(dir, { lastMcpInvokeIngestAt: Date.now() - 61 * 1000 });
  assert.equal(isMcpInvokeIngestDue(cfg, dir), true);
});

test('due checks report false without a data dir, so nothing spawns on every hook', () => {
  assert.equal(isMcpDiscoveryDue(cfg, undefined), false);
  assert.equal(isMcpInvokeIngestDue(cfg, undefined), false);
});

test('recording a trigger keeps the ingested-server list intact', () => {
  const dir = tmpDir();
  writeCache(dir, { ingestedMcpServers: { 'a@x.com': ['deepwiki'] } });
  recordMcpDiscoveryTriggered(cfg, dir);
  recordMcpInvokeIngestTriggered(cfg, dir);
  assert.equal(isMcpServerKnown(cfg, 'a@x.com', 'deepwiki', dir), true);
});

test('isMcpServerKnown: per user, and false for a name never registered', () => {
  const dir = tmpDir();
  writeCache(dir, { ingestedMcpServers: { 'a@x.com': ['deepwiki'] } });
  assert.equal(isMcpServerKnown(cfg, 'a@x.com', 'deepwiki', dir), true);
  assert.equal(isMcpServerKnown(cfg, 'b@x.com', 'deepwiki', dir), false);
  assert.equal(isMcpServerKnown(cfg, 'a@x.com', 'filesystem', dir), false);
});

test('triggerMcpDiscoveryIfDue: records before spawning when due', () => {
  const calls: string[] = [];
  triggerMcpDiscoveryIfDue(
    cfg,
    'C:\\work',
    'dir',
    () => true,
    () => calls.push('record'),
    (cwd, invoked) => calls.push(`spawn:${cwd}:${invoked ?? ''}`),
  );
  assert.deepEqual(calls, ['record', 'spawn:C:\\work:']);
});

test('triggerMcpDiscoveryIfDue: does nothing when not due', () => {
  const calls: string[] = [];
  triggerMcpDiscoveryIfDue(
    cfg,
    'C:\\work',
    'dir',
    () => false,
    () => calls.push('record'),
    () => calls.push('spawn'),
  );
  assert.deepEqual(calls, []);
});

test('triggerMcpIngestionForInvokedServer: spawns with the server name for an unknown server', () => {
  const calls: string[] = [];
  triggerMcpIngestionForInvokedServer(
    cfg,
    'a@x.com',
    'deepwiki',
    '/repo',
    'dir',
    () => false,
    () => true,
    () => calls.push('record'),
    (cwd, invoked) => calls.push(`spawn:${cwd}:${invoked}`),
  );
  assert.deepEqual(calls, ['record', 'spawn:/repo:deepwiki']);
});

test('triggerMcpIngestionForInvokedServer: skips a known server, a throttled call, and an empty name', () => {
  const calls: string[] = [];
  const record = () => calls.push('record');
  const spawn = () => calls.push('spawn');
  triggerMcpIngestionForInvokedServer(cfg, 'a@x.com', 'deepwiki', '/repo', 'dir', () => true, () => true, record, spawn);
  triggerMcpIngestionForInvokedServer(cfg, 'a@x.com', 'deepwiki', '/repo', 'dir', () => false, () => false, record, spawn);
  triggerMcpIngestionForInvokedServer(cfg, 'a@x.com', '', '/repo', 'dir', () => false, () => true, record, spawn);
  assert.deepEqual(calls, []);
});
