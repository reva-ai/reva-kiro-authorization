import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { MAX_RESOURCES_PER_CALL, mapToolCall, subAgentPrompts } from '../src/mapping';
import { extractShellTargets, shellDialectFor } from '../src/shellTargets';

// A throwaway repo with real files, because the scanner prefers "exists on
// disk" over guessing — the same signal it has in a real session.
function withRepo(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-shell-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'test'));
  for (const f of ['README.md', '.env', 'package.json', 'src/app.ts', 'src/util.ts', 'test/app.test.ts']) {
    fs.writeFileSync(path.join(root, f), '');
  }
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Targets as paths relative to the repo, `/`-separated, for readable asserts.
function rel(root: string, command: string, dialect: 'powershell' | 'posix'): string[] {
  return extractShellTargets(command, root, dialect).map((p) => path.relative(root, p).split(path.sep).join('/'));
}

test('the dialect follows the platform: PowerShell on Windows, POSIX elsewhere', () => {
  assert.equal(shellDialectFor('win32'), 'powershell');
  assert.equal(shellDialectFor('darwin'), 'posix');
  assert.equal(shellDialectFor('linux'), 'posix');
});

// --- PowerShell / cmd (Windows) ------------------------------------------------

test('PowerShell: every segment of a chained command is scanned, not just the first argument', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'Get-Content README.md; Get-Content .env', 'powershell'), ['README.md', '.env']);
    assert.deepEqual(rel(root, 'Get-Content src\\app.ts | Select-Object -First 5', 'powershell'), ['src/app.ts']);
  });
});

test('PowerShell: -Path / -LiteralPath / -Destination values are paths; switches and value params are not', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'Get-ChildItem -Path src -Recurse -Filter *.ts', 'powershell'), ['src']);
    assert.deepEqual(rel(root, 'Copy-Item -LiteralPath .env -Destination backup\\env.txt', 'powershell'), ['.env', 'backup/env.txt']);
    assert.deepEqual(rel(root, 'Get-Content -Path:README.md -Raw', 'powershell'), ['README.md']);
    // -Value is text to write, never a file, even when it looks like one.
    assert.deepEqual(rel(root, 'Set-Content -Path notes.txt -Value "see config.json"', 'powershell'), ['notes.txt']);
  });
});

test('PowerShell: comma-separated path lists become separate paths', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'Get-ChildItem src,test', 'powershell'), ['src', 'test']);
  });
});

test('PowerShell: a backslash is a path separator, not an escape', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'type src\\app.ts', 'powershell'), ['src/app.ts']);
  });
});

test('PowerShell: a quoted regex containing | does not split the command', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'Select-String -Pattern "a|b" -Path src\\app.ts', 'powershell'), ['src/app.ts']);
  });
});

test('PowerShell: redirection and Out-File targets are files the command writes', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'Get-ChildItem src > listing.txt', 'powershell'), ['listing.txt', 'src']);
    assert.deepEqual(rel(root, 'Get-Process | Out-File -FilePath procs.txt', 'powershell'), ['procs.txt']);
    // Discarded output is not a file.
    assert.deepEqual(rel(root, 'npm test 2>$null', 'powershell'), []);
    assert.deepEqual(rel(root, 'npm test > $null 2>&1', 'powershell'), []);
  });
});

test('PowerShell: variables, $env:, splats and cmd %VAR% are never resources', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'Get-Content $env:USERPROFILE\\secrets.txt', 'powershell'), []);
    assert.deepEqual(rel(root, 'Get-Content $file', 'powershell'), []);
    assert.deepEqual(rel(root, 'type %USERPROFILE%\\a.txt', 'powershell'), []);
    assert.deepEqual(rel(root, 'Get-ChildItem @params', 'powershell'), []);
  });
});

test('cmd-style commands and switches: dir /s /b src', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'dir /s /b src', 'powershell'), ['src']);
  });
});

test('nested shells are scanned in their own dialect: cmd /c, powershell -Command', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'cmd /c type .env', 'powershell'), ['.env']);
    assert.deepEqual(rel(root, 'powershell -Command "Get-Content .env"', 'powershell'), ['.env']);
  });
});

test('PowerShell: Set-Location changes where later relative paths resolve', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'Set-Location src; Get-Content app.ts', 'powershell'), ['src/app.ts']);
  });
});

// --- POSIX (macOS / Linux) -----------------------------------------------------

test('POSIX: && || ; | each start a new command', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'cat README.md && cat .env', 'posix'), ['README.md', '.env']);
    assert.deepEqual(rel(root, 'test -f .env || cat package.json; wc -l src/app.ts | sort', 'posix'), ['.env', 'package.json', 'src/app.ts']);
  });
});

test('POSIX: redirections >, >>, 2>, < name files', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'ls src > out.txt 2>> err.log', 'posix'), ['out.txt', 'err.log', 'src']);
    assert.deepEqual(rel(root, 'wc -l < README.md', 'posix'), ['README.md']);
    assert.deepEqual(rel(root, 'npm test 2>&1 > /dev/null', 'posix'), []);
  });
});

test('POSIX: quotes and backslash escapes keep a path with a space together', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'cat "my notes.txt"', 'posix'), []); // does not exist, contains a space: prose, not a path
    fs.writeFileSync(path.join(root, 'my notes.txt'), '');
    assert.deepEqual(rel(root, 'cat "my notes.txt"', 'posix'), ['my notes.txt']);
    assert.deepEqual(rel(root, 'cat my\\ notes.txt', 'posix'), ['my notes.txt']);
  });
});

test('POSIX: $VAR, $(…) and backticks are never resources', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'cat $HOME/.ssh/id_rsa', 'posix'), []);
    assert.deepEqual(rel(root, 'cat "$(pwd)/.env"', 'posix'), []);
    assert.deepEqual(rel(root, 'cat `which node`', 'posix'), []);
  });
});

test('POSIX: cd changes where later relative paths resolve', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'cd src && cat app.ts', 'posix'), ['src/app.ts']);
  });
});

test('POSIX: grep/sed pattern arguments are not paths; the files after them are', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'grep -rn "config.json" src', 'posix'), ['src']);
    assert.deepEqual(rel(root, "sed -i 's/a.b/c/' src/app.ts", 'posix'), ['src/app.ts']);
  });
});

test('POSIX: echo/printf text is not a path, but where it is written is', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'echo "see README.md" > notes.txt', 'posix'), ['notes.txt']);
  });
});

test('POSIX: env assignments and sudo prefixes are skipped to find the real command', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'NODE_ENV=test sudo cat .env', 'posix'), ['.env']);
  });
});

test('POSIX: bash -c "…" is scanned as a command of its own', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'bash -c "cat .env"', 'posix'), ['.env']);
  });
});

// --- both dialects -------------------------------------------------------------

test('wildcards are reduced to their literal directory, never kept in a resource id', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'cat src/*.ts', 'posix'), ['src']);
    assert.deepEqual(rel(root, 'Get-Content src\\*.ts', 'powershell'), ['src']);
  });
});

test('URLs and git remotes are not paths', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'curl https://example.com/a.json', 'posix'), []);
    assert.deepEqual(rel(root, 'git clone git@github.com:org/repo.git', 'posix'), []);
  });
});

test('a command with no path arguments yields nothing (the caller falls back to cwd)', () => {
  withRepo((root) => {
    assert.deepEqual(rel(root, 'npm test', 'posix'), []);
    assert.deepEqual(rel(root, 'git status', 'powershell'), []);
  });
});

// --- mapToolCall: the resources a hook actually evaluates ------------------------

test('mapToolCall: a chained shell command becomes one executeBash per path, all carrying the command', () => {
  withRepo((root) => {
    const name = path.basename(root);
    const result = mapToolCall('execute_cmd', { command: 'cat README.md; cat .env' }, root, 'posix');
    assert.deepEqual(
      result.mappings.map((m) => [m.actionName, m.resourceType, m.resourceId, m.command]),
      [
        ['executeBash', 'File', `${name}/README.md`, 'cat README.md; cat .env'],
        ['executeBash', 'File', `${name}/.env`, 'cat README.md; cat .env'],
      ],
    );
  });
});

test('mapToolCall: no path in the command -> the working directory, as before', () => {
  withRepo((root) => {
    const result = mapToolCall('execute_cmd', { command: 'npm test' }, root, 'posix');
    assert.equal(result.mappings.length, 1);
    assert.equal(result.mappings[0].resourceType, 'Directory');
    assert.equal(result.mappings[0].resourceId, path.basename(root));
  });
});

test('mapToolCall: more paths than the cap -> over-cap with nothing to evaluate', () => {
  withRepo((root) => {
    const files = Array.from({ length: MAX_RESOURCES_PER_CALL + 1 }, (_, i) => `f${i}.txt`).join(' ');
    const result = mapToolCall('execute_cmd', { command: `cat ${files}` }, root, 'posix');
    assert.equal(result.overCap, true);
    assert.deepEqual(result.mappings, []);
  });
});

test('mapToolCall: an MCP tool with path arguments is evaluated as the Tool AND each path', () => {
  withRepo((root) => {
    const name = path.basename(root);
    const read = mapToolCall('@filesystem/read_multiple_files', { paths: [path.join(root, 'README.md'), path.join(root, '.env')] }, root);
    assert.deepEqual(
      read.mappings.map((m) => [m.actionName, m.resourceType, m.resourceId]),
      [
        ['invokeTool', 'Tool', 'filesystem/read_multiple_files'],
        ['read', 'File', `${name}/README.md`],
        ['read', 'File', `${name}/.env`],
      ],
    );
    // A tool whose name says it writes is evaluated as `write` on its paths.
    const move = mapToolCall('@filesystem/move_file', { source: path.join(root, '.env'), destination: path.join(root, 'x.env') }, root);
    assert.deepEqual(move.mappings.slice(1).map((m) => m.actionName), ['write', 'write']);
  });
});

test('mapToolCall: an MCP tool without path arguments is just the Tool, unchanged', () => {
  withRepo((root) => {
    const result = mapToolCall('@deepwiki/ask_question', { repoName: 'facebook/react', question: 'what is it' }, root);
    assert.deepEqual(result.mappings.map((m) => m.resourceId), ['deepwiki/ask_question']);
  });
});

test('mapToolCall: the captured "list me files" call (a path-only tool input) is a read of that directory', () => {
  withRepo((root) => {
    // Captured from a real session: {"__tool_use_purpose":"List files in the current project directory","path":"C:\\…\\kiro"}
    const result = mapToolCall('@filesystem/list_directory', { __tool_use_purpose: 'List files', path: root }, root);
    assert.deepEqual(
      result.mappings.map((m) => [m.actionName, m.resourceType, m.resourceId]),
      [
        ['invokeTool', 'Tool', 'filesystem/list_directory'],
        ['read', 'Directory', path.basename(root)],
      ],
    );
  });
});

test('subcommands and script names are not paths, even when a folder of that name exists', () => {
  withRepo((root) => {
    // The repo has a `test/` folder; `npm test` still touches no path.
    assert.deepEqual(rel(root, 'npm test', 'posix'), []);
    assert.deepEqual(rel(root, 'npm run test', 'powershell'), []);
    // The paths AFTER a subcommand still count.
    assert.deepEqual(rel(root, 'git add src/app.ts README.md', 'posix'), ['src/app.ts', 'README.md']);
  });
});

// --- Kiro IDE tool names (current IDE build) ----------------------------------
//
// Captured from a real Kiro IDE session. Before these names
// were mapped, every IDE command became `invokeTool` on Tool:execute_pwsh
// with no context.command — a `Remove-Item -Recurse -Force` reached Reva
// with nothing a command policy could match.

test('IDE execute_pwsh is a shell command: executeBash with the real command and its path', () => {
  withRepo((root) => {
    const name = path.basename(root);
    // The captured payload, pointed at this throwaway repo.
    const input = { command: 'Remove-Item -Recurse -Force src', description: 'Delete the folder', cwd: null, run_in_background: false, timeout: null };
    const result = mapToolCall('execute_pwsh', input, root, 'powershell');
    assert.deepEqual(
      result.mappings.map((m) => [m.actionName, m.resourceType, m.resourceId, m.command]),
      [['executeBash', 'Directory', `${name}/src`, 'Remove-Item -Recurse -Force src']],
    );
  });
});

test('IDE background-process tools are shell commands too; stopping one (no command) falls back to cwd', () => {
  withRepo((root) => {
    for (const tool of ['control_pwsh_process', 'control_bash_process']) {
      const start = mapToolCall(tool, { action: 'start', command: 'node src/app.ts' }, root, 'powershell');
      assert.equal(start.mappings[0].actionName, 'executeBash', tool);
      assert.equal(start.mappings[0].command, 'node src/app.ts');
      const stop = mapToolCall(tool, { action: 'stop', processId: 7 }, root, 'powershell');
      assert.equal(stop.mappings[0].actionName, 'executeBash');
      assert.equal(stop.mappings[0].resourceType, 'Directory');
    }
  });
});

test('IDE delete_file is evaluated as `write` on the file it deletes', () => {
  withRepo((root) => {
    const name = path.basename(root);
    for (const input of [{ targetFile: 'src/app.ts' }, { path: 'src/app.ts' }, { target_file: 'src/app.ts' }]) {
      const m = mapToolCall('delete_file', input, root).mappings[0];
      assert.deepEqual([m.actionName, m.resourceType, m.resourceId], ['write', 'File', `${name}/src/app.ts`], JSON.stringify(input));
    }
  });
});

test('kiro-cli tool names map exactly as before (shell, fs_read, fs_write)', () => {
  withRepo((root) => {
    const name = path.basename(root);
    assert.deepEqual(
      mapToolCall('shell', { command: 'Remove-Item -Recurse -Force src' }, root, 'powershell').mappings.map((m) => [m.actionName, m.resourceId]),
      [['executeBash', `${name}/src`]],
    );
    assert.equal(mapToolCall('fs_write', { command: 'create', path: 'new.txt' }, root).mappings[0].actionName, 'write');
    assert.equal(mapToolCall('fs_read', { operations: [{ mode: 'Line', path: 'README.md' }] }, root).mappings[0].actionName, 'read');
  });
});

// --- sub-agents: one spawn per sub-agent ---------------------------------------
//
// kiro-cli 2.36.0's use_subagent spec: {command: "InvokeSubagents",
// content: {subagents: [{query, agent_name?, relevant_context?}]}} — ONE call
// starts several sub-agents in parallel.

test('use_subagent InvokeSubagents: one spawn per sub-agent, named or default', () => {
  withRepo((root) => {
    const input = {
      command: 'InvokeSubagents',
      content: {
        subagents: [
          { query: 'analyze src', agent_name: 'analyzer' },
          { query: 'analyze test' },
          { query: 'check deps', agent_name: 'auditor' },
          { query: 'summarize' },
        ],
      },
    };
    const result = mapToolCall('use_subagent', input, root);
    assert.deepEqual(
      result.mappings.map((m) => [m.actionName, m.resourceType, m.resourceId]),
      [
        ['spawn', 'SubAgent', 'analyzer'],
        ['spawn', 'SubAgent', 'default'],
        ['spawn', 'SubAgent', 'auditor'],
        ['spawn', 'SubAgent', 'default'],
      ],
    );
    assert.equal(result.overCap, undefined, 'sub-agent count is a policy question, not the path cap');
  });
});

test('use_subagent ListAgents starts nothing — it is not a spawn', () => {
  withRepo((root) => {
    const m = mapToolCall('use_subagent', { command: 'ListAgents' }, root).mappings;
    assert.deepEqual(m.map((x) => x.actionName), ['invokeTool']);
  });
});

test('single-agent shapes still give exactly one spawn (delegate, session spawn_session, top-level agent_name)', () => {
  withRepo((root) => {
    assert.deepEqual(mapToolCall('delegate', { task: 'x' }, root).mappings.map((m) => [m.actionName, m.resourceId]), [['spawn', 'subagent']]);
    assert.deepEqual(
      mapToolCall('session', { command: 'spawn_session', agent_name: 'helper' }, root).mappings.map((m) => [m.actionName, m.resourceId]),
      [['spawn', 'helper']],
    );
    assert.deepEqual(mapToolCall('use_subagent', { agent_name: 'solo' }, root).mappings.map((m) => m.resourceId), ['solo']);
  });
});

// --- the sub-agent tools Kiro actually used (captured from real sessions) ----

test('kiro-cli `subagent` with 4 stages is 4 spawns, named by stage', () => {
  withRepo((root) => {
    // The captured call's shape (prompt templates shortened).
    const input = {
      task: 'Analyze the D:\ directory.',
      mode: 'blocking',
      stages: [
        { name: 'subagent1-find-ts-files', role: 'kiro_default', prompt_template: 'Task: {task} 1' },
        { name: 'subagent2-syntax-errors', role: 'kiro_default', prompt_template: 'Task: {task} 2' },
        { name: 'subagent3-unused-imports', role: 'kiro_default', prompt_template: 'Task: {task} 3' },
        { name: 'subagent4-code-improvements', role: 'kiro_default', prompt_template: 'Task: {task} 4' },
      ],
    };
    assert.deepEqual(
      mapToolCall('subagent', input, root).mappings.map((m) => [m.actionName, m.resourceId]),
      [
        ['spawn', 'subagent1-find-ts-files'],
        ['spawn', 'subagent2-syntax-errors'],
        ['spawn', 'subagent3-unused-imports'],
        ['spawn', 'subagent4-code-improvements'],
      ],
    );
  });
});

test('Kiro IDE `invoke_sub_agent` is one spawn per call, named by `name`', () => {
  withRepo((root) => {
    const input = { name: 'context-gatherer', prompt: 'You are Subagent 1 of 4.', explanation: 'x', preset: null, contextFiles: [], specTask: null };
    assert.deepEqual(mapToolCall('invoke_sub_agent', input, root).mappings.map((m) => [m.actionName, m.resourceId]), [['spawn', 'context-gatherer']]);
  });
});

test('subAgentPrompts returns the text each new sub-agent is handed', () => {
  assert.deepEqual(subAgentPrompts('invoke_sub_agent', { name: 'x', prompt: 'You are Subagent 4 of 4.' }), ['You are Subagent 4 of 4.']);
  assert.deepEqual(subAgentPrompts('use_subagent', { command: 'InvokeSubagents', content: { subagents: [{ query: 'a' }, { query: 'b' }] } }), ['a', 'b']);
  assert.deepEqual(subAgentPrompts('shell', { command: 'ls' }), []);
});
