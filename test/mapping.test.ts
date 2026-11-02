import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  KIRO_BASH_TOOL_NAMES,
  KIRO_EDIT_TOOL_NAMES,
  KIRO_GLOB_TOOL_NAMES,
  KIRO_GREP_TOOL_NAMES,
  KIRO_READ_TOOL_NAMES,
  KIRO_SPAWN_TOOL_NAMES,
  KIRO_WRITE_TOOL_NAMES,
  MAX_RESOURCES_PER_CALL,
  mapToolCall,
  mapToolToCedar,
} from '../src/mapping';

// Two different things are tested in this file, deliberately kept apart:
//
//  1. The generic ALGORITHMS underneath the dispatch — portable-id
//     resolution, ancestor chains, tilde expansion, glob-vs-grep
//     classification. Those are exercised with the synthetic tool names
//     seeded below, which are not a claim about Kiro's vocabulary; they
//     just isolate the mechanism from the naming.
//  2. The real Kiro VOCABULARY and tool_input shapes — see the
//     "real Kiro tool names" tests at the bottom of this file, which use
//     only names and payloads actually captured from a running Kiro.
const TEST_BASH_TOOL = 'test-bash-tool';
const TEST_READ_TOOL = 'test-read-tool';
const TEST_WRITE_TOOL = 'test-write-tool';
const TEST_EDIT_TOOL = 'test-edit-tool';
const TEST_EDIT_TOOL_2 = 'test-edit-tool-2';
const TEST_GLOB_TOOL = 'test-glob-tool';
const TEST_GREP_TOOL = 'test-grep-tool';
const TEST_SPAWN_TOOL = 'test-spawn-tool';

KIRO_BASH_TOOL_NAMES.add(TEST_BASH_TOOL);
KIRO_READ_TOOL_NAMES.add(TEST_READ_TOOL);
KIRO_WRITE_TOOL_NAMES.add(TEST_WRITE_TOOL);
KIRO_EDIT_TOOL_NAMES.add(TEST_EDIT_TOOL).add(TEST_EDIT_TOOL_2);
KIRO_GLOB_TOOL_NAMES.add(TEST_GLOB_TOOL);
KIRO_GREP_TOOL_NAMES.add(TEST_GREP_TOOL);
KIRO_SPAWN_TOOL_NAMES.add(TEST_SPAWN_TOOL);

// A minimal fake git repo (just needs a `.git` entry to exist) so tests can
// exercise the repo-relative "portable id" path, not just the raw-absolute
// fallback the other tests hit when cwd isn't inside a real repo.
function withFakeRepo(repoName: string, fn: (repoRoot: string) => void): void {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-test-'));
  const repoRoot = path.join(tmpRoot, repoName);
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.git'));
  fs.writeFileSync(path.join(repoRoot, 'src', 'foo.ts'), '// fixture');
  try {
    fn(repoRoot);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// A real, non-repo working directory. Deliberately NOT a hardcoded
// POSIX-style string like "/repo" — on Windows, path.resolve('/repo', ...)
// treats "/repo" as drive-relative (resolving to "C:\repo\...", not a
// portable absolute path), which is a test-fixture bug, not a bug in
// mapping.ts's own (already OS-aware, via path.isAbsolute) fallback
// handling. Using a real directory means every assertion below can be
// built with path.join/path.resolve — the same APIs the production code
// itself uses — instead of a platform assumption baked into a string
// literal.
function withFakeCwd(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-cwd-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A real file with no extension, standing in for the original fixture's
// "/etc/hosts" — that path only exists on POSIX systems, so relying on it
// silently skipped exercising classifyPath()'s real fs.statSync branch on
// Windows (falling through to the "does it have a dot in the name"
// heuristic instead, which misclassifies it). Creating a real extensionless
// file exercises the same code path this is actually meant to test
// (a naive heuristic gets Makefile/Dockerfile/hosts-style files wrong; a
// real stat check doesn't) on every OS.
function withRealExtensionlessFile(fn: (absolutePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-file-'));
  const filePath = path.join(dir, 'hosts');
  fs.writeFileSync(filePath, '127.0.0.1 localhost');
  try {
    fn(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an unrecognized tool name always falls through to invokeTool — true even before any set is seeded', () => {
  withFakeCwd((cwd) => {
    const m = mapToolToCedar('SomeFutureTool', {}, cwd);
    assert.equal(m.actionName, 'invokeTool');
    assert.equal(m.resourceType, 'Tool');
    assert.equal(m.resourceId, 'SomeFutureTool');
    assert.ok(m.resourceProperties?.description);
  });
});

test('bash-mapped tool name maps to executeBash, falls back to cwd Directory with no clear target', () => {
  withFakeCwd((cwd) => {
    const m = mapToolToCedar(TEST_BASH_TOOL, { command: 'npm install' }, cwd);
    assert.equal(m.actionName, 'executeBash');
    assert.equal(m.resourceType, 'Directory');
    assert.equal(m.resourceId, cwd);
    assert.equal(m.command, 'npm install');
    // Directory.path is required by the schema
    assert.equal(m.resourceProperties?.path, cwd);
    // no repo context (a fresh temp dir isn't a real git repo) — no
    // ancestor chain to report for an absolute-path fallback
    assert.deepEqual(m.resourceParents, []);
  });
});

test('bash-mapped tool extracts a file-looking target when present, resolved to an absolute path', () => {
  withFakeCwd((cwd) => {
    const m = mapToolToCedar(TEST_BASH_TOOL, { command: 'cat src/index.ts' }, cwd);
    assert.equal(m.resourceType, 'File');
    // Folder/file-scoped policies need a consistent absolute id regardless
    // of which tool produced it — a relative bash arg must resolve against
    // cwd the same way path.resolve() would.
    assert.equal(m.resourceId, path.resolve(cwd, 'src', 'index.ts'));
    // File.name is required by the schema
    assert.equal(m.resourceProperties?.name, 'index.ts');
  });
});

test('bash-mapped tool with an already-absolute target leaves it unchanged', () => {
  withFakeCwd((cwd) => {
    withRealExtensionlessFile((hostsPath) => {
      const m = mapToolToCedar(TEST_BASH_TOOL, { command: `cat ${hostsPath}` }, cwd);
      // Real fs.statSync finds this file regardless of it having no
      // extension — the whole point of classifyPath() preferring a real
      // stat over a naive "has a dot in the name" heuristic.
      assert.equal(m.resourceType, 'File');
      assert.equal(m.resourceId, hostsPath);
    });
  });
});

test('bash-mapped tool target starting with "~" expands to the real home directory, not a literal "~" subfolder', () => {
  withFakeCwd((cwd) => {
    const m = mapToolToCedar(TEST_BASH_TOOL, { command: 'touch ~/Desktop/temp-file.txt' }, cwd);
    const expected = path.join(os.homedir(), 'Desktop', 'temp-file.txt');
    assert.equal(m.resourceId, expected);
    // must never look like it's nested inside the cwd
    assert.ok(!m.resourceId.startsWith(cwd));
    // outside any repo — no bogus Repository ancestor
    assert.deepEqual(m.resourceParents, []);
  });
});

test('inside a real repo, a bash-mapped "~" target does not get falsely attributed a Repository ancestor', () => {
  withFakeRepo('my-repo', (repoRoot) => {
    const m = mapToolToCedar(TEST_BASH_TOOL, { command: 'rm ~/Desktop/temp-file.txt' }, repoRoot);
    const expected = path.join(os.homedir(), 'Desktop', 'temp-file.txt');
    assert.equal(m.resourceId, expected);
    assert.ok(!m.resourceId.startsWith(repoRoot));
    assert.ok(!m.resourceId.includes('my-repo'));
    assert.deepEqual(m.resourceParents, []);
  });
});

test('edit-mapped tool maps to its own edit action, File resource, tool name in context data', () => {
  withFakeCwd((cwd) => {
    const filePath = path.join(cwd, 'src', 'config.ts');
    const m = mapToolToCedar(TEST_EDIT_TOOL, { file_path: filePath }, cwd);
    assert.equal(m.actionName, 'edit');
    assert.equal(m.resourceType, 'File');
    assert.equal(m.resourceId, filePath);
    assert.equal(m.tool, TEST_EDIT_TOOL);
    assert.equal(m.command, undefined);
    assert.equal(m.resourceProperties?.name, 'config.ts');
    assert.equal(m.resourceProperties?.extension, 'ts');
  });
});

test('every edit-set member folds into the same edit action', () => {
  withFakeCwd((cwd) => {
    const a = mapToolToCedar(TEST_EDIT_TOOL, { file_path: path.join(cwd, 'src', 'config.ts') }, cwd);
    assert.equal(a.actionName, 'edit');
    assert.equal(a.tool, TEST_EDIT_TOOL);

    const b = mapToolToCedar(TEST_EDIT_TOOL_2, { file_path: path.join(cwd, 'notebook.ipynb') }, cwd);
    assert.equal(b.actionName, 'edit');
    assert.equal(b.tool, TEST_EDIT_TOOL_2);
  });
});

test('write-mapped tool maps to its own write action', () => {
  withFakeCwd((cwd) => {
    const m = mapToolToCedar(TEST_WRITE_TOOL, { file_path: path.join(cwd, 'src', 'new.ts') }, cwd);
    assert.equal(m.actionName, 'write');
    assert.equal(m.resourceType, 'File');
    assert.equal(m.tool, TEST_WRITE_TOOL);
  });
});

test('read-mapped tool maps to its own read action, File resource', () => {
  withFakeCwd((cwd) => {
    const m = mapToolToCedar(TEST_READ_TOOL, { file_path: path.join(cwd, 'README.md') }, cwd);
    assert.equal(m.actionName, 'read');
    assert.equal(m.resourceType, 'File');
    assert.equal(m.tool, TEST_READ_TOOL);
  });
});

test('glob-mapped tool maps to its own glob action, always Directory (never File)', () => {
  withFakeCwd((cwd) => {
    const m = mapToolToCedar(TEST_GLOB_TOOL, { pattern: 'src/**/*.ts' }, cwd);
    assert.equal(m.actionName, 'glob');
    assert.equal(m.resourceType, 'Directory');
    assert.equal(m.resourceId, path.join(cwd, 'src'));
    assert.equal(m.pattern, 'src/**/*.ts');
    assert.equal(m.command, undefined);
  });
});

test('glob-mapped tool with a leading wildcard has no literal prefix, falls back to cwd', () => {
  withFakeCwd((cwd) => {
    const m = mapToolToCedar(TEST_GLOB_TOOL, { pattern: '**/*.md' }, cwd);
    assert.equal(m.resourceType, 'Directory');
    // No literal directory segment before the wildcard — the safe bound is cwd itself.
    assert.equal(m.resourceId, cwd);
  });
});

test('grep-mapped tool maps to its own grep action, Directory when path is a directory', () => {
  withFakeCwd((cwd) => {
    const m = mapToolToCedar(TEST_GREP_TOOL, { pattern: 'TODO', path: 'src' }, cwd);
    assert.equal(m.actionName, 'grep');
    assert.equal(m.resourceType, 'Directory');
    assert.equal(m.resourceId, path.join(cwd, 'src'));
    assert.equal(m.pattern, 'TODO');
  });
});

test('grep-mapped tool maps to File when path looks like a file (unlike glob, which is Directory-only)', () => {
  withFakeCwd((cwd) => {
    const m = mapToolToCedar(TEST_GREP_TOOL, { pattern: 'TODO', path: 'src/index.ts' }, cwd);
    assert.equal(m.actionName, 'grep');
    assert.equal(m.resourceType, 'File');
    assert.equal(m.resourceId, path.join(cwd, 'src', 'index.ts'));
  });
});

test('spawn-mapped tool maps to spawn/SubAgent', () => {
  withFakeCwd((cwd) => {
    const m = mapToolToCedar(TEST_SPAWN_TOOL, { subagent_type: 'Explore' }, cwd);
    assert.equal(m.actionName, 'spawn');
    assert.equal(m.resourceType, 'SubAgent');
    assert.equal(m.resourceId, 'Explore');
  });
});

test('MCP tool maps to invokeTool/Tool with an MCPServer parent — this dispatch is by naming convention, not a seeded set', () => {
  withFakeCwd((cwd) => {
    const m = mapToolToCedar('mcp__github__search_repositories', { query: 'anthropic' }, cwd);
    assert.equal(m.actionName, 'invokeTool');
    assert.equal(m.resourceType, 'Tool');
    assert.equal(m.resourceId, 'github/search_repositories');
    assert.deepEqual(m.resourceParents, [{ type: 'MCPServer', id: 'github' }]);
    // name/description are required on Tool
    assert.equal(m.resourceProperties?.name, 'search_repositories');
    assert.ok(m.resourceProperties?.description);
  });
});

test('unknown/future tool falls back to invokeTool, never silently skipped', () => {
  withFakeCwd((cwd) => {
    const m = mapToolToCedar('SomeFutureTool', {}, cwd);
    assert.equal(m.actionName, 'invokeTool');
    assert.equal(m.resourceId, 'SomeFutureTool');
  });
});

test('inside a real repo, an edit-mapped tool resolves to a portable "repoName/relative/path" id, not an absolute one', () => {
  withFakeRepo('my-repo', (repoRoot) => {
    const filePath = path.join(repoRoot, 'src', 'foo.ts');
    const m = mapToolToCedar(TEST_EDIT_TOOL, { file_path: filePath }, repoRoot);
    assert.equal(m.resourceId, 'my-repo/src/foo.ts');
    // absolute machine path must not leak into properties either
    assert.equal(m.resourceProperties?.name, 'foo.ts');
    // ancestor chain: immediate parent dir, repo-root dir, then the Repository itself
    assert.deepEqual(m.resourceParents, [
      { type: 'Directory', id: 'my-repo/src' },
      { type: 'Directory', id: 'my-repo' },
      { type: 'Repository', id: 'my-repo' },
    ]);
  });
});

test('a deeply nested file gets the COMPLETE ancestor chain, every level, no skipping', () => {
  withFakeRepo('my-repo', (repoRoot) => {
    const deepDir = path.join(repoRoot, 'src', 'main', 'java', 'com', 'foo');
    fs.mkdirSync(deepDir, { recursive: true });
    const filePath = path.join(deepDir, 'Bar.java');
    fs.writeFileSync(filePath, '// fixture');
    const m = mapToolToCedar(TEST_READ_TOOL, { file_path: filePath }, repoRoot);
    assert.equal(m.resourceId, 'my-repo/src/main/java/com/foo/Bar.java');
    assert.deepEqual(m.resourceParents, [
      { type: 'Directory', id: 'my-repo/src/main/java/com/foo' },
      { type: 'Directory', id: 'my-repo/src/main/java/com' },
      { type: 'Directory', id: 'my-repo/src/main/java' },
      { type: 'Directory', id: 'my-repo/src/main' },
      { type: 'Directory', id: 'my-repo/src' },
      { type: 'Directory', id: 'my-repo' },
      { type: 'Repository', id: 'my-repo' },
    ]);
  });
});

test('inside a real repo, a relative bash-mapped target resolves to the same portable id', () => {
  withFakeRepo('my-repo', (repoRoot) => {
    const m = mapToolToCedar(TEST_BASH_TOOL, { command: 'cat src/foo.ts' }, repoRoot);
    assert.equal(m.resourceId, 'my-repo/src/foo.ts');
  });
});

test('inside a real repo, a bash-mapped tool with no clear target resolves to just the repo name, no self-referential parent', () => {
  withFakeRepo('my-repo', (repoRoot) => {
    const m = mapToolToCedar(TEST_BASH_TOOL, { command: 'npm install' }, repoRoot);
    assert.equal(m.resourceType, 'Directory');
    assert.equal(m.resourceId, 'my-repo');
    // only the Repository — must NOT list "Directory: my-repo" as
    // its own parent
    assert.deepEqual(m.resourceParents, [{ type: 'Repository', id: 'my-repo' }]);
  });
});

test('inside a real repo, a path outside the repo falls back to the absolute path with no ancestor chain', () => {
  withFakeRepo('my-repo', (repoRoot) => {
    withRealExtensionlessFile((hostsPath) => {
      const m = mapToolToCedar(TEST_BASH_TOOL, { command: `cat ${hostsPath}` }, repoRoot);
      assert.equal(m.resourceId, hostsPath);
      assert.deepEqual(m.resourceParents, []);
    });
  });
});

// ---------------------------------------------------------------------------
// Real Kiro vocabulary and tool_input shapes.
//
// Every tool name and payload below was captured from a running Kiro
// (kiro-cli 2.21.2 sessions; IDE names from the tool tables in the installed
// kiro.kiro-agent extension) or read out of the tool specs embedded in the
// shipped kiro-cli binary. Nothing here is inferred from documentation — the
// docs got both the trigger names and the blocking contract wrong, and the
// UI displays different tool names than the wire carries ("using tool:
// read" on screen, `fs_read` in the payload).
//
// These are the tests that should fail first if Kiro renames a tool or
// reshapes an input, which is exactly what makes them worth having: a name
// that stops matching silently downgrades that tool to a generic
// `invokeTool`, and no other test would notice.
// ---------------------------------------------------------------------------

// The existing withFakeRepo takes the repo name first; these tests all want
// the same throwaway repo, so wrap it once and hand both values back.
const DEMO_REPO = 'demo-repo';
function withRepo(fn: (repoRoot: string, repoName: string) => void): void {
  withFakeRepo(DEMO_REPO, (repoRoot) => fn(repoRoot, DEMO_REPO));
}

test('real kiro-cli shell tool maps to executeBash with the real command string', () => {
  withRepo((repoRoot, repoName) => {
    // Captured: {"tool_name":"execute_cmd","tool_input":{"command":"echo hi","summary":"..."}}
    const m = mapToolToCedar('execute_cmd', { command: 'echo hi', summary: 'Echo hi' }, repoRoot);
    assert.equal(m.actionName, 'executeBash');
    assert.equal(m.command, 'echo hi');
    assert.equal(m.resourceId, repoName);
  });
});

test('every confirmed shell-tool alias reaches executeBash, not the generic fallback', () => {
  for (const name of ['execute_bash', 'execute_cmd', 'executeBash', 'shell', 'runCommand']) {
    const m = mapToolToCedar(name, { command: 'ls' }, process.cwd());
    assert.equal(m.actionName, 'executeBash', `${name} should map to executeBash`);
  }
});

test('real fs_read operations[] batch resolves the path out of the array', () => {
  withRepo((repoRoot, repoName) => {
    const file = path.join(repoRoot, 'package.json');
    fs.writeFileSync(file, '{}');
    // Captured shape — NOT a flat {file_path}. The old
    // file_path||path chain read nothing out of this and fell back to cwd.
    const m = mapToolToCedar('fs_read', { operations: [{ mode: 'Line', path: file }] }, repoRoot);
    assert.equal(m.actionName, 'read');
    assert.equal(m.resourceType, 'File');
    assert.equal(m.resourceId, `${repoName}/package.json`);
  });
});

test('a Directory-mode fs_read reports a Directory resource', () => {
  withRepo((repoRoot, repoName) => {
    const dir = path.join(repoRoot, 'src');
    fs.mkdirSync(dir, { recursive: true });
    const m = mapToolToCedar('fs_read', { operations: [{ mode: 'Directory', path: dir }] }, repoRoot);
    assert.equal(m.actionName, 'read');
    assert.equal(m.resourceType, 'Directory');
    assert.equal(m.resourceId, `${repoName}/src`);
  });
});

test('a multi-operation fs_read becomes one read per file — never collapsed to a common ancestor', () => {
  withRepo((repoRoot, repoName) => {
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '');
    fs.writeFileSync(path.join(repoRoot, '.env'), '');
    const result = mapToolCall(
      'fs_read',
      {
        operations: [
          { mode: 'Line', path: path.join(repoRoot, 'README.md') },
          { mode: 'Line', path: path.join(repoRoot, '.env') },
        ],
      },
      repoRoot,
    );
    // The old common-ancestor collapse evaluated this as a read of the repo
    // root, which a `forbid read on File "<repo>/.env"` never matched.
    assert.deepEqual(
      result.mappings.map((m) => [m.actionName, m.resourceType, m.resourceId]),
      [
        ['read', 'File', `${repoName}/README.md`],
        ['read', 'File', `${repoName}/.env`],
      ],
    );
  });
});

test('a read batch above the per-call cap is marked over-cap, not widened', () => {
  withRepo((repoRoot) => {
    const operations = Array.from({ length: MAX_RESOURCES_PER_CALL + 1 }, (_, i) => ({ mode: 'Line', path: `f${i}.txt` }));
    const result = mapToolCall('fs_read', { operations }, repoRoot);
    assert.equal(result.overCap, true);
    assert.deepEqual(result.mappings, []);
    assert.equal(result.candidateCount, MAX_RESOURCES_PER_CALL + 1);
  });
});

test('fs_write create maps to `write`, and its mutating commands map to `edit`', () => {
  withRepo((repoRoot, repoName) => {
    const target = path.join(repoRoot, 'notes.txt');
    // Captured: {"command":"create","path":"...","file_text":"hello"}
    const created = mapToolToCedar('fs_write', { command: 'create', path: target, file_text: 'hello' }, repoRoot);
    assert.equal(created.actionName, 'write');
    assert.equal(created.resourceId, `${repoName}/notes.txt`);

    // Captured: {"command":"append","path":"...","new_str":"world"}
    for (const sub of ['append', 'str_replace', 'insert']) {
      const edited = mapToolToCedar('fs_write', { command: sub, path: target, new_str: 'world' }, repoRoot);
      assert.equal(edited.actionName, 'edit', `fs_write command="${sub}" should be an edit`);
      assert.equal(edited.resourceId, `${repoName}/notes.txt`);
    }
  });
});

test('fs_write’s inner `command` is never mistaken for a shell command', () => {
  withRepo((repoRoot, _repoName) => {
    // fs_write carries command:"create" and executeBash carries
    // command:"<shell string>" — same field name, unrelated meanings. A
    // write must not be reported as executeBash with "create" as the
    // command, which is what a naive shared lookup would produce.
    const m = mapToolToCedar('fs_write', { command: 'create', path: path.join(repoRoot, 'x.txt') }, repoRoot);
    assert.notEqual(m.actionName, 'executeBash');
    assert.equal(m.command, undefined);
  });
});

test('real glob input carries only a pattern — the directory comes from the pattern', () => {
  withRepo((repoRoot, repoName) => {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    // Captured: {"pattern":"src/**/*.ts"} — no path field at all.
    const m = mapToolToCedar('glob', { pattern: 'src/**/*.ts' }, repoRoot);
    assert.equal(m.actionName, 'glob');
    assert.equal(m.resourceType, 'Directory');
    assert.equal(m.pattern, 'src/**/*.ts');
    // No wildcard may survive into a policy-matchable id.
    assert.equal(m.resourceId.includes('*'), false);
    assert.equal(m.resourceId, `${repoName}/src`);
  });
});

test('real grep input carries pattern + path', () => {
  withRepo((repoRoot, repoName) => {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    // Captured: {"pattern":"REVA_AUTH_TOKEN","path":"src"}
    const m = mapToolToCedar('grep', { pattern: 'REVA_AUTH_TOKEN', path: 'src' }, repoRoot);
    assert.equal(m.actionName, 'grep');
    assert.equal(m.pattern, 'REVA_AUTH_TOKEN');
    assert.equal(m.resourceId, `${repoName}/src`);
  });
});

test('kiro-cli delegation tools map to spawn', () => {
  for (const name of ['use_subagent', 'delegate']) {
    const m = mapToolToCedar(name, { agent_name: 'researcher' }, process.cwd());
    assert.equal(m.actionName, 'spawn', `${name} should map to spawn`);
    assert.equal(m.resourceType, 'SubAgent');
    assert.equal(m.resourceId, 'researcher');
  }
});

test('the multiplexed `session` tool is a spawn ONLY for spawn_session', () => {
  const spawned = mapToolToCedar('session', { command: 'spawn_session', agent_name: 'worker' }, process.cwd());
  assert.equal(spawned.actionName, 'spawn');
  assert.equal(spawned.resourceId, 'worker');

  // Counting "list the sessions" as a spawn would burn a per-turn fan-out
  // budget on a read-only call.
  for (const sub of ['list_sessions', 'get_session_status', 'interrupt']) {
    const m = mapToolToCedar('session', { command: sub }, process.cwd());
    assert.equal(m.actionName, 'invokeTool', `session/${sub} is not a spawn`);
  }
});

test('Kiro-namespaced MCP tools get an MCPServer parent', () => {
  // Kiro's own hooks docs give "@postgres/query" as the tool_name shape.
  // The "mcp__server__tool" form is a different convention entirely —
  // matching only that one left every real Kiro MCP call as a bare Tool.
  const m = mapToolToCedar('@postgres/query', { sql: 'SELECT 1' }, process.cwd());
  assert.equal(m.actionName, 'invokeTool');
  assert.equal(m.resourceId, 'postgres/query');
  assert.deepEqual(m.resourceParents, [{ type: 'MCPServer', id: 'postgres' }]);
  assert.equal(m.resourceProperties?.connectionType, 'mcp');
});

test('Kiro’s non-filesystem tools fall through to invokeTool rather than being dropped', () => {
  // These are real kiro-cli tools with no Cedar action of their own. The
  // requirement is that they are still evaluated, just coarsely.
  for (const name of ['use_aws', 'web_fetch', 'web_search', 'knowledge', 'todo_list', 'introspect']) {
    const m = mapToolToCedar(name, {}, process.cwd());
    assert.equal(m.actionName, 'invokeTool', `${name} should still be evaluated`);
    assert.equal(m.resourceType, 'Tool');
    assert.equal(m.resourceId, name);
  }
});

test('an unknown future tool is still evaluated, never skipped', () => {
  const m = mapToolToCedar('some_tool_added_next_year', { anything: true }, process.cwd());
  assert.equal(m.actionName, 'invokeTool');
  assert.equal(m.resourceId, 'some_tool_added_next_year');
});
