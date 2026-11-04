import * as fs from 'node:fs';
import * as path from 'node:path';
import { readKiroMcpServers } from './mcpConfig';
import { extractShellTargets, hasWildcard, literalDirOf, resolveAgainst, shellDialectFor, ShellDialect } from './shellTargets';
import { CedarActionMapping, CedarEntityRef, ToolMapping } from './types';

// ---------------------------------------------------------------------------
// Kiro's native tool vocabulary → Cedar actions.
//
// The rule: capture real native tool names from an actual raw payload,
// never trust the name a docs page implies. That mattered twice here. Kiro's two hosts do NOT share
// a tool vocabulary, and neither matches what the UI displays: a kiro-cli
// session that shows "using tool: read" and lists `read`/`shell` in its
// agent config sends `tool_name: "fs_read"` / `"execute_cmd"` on the wire.
//
// Sources, in descending order of confidence:
//   (a) CAPTURED from real kiro-cli sessions:
//       fs_read, fs_write, execute_cmd, glob, grep.
//   (b) The tool SPECS embedded in the shipped kiro-cli binary: glob, grep,
//       execute_bash, fs_read, fs_write, use_aws, report_issue, thinking,
//       knowledge, todo_list, delegate, web_search, web_fetch, use_subagent,
//       session, introspect.
//   (c) The IDE extension's own tool-categorization tables in the shipped
//       kiro.kiro-agent/dist/extension.js (fsWrite, grepSearch, fileSearch,
//       listDirectory, strReplace, readFile/readFiles/readCode, ...).
//
// Anything not matched here still falls through to the generic `invokeTool`
// action against a generic `Tool` resource — every call stays gated, just
// with a coarser action name (an unrecognized tool call is never silently
// dropped). Adding a name here sharpens governance; omitting
// one never disables it.
//
// Both hosts namespace MCP tools separately (kiro-cli sends "@server/tool"),
// so the bare generic names below cannot collide with an MCP tool's name.
//
// Exported so test/mapping.test.ts can exercise dispatch, and so a
// deployment can extend a set at runtime for a tool this build predates.
// ---------------------------------------------------------------------------

export const KIRO_BASH_TOOL_NAMES = new Set<string>([
  // kiro-cli: execute_cmd is what Windows sessions actually send (captured);
  // execute_bash is the name in the embedded spec.
  'execute_bash', 'execute_cmd', 'executeBash', 'executeCmd', 'shell',
  // IDE
  'runCommand', 'run_command', 'controlProcess', 'control_process',
  // IDE, current build (confirmed in a real IDE session and in the IDE's own
  // tool list): Windows commands arrive as `execute_pwsh`
  // ({"command":"Remove-Item -Recurse -Force D:\\intent", …}); background
  // processes as control_pwsh_process / control_bash_process. Missing from
  // this set, they fell through to the generic `invokeTool` with no
  // `context.command` — so a destructive command reached Reva as "invoke
  // tool execute_pwsh" and no command policy could see it.
  'execute_pwsh', 'executePwsh',
  'control_pwsh_process', 'controlPwshProcess', 'control_bash_process', 'controlBashProcess',
]);

// Deleting a file (IDE `delete_file`). Cedar's CodingAgent schema has no
// delete action, so a delete is evaluated as `write` on the file it removes:
// a policy that protects a file from being written also protects it from
// being deleted.
export const KIRO_DELETE_TOOL_NAMES = new Set<string>([
  'delete_file', 'deleteFile',
]);

export const KIRO_READ_TOOL_NAMES = new Set<string>([
  // kiro-cli (fs_read captured from a real session)
  'fs_read', 'fsRead', 'read',
  // IDE
  'readFile', 'read_file', 'readFiles', 'read_files', 'readCode', 'read_code',
  'openFolders', 'open_folders', 'listDirectory', 'list_directory',
]);

// Creating or wholesale-overwriting a file. Note that kiro-cli routes BOTH
// creation and mutation through one `fs_write` tool and distinguishes them
// with an inner `command` field — mapToolToCedar splits those back apart
// into the `write` and `edit` actions (see writeActionFor below), so
// fs_write appearing in this set does not mean every fs_write is a `write`.
export const KIRO_WRITE_TOOL_NAMES = new Set<string>([
  'fs_write', 'fsWrite', 'write', 'create',
]);

// Mutating an existing file. Every edit-style tool shares the one `edit`
// action.
export const KIRO_EDIT_TOOL_NAMES = new Set<string>([
  'str_replace', 'strReplace', 'fs_append', 'fs_replace',
  'append', 'insert', 'replace', 'editCode', 'edit_code',
]);

export const KIRO_GLOB_TOOL_NAMES = new Set<string>([
  'glob', 'fileSearch', 'file_search',
]);

export const KIRO_GREP_TOOL_NAMES = new Set<string>([
  'grep', 'grepSearch', 'grep_search', 'search', 'codebaseSearch', 'codebase_search',
]);

// kiro-cli's real delegation tools. `session` is handled separately because
// it is multiplexed — only its spawn_session command is a spawn (see
// mapToolToCedar).
export const KIRO_SPAWN_TOOL_NAMES = new Set<string>([
  'use_subagent', 'useSubagent', 'delegate', 'agentCrew', 'crew',
  // Captured from a real session given a "use exactly 4 subagents" prompt:
  //   kiro-cli 2.36.0 -> `subagent`, ONE call: {task, mode, stages: [{name, role, prompt_template}, …]}
  //   Kiro IDE        -> `invoke_sub_agent`, one call PER sub-agent: {name, prompt, explanation, …}
  // Neither was mapped, so all eight sub-agents reached Reva as `invokeTool`
  // and no subagentIndex was ever sent.
  'subagent', 'invoke_sub_agent', 'invokeSubAgent',
]);

// fs_write's inner command enum, from the embedded tool spec:
// create | str_replace | insert | append. Only `create` brings a file into
// existence or replaces it wholesale; the rest mutate an existing one. Two
// different Cedar actions, so a policy can allow edits while denying
// creation (or vice versa) — which collapsing them into one action would
// make impossible to express.
const FS_WRITE_CREATE_COMMANDS = new Set<string>(['create']);

function writeActionFor(toolInput: Record<string, any>, toolName: string): 'write' | 'edit' {
  const sub = typeof toolInput.command === 'string' ? toolInput.command : '';
  if (sub) return FS_WRITE_CREATE_COMMANDS.has(sub) ? 'write' : 'edit';
  // No inner command (an IDE-style tool whose name already says which it
  // is): fall back to whichever set the name itself is in.
  return KIRO_EDIT_TOOL_NAMES.has(toolName) ? 'edit' : 'write';
}

// More distinct resources than this in ONE tool call and the call is denied
// outright rather than partially evaluated or widened. THIS HAS POLICY
// SIGNIFICANCE, not just performance: widening an over-wide call to a common
// ancestor directory would break the Cedar `in` relationship path-scoped
// policies rely on, so an over-wide command could come back allowed against
// a policy that should have denied it.
export const MAX_RESOURCES_PER_CALL = 10;

// kiro-cli's fs_read takes a BATCH: tool_input is
// {operations: [{mode: "Line"|"Directory"|"Image", path, image_paths}]}.
// Every path becomes its own resource, evaluated deny-if-any. An earlier
// version collapsed a batch to the paths' common ancestor directory; that
// let `fs_read [README.md, .env]` be evaluated as a read of the repo root,
// which a `forbid read on File ".env"` policy never matches.
function extractReadTargets(toolInput: Record<string, any>, cwd: string): string[] {
  const ops = Array.isArray(toolInput.operations) ? toolInput.operations : undefined;
  if (ops && ops.length > 0) {
    const paths: string[] = [];
    for (const op of ops) {
      if (op && typeof op.path === 'string' && op.path) paths.push(op.path);
      if (op && Array.isArray(op.image_paths)) {
        for (const p of op.image_paths) if (typeof p === 'string' && p) paths.push(p);
      }
    }
    if (paths.length > 0) return dedupe(paths.map((p) => resolveAgainst(cwd, p)));
  }
  // IDE-shaped single-path tools, and any future variant that uses a plain
  // scalar field instead of the operations array.
  const single = toolInput.path || toolInput.file_path || toolInput.filePath;
  return [resolveAgainst(cwd, typeof single === 'string' && single ? single : cwd)];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

// The single path a write/edit/delete targets, across both hosts' field
// names (targetFile/target_file are the IDE's spellings for some tools).
function extractWriteTarget(toolInput: Record<string, any>, cwd: string): string {
  const p = toolInput.path || toolInput.file_path || toolInput.filePath || toolInput.targetFile || toolInput.target_file;
  return resolveAgainst(cwd, typeof p === 'string' && p ? p : cwd);
}

// Fallback only — an extension-based guess misclassifies real extensionless
// files (/etc/hosts, Makefile, Dockerfile) as directories. Used only when
// the path doesn't exist on disk yet (e.g. a file write is about to create).
function looksLikeFile(pathValue: string): boolean {
  const base = pathValue.replace(/\\/g, '/').split('/').pop() || '';
  return base.includes('.') && !base.startsWith('.');
}

// The hook runs on the same machine as the actual repo, so prefer a real
// stat over guessing from the path string whenever the path already exists.
function classifyPath(absolutePath: string): 'File' | 'Directory' {
  try {
    return fs.statSync(absolutePath).isDirectory() ? 'Directory' : 'File';
  } catch {
    return looksLikeFile(absolutePath) ? 'File' : 'Directory';
  }
}

// Walks up from cwd looking for a `.git` entry to find the repo root.
function findRepoRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Cedar policies are authored once against a portable id like
// "my-repo/src/utility/agents.md" so the same policy applies no matter
// whose machine or home directory the repo is cloned into — an absolute
// path like "/Users/alice/repos/my-repo/..." is specific to one person's
// machine and could never be referenced from a policy meant to apply to
// every developer with reva-governance installed. Falls back to the raw
// absolute path only when no git repo root can be found, or the path falls
// outside it entirely (including a different drive on Windows, where
// path.relative returns an absolute path).
function toPortableId(absolutePath: string, cwd: string): string {
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) return absolutePath;
  const repoName = path.basename(repoRoot);
  const rel = path.relative(repoRoot, absolutePath);
  if (rel === '') return repoName;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return absolutePath;
  return `${repoName}/${rel.split(path.sep).join('/')}`;
}

function baseName(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').split('/').pop() || pathValue;
}

function extension(pathValue: string): string | undefined {
  const base = baseName(pathValue);
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx + 1) : undefined;
}

// File/Directory entities declare `name`/`path` as required attributes in
// the CodingAgent schema — these helpers keep that consistent everywhere a
// File or Directory resource gets built. Operate on the portable id, same
// as resourceId, so nothing machine-specific leaks into these either.
function fileProperties(portableId: string): Record<string, any> {
  const ext = extension(portableId);
  return { name: baseName(portableId), ...(ext ? { extension: ext } : {}) };
}

function directoryProperties(portableId: string): Record<string, any> {
  return { path: portableId };
}

// The PDP expects a FLAT list of every ancestor, not just the immediate
// parent — Cedar's `in` needs the whole chain present to match a policy
// like `resource in Directory::"my-repo"` regardless of how deep the file
// actually is. No ancestor chain for the absolute-path fallback (outside
// any repo) — there's no meaningful Directory/Repository lineage to report
// for those.
function buildAncestorParents(portableId: string): CedarEntityRef[] {
  // path.isAbsolute (not a bare '/' check) so the fallback is recognized on
  // Windows too, where toPortableId()'s absolute-path fallback returns a
  // raw "C:\Users\..." path rather than a POSIX-style one.
  if (path.isAbsolute(portableId)) return [];
  const segments = portableId.split('/');
  const repoName = segments[0];
  if (!repoName) return [];
  const parents: CedarEntityRef[] = [];
  for (let i = segments.length - 1; i > 1; i--) {
    parents.push({ type: 'Directory', id: segments.slice(0, i).join('/') });
  }
  if (segments.length > 1) {
    parents.push({ type: 'Directory', id: repoName });
  }
  parents.push({ type: 'Repository', id: repoName });
  return parents;
}

// One File/Directory resource for an absolute path.
function pathMapping(
  actionName: CedarActionMapping['actionName'],
  absolutePath: string,
  cwd: string,
  extra: Partial<CedarActionMapping> = {},
  type: 'File' | 'Directory' = classifyPath(absolutePath),
): CedarActionMapping {
  const id = toPortableId(absolutePath, cwd);
  return {
    actionName,
    resourceType: type,
    resourceId: id,
    resourceProperties: type === 'File' ? fileProperties(id) : directoryProperties(id),
    resourceParents: buildAncestorParents(id),
    ...extra,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// The sub-agents a multi-agent call starts, in order, with the text each is
// handed: use_subagent's content.subagents [{query, agent_name}] and kiro-cli
// `subagent`'s stages [{name, role, prompt_template}]. Empty for a
// single-agent call.
function subAgentEntries(toolInput: Record<string, any>): { name: string; prompt?: string }[] {
  if (Array.isArray(toolInput.content?.subagents) && toolInput.content.subagents.length > 0) {
    return toolInput.content.subagents.map((e: any) => ({
      name: nonEmptyString(e?.agent_name) || 'default',
      prompt: nonEmptyString(e?.query),
    }));
  }
  if (Array.isArray(toolInput.stages) && toolInput.stages.length > 0) {
    return toolInput.stages.map((s: any) => ({
      name: nonEmptyString(s?.name) || nonEmptyString(s?.role) || 'default',
      prompt: nonEmptyString(s?.prompt_template),
    }));
  }
  return [];
}

// The instruction text each sub-agent of a spawn call is handed. A Kiro
// host may later submit that same text as a prompt event of its own (the
// IDE did, for invoke_sub_agent); authorizePrompt.ts uses these to tell
// "a sub-agent starting" apart from "the user starting a new turn".
export function subAgentPrompts(toolName: string, toolInput: Record<string, any>): string[] {
  if (!KIRO_SPAWN_TOOL_NAMES.has(toolName)) return [];
  const entries = subAgentEntries(toolInput);
  const prompts = entries.length > 0 ? entries.map((e) => e.prompt) : [nonEmptyString(toolInput.prompt) || nonEmptyString(toolInput.query)];
  return prompts.filter((p): p is string => !!p);
}

// One sub-agent being started. Its subagentIndex is assigned in
// authorize.ts, which knows how many spawns this turn has already counted.
function spawnMapping(agentName: string): CedarActionMapping {
  return {
    actionName: 'spawn',
    resourceType: 'SubAgent',
    resourceId: agentName,
    resourceProperties: { agentType: agentName },
  };
}

function single(mapping: CedarActionMapping): ToolMapping {
  return { mappings: [mapping], candidateCount: 1 };
}

// Many paths -> many resources, or a denial above the cap. Never widened.
function many(
  actionName: CedarActionMapping['actionName'],
  absolutePaths: string[],
  cwd: string,
  extra: Partial<CedarActionMapping> = {},
): ToolMapping {
  if (absolutePaths.length > MAX_RESOURCES_PER_CALL) {
    return { mappings: [], candidateCount: absolutePaths.length, overCap: true };
  }
  return {
    mappings: absolutePaths.map((p) => pathMapping(actionName, p, cwd, extra)),
    candidateCount: absolutePaths.length,
  };
}

// --- MCP tools that take paths ------------------------------------------------
//
// An MCP tool like the filesystem server's read_file / list_directory /
// move_file reads and writes real files, but as a bare `Tool` resource a
// file-level policy ("forbid read on .env") never sees which ones. So path
// arguments are ALSO evaluated as File/Directory resources, alongside the
// Tool itself, deny-if-any.
//
// HEURISTIC, deliberately simple, and labelled as such: which input keys
// hold paths, and whether the tool reads or writes, are inferred from names.
// Relative paths are resolved against the session cwd, which is a best
// guess — an MCP server may resolve them against its own roots.
const MCP_PATH_KEYS = ['path', 'paths', 'file_path', 'filePath', 'directory', 'dir', 'source', 'destination'];
const MCP_WRITE_TOOL_NAME = /(write|edit|create|move|delete|remove|rename|mkdir|append|replace|update|patch|upload)/i;

function mcpPathArguments(toolInput: Record<string, any>): string[] {
  const values: string[] = [];
  for (const key of MCP_PATH_KEYS) {
    const v = toolInput[key];
    const list = Array.isArray(v) ? v : [v];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const value = item.trim();
      if (!value || value.includes('://') || value.includes('$')) continue;
      values.push(hasWildcard(value) ? literalDirOf(value) : value);
    }
  }
  return values;
}

// --- MCP tool names ------------------------------------------------------------
//
// Three namings reach the hooks:
//
//   "@server/tool"         kiro-cli 2.x (kiro-cli tool specs, live captures)
//   "mcp__server__tool"    also accepted
//   "mcp_<server>_<tool>"  the Kiro desktop app and kiro-cli V3, which share
//                          one agent engine. The MCP tool's id there is
//                          "mcp_" + server + "_" + tool, lowercased, spaces
//                          and dashes as "_", other punctuation dropped
//                          (Kiro's own MCP tool id format).
//
// The third form loses the boundary between server and tool, since both may
// contain "_". It is recovered by matching the configured server names
// (mcp.json), cleaned the same way, longest first. A server no mcp.json
// declares falls back to the first segment — best effort, and labelled so.
// Before this, the second and third forms went through as an unrecognized
// tool with no MCPServer parent: the tool was evaluated, the server never.

export interface McpToolRef {
  server: string;
  tool: string;
}

// Loads every tool of a server: tool_load with "server::*" or, above the cap,
// one resource per server. Never "*" in a resource id — no policy can match
// a literal glob.
const MCP_ALL_TOOLS = '';

export function kiroMcpIdPart(name: string): string {
  return name.replace(/[\s-]/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
}

export function parseMcpToolName(toolName: string, serverNames: () => string[] = () => []): McpToolRef | undefined {
  const at = toolName.match(/^@([^/]+)\/(.+)$/);
  if (at) return { server: at[1], tool: at[2] };

  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return { server: parts[1] || 'unknown-server', tool: parts.slice(2).join('__') || toolName };
  }

  if (toolName.startsWith('mcp_')) {
    const rest = toolName.slice('mcp_'.length);
    let best: { name: string; part: string } | undefined;
    for (const name of serverNames()) {
      const part = kiroMcpIdPart(name);
      if (!part || !rest.startsWith(`${part}_`) || rest.length === part.length + 1) continue;
      if (!best || part.length > best.part.length) best = { name, part };
    }
    if (best) return { server: best.name, tool: rest.slice(best.part.length + 1) };
    const cut = rest.indexOf('_');
    if (cut > 0 && cut < rest.length - 1) return { server: rest.slice(0, cut), tool: rest.slice(cut + 1) };
  }
  return undefined;
}

// A deferred-tool id from tool_load / tool_call: "server::tool", optionally
// prefixed "tool::" (the resource-v1 format) or namespaced under a power
// ("<power>::tool::server::tool"). Built-in tools, skills, steering and power
// overviews are not MCP tools and return undefined.
export function parseMcpToolId(id: string): McpToolRef | undefined {
  let rest = id.trim();
  if (rest.startsWith('tool::')) rest = rest.slice('tool::'.length);
  if (/^(builtin|skill|steering)::/.test(rest) || /::(skill|steering)::/.test(rest) || rest.endsWith('::overview')) {
    return undefined;
  }
  const parts = rest.split('::');
  if (parts.length < 2) return undefined;
  const server = parts[parts.length - 2].trim();
  const tool = parts[parts.length - 1].trim();
  if (!server || !tool || server === 'tool') return undefined;
  return { server, tool: tool === '*' ? MCP_ALL_TOOLS : tool };
}

function mcpToolResource(server: string, tool: string): CedarActionMapping {
  if (tool === MCP_ALL_TOOLS) {
    return {
      actionName: 'invokeTool',
      resourceType: 'Tool',
      resourceId: server,
      resourceProperties: { name: server, description: `All tools of MCP server "${server}"`, connectionType: 'mcp' },
      resourceParents: [{ type: 'MCPServer', id: server }],
    };
  }
  return {
    actionName: 'invokeTool',
    resourceType: 'Tool',
    resourceId: `${server}/${tool}`,
    resourceProperties: { name: tool, description: `MCP tool "${tool}" on server "${server}"`, connectionType: 'mcp' },
    resourceParents: [{ type: 'MCPServer', id: server }],
  };
}

// The Tool, plus any path arguments as File/Directory resources.
function mcpToolCallMapping(
  server: string,
  tool: string,
  toolName: string,
  toolInput: Record<string, any>,
  cwd: string,
): ToolMapping {
  const toolMapping = mcpToolResource(server, tool);
  const paths = dedupe(mcpPathArguments(toolInput).map((p) => resolveAgainst(cwd, p)));
  if (paths.length === 0) return single(toolMapping);
  const fileAction = MCP_WRITE_TOOL_NAME.test(tool) ? 'write' : 'read';
  const files = many(fileAction, paths, cwd, { tool: toolName });
  if (files.overCap) return { mappings: [], candidateCount: paths.length + 1, overCap: true };
  return { mappings: [toolMapping, ...files.mappings], candidateCount: paths.length + 1 };
}

// Every resource one Kiro tool call touches. See ToolMapping in types.ts.
// `dialect` picks how shell commands are parsed — PowerShell/cmd on
// Windows, POSIX on macOS/Linux (see shellTargets.ts). `mcpServerNames`
// lists the configured MCP servers, read only when an "mcp_<server>_<tool>"
// name needs splitting.
export function mapToolCall(
  toolName: string,
  toolInput: Record<string, any>,
  cwd: string,
  dialect: ShellDialect = shellDialectFor(),
  mcpServerNames: () => string[] = () => readKiroMcpServers(cwd).map((s) => s.name),
): ToolMapping {
  if (KIRO_BASH_TOOL_NAMES.has(toolName)) {
    const command: string = toolInput.command || '';
    const targets = extractShellTargets(command, cwd, dialect);
    // No identifiable path: the working directory is the honest resource.
    if (targets.length === 0) {
      return { mappings: [pathMapping('executeBash', path.resolve(cwd), cwd, { command }, 'Directory')], candidateCount: 0 };
    }
    return many('executeBash', targets, cwd, { command });
  }

  if (KIRO_READ_TOOL_NAMES.has(toolName)) {
    return many('read', extractReadTargets(toolInput, cwd), cwd, { tool: toolName });
  }

  if (KIRO_DELETE_TOOL_NAMES.has(toolName)) {
    return single(pathMapping('write', extractWriteTarget(toolInput, cwd), cwd, { tool: toolName }, 'File'));
  }

  if (KIRO_WRITE_TOOL_NAMES.has(toolName) || KIRO_EDIT_TOOL_NAMES.has(toolName)) {
    return single(
      pathMapping(writeActionFor(toolInput, toolName), extractWriteTarget(toolInput, cwd), cwd, { tool: toolName }, 'File'),
    );
  }

  if (KIRO_GLOB_TOOL_NAMES.has(toolName)) {
    const pattern: string = toolInput.pattern || '';
    const absoluteDir = resolveAgainst(cwd, toolInput.path || literalDirOf(pattern) || cwd);
    return single(pathMapping('glob', absoluteDir, cwd, { pattern, tool: toolName }, 'Directory'));
  }

  if (KIRO_GREP_TOOL_NAMES.has(toolName)) {
    const pattern: string = toolInput.pattern || '';
    return single(pathMapping('grep', resolveAgainst(cwd, toolInput.path || cwd), cwd, { pattern, tool: toolName }));
  }

  if (toolName === 'session' && toolInput.command === 'spawn_session') {
    return single(spawnMapping(nonEmptyString(toolInput.agent_name) || 'subagent'));
  }

  if (KIRO_SPAWN_TOOL_NAMES.has(toolName)) {
    // kiro-cli's use_subagent (spec embedded in the 2.36.0 binary) is
    // multiplexed by `command`:
    //   ListAgents       — lists the available agents; starts nothing.
    //   InvokeSubagents  — content.subagents: [{query, agent_name?, relevant_context?}]
    //                      "Array of subagent invocations to execute in parallel".
    // ONE call can therefore start SEVERAL sub-agents. Each one becomes its
    // own `spawn`, so authorize.ts gives each its own subagentIndex — an
    // earlier version mapped the whole call to a single spawn, so four
    // sub-agents were counted as one and a fan-out guardrail never fired.
    if (toolInput.command === 'ListAgents') {
      return single({
        actionName: 'invokeTool',
        resourceType: 'Tool',
        resourceId: toolName,
        resourceProperties: { name: toolName, description: `Kiro tool: ${toolName} (ListAgents — lists agents, starts none)` },
      });
    }
    // Several sub-agents in one call: use_subagent's content.subagents, or
    // kiro-cli `subagent`'s stages. Not subject to MAX_RESOURCES_PER_CALL:
    // how many sub-agents a call may start is a policy question
    // (subagentIndex), not a path fan-out.
    const entries = subAgentEntries(toolInput);
    if (entries.length > 0) {
      return {
        mappings: entries.map((entry) => spawnMapping(entry.name)),
        candidateCount: entries.length,
      };
    }
    // One sub-agent per call: delegate, agent crew, the IDE's
    // invoke_sub_agent ({name, prompt}), any single-agent shape.
    return single(
      spawnMapping(
        nonEmptyString(toolInput.agent_name) ||
          nonEmptyString(toolInput.name) ||
          nonEmptyString(toolInput.subagent_type) ||
          nonEmptyString(toolInput.subagentType) ||
          nonEmptyString(toolInput.agent_type) ||
          'subagent',
      ),
    );
  }

  // MCP tools — see parseMcpToolName for the three namings that reach this
  // hook. The server name is the config key ingestMcpServers registers the
  // MCPServer entity under whenever it can be recovered.
  const mcp = parseMcpToolName(toolName, mcpServerNames);
  if (mcp) return mcpToolCallMapping(mcp.server, mcp.tool, toolName, toolInput, cwd);

  // The Kiro desktop app and kiro-cli V3 load MCP tools lazily and run them
  // through a pair of built-in tools (as captured from the Kiro desktop app:
  // tool_load { tool_ids: ["bigquery::get_table_info", ...] }).
  // tool_call hands its hooks to the MCP tool it runs, which then arrives as
  // "mcp_<server>_<tool>"; it is mapped here too in case a host reports it.
  if (toolName === 'tool_call' && typeof toolInput.tool_id === 'string') {
    const ref = parseMcpToolId(toolInput.tool_id);
    if (ref) {
      const args = toolInput.arguments && typeof toolInput.arguments === 'object' ? toolInput.arguments : {};
      return mcpToolCallMapping(ref.server, ref.tool, toolName, args, cwd);
    }
  }
  if (toolName === 'tool_load' && Array.isArray(toolInput.tool_ids)) {
    const refs = new Map<string, McpToolRef>();
    for (const id of toolInput.tool_ids) {
      const ref = typeof id === 'string' ? parseMcpToolId(id) : undefined;
      if (ref) refs.set(`${ref.server}/${ref.tool}`, ref);
    }
    if (refs.size > 0 && refs.size <= MAX_RESOURCES_PER_CALL) {
      return { mappings: [...refs.values()].map((r) => mcpToolResource(r.server, r.tool)), candidateCount: refs.size };
    }
    // A load can name up to 20 tools. Above the per-call cap, evaluate each
    // server once instead of denying the load; every tool is still checked
    // on its own when it actually runs.
    if (refs.size > MAX_RESOURCES_PER_CALL) {
      const servers = dedupe([...refs.values()].map((r) => r.server));
      return { mappings: servers.map((s) => mcpToolResource(s, MCP_ALL_TOOLS)), candidateCount: servers.length };
    }
    // Only built-in tools, skills or steering — nothing MCP to attribute.
  }

  return single({
    actionName: 'invokeTool',
    resourceType: 'Tool',
    resourceId: toolName,
    resourceProperties: { name: toolName, description: `Kiro tool: ${toolName}` },
  });
}

// The PRIMARY resource of a tool call — the first of mapToolCall's
// mappings. Kept for callers and tests that only need one resource; the
// hook entrypoints use mapToolCall, which evaluates every resource.
export function mapToolToCedar(
  toolName: string,
  toolInput: Record<string, any>,
  cwd: string,
  dialect: ShellDialect = shellDialectFor(),
): CedarActionMapping {
  const result = mapToolCall(toolName, toolInput, cwd, dialect);
  if (result.mappings.length > 0) return result.mappings[0];
  throw new Error(`tool call touches ${result.candidateCount} resources, above the cap of ${MAX_RESOURCES_PER_CALL}`);
}
