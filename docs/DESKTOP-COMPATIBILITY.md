# Desktop compatibility: Kiro IDE versus kiro-cli

This plugin governs both Kiro hosts — the **Kiro IDE** desktop app and **`kiro-cli`** — from
one codebase. The two are not front-ends over one hook system: they use different
registration files, trigger names, tool names, shells and enforcement. This page states which
surfaces are governed, how the plugin tells the hosts apart, what happens where governance
does not reach, and how that is verified.

## Which surfaces are governed

| Surface | Governed |
|---|---|
| Kiro IDE chat, in a trusted workspace | yes |
| Kiro IDE sub-agents (`invoke_sub_agent`) | yes — spawn and tool calls; tool calls attributed to the parent `Agent` |
| `kiro-cli chat` with the `reva-governance` agent, or an agent given the hooks with `--agent` | yes |
| `kiro-cli chat` with any other agent, including the built-ins `kiro_default`, `kiro_planner`, `kiro_help` | **no** |
| Sub-agents a kiro-cli session starts under an agent without the hooks | spawn **yes**, their tool calls **no** |
| Kiro IDE in an untrusted workspace | **no** — the IDE does not run hooks there |

A Git repository is not required on the governed side.

What each governed host can enforce:

| | Kiro IDE | kiro-cli |
|---|---|---|
| Prompt deny (`invokeAgent`) | **blocks** | **blocks** |
| Tool-call deny | **blocks** | **blocks** (Windows: needs the `; exit $LASTEXITCODE` suffix) |
| Tool-call `ask` | native approval prompt | passed to the agent as text; the tool runs |
| Post-tool-call | audit only | audit only |

## How the distinction is made

The plugin decides which host it is running under from the **trigger name in the hook
payload** — never from tool names, an environment flag or a build setting. See
[`src/host.ts`](../src/host.ts), the only file that knows two hosts exist; everything else
works from the shape it produces.

| | Kiro IDE | kiro-cli |
|---|---|---|
| Registration | `~/.kiro/hooks/*.json` (`{ "version": "v1", "hooks": [...] }`) | `hooks` field of `~/.kiro/agents/<agent>.json` |
| Triggers | PascalCase: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` | camelCase: `agentSpawn`, `userPromptSubmit`, `preToolUse`, `postToolUse`, `stop` |
| Matcher (tool hooks) | regular expression, `.*` | glob, `*` |
| Session id | `session_id` in the payload | `session_id` in the payload, or the `KIRO_SESSION_ID` environment variable |
| Shell running hook commands on Windows | `cmd.exe` | PowerShell |
| Shell tools | `execute_pwsh`, `execute_bash`, `control_pwsh_process`, `control_bash_process` | `shell`, `execute_cmd`, `execute_bash` |
| Sub-agent tools | `invoke_sub_agent` (one per call) | `subagent` (one per `stages` entry), `use_subagent` (one per `content.subagents` entry) |
| `context.sessionEntryPoint` | `ide-kiro` | `cli` |

Two rules follow:

- **The casing is unambiguous.** A PascalCase trigger is always the IDE and a camelCase one
  always kiro-cli. Only when a payload carries no recognizable trigger does the plugin fall
  back to which session-id field is present.
- **Hook commands are a bare `node "<absolute path>.js"`**, the one form both `cmd.exe` and
  PowerShell parse the same way. On Windows the kiro-cli form adds `; exit $LASTEXITCODE`,
  because PowerShell otherwise reports a hook's exit 2 (deny) as 1, which kiro-cli treats as
  a harmless hook error.

## What a hook does on an excluded surface

On a surface that is not governed, the plugin is **never invoked at all** — there is no hook
registered there to run. It makes no Reva request, writes no state, and the host behaves as if
the plugin were not installed.

The case that matters is **kiro-cli sub-agents**. When the governed agent starts sub-agents,
the plugin evaluates every `spawn` before it happens — one `spawn` per sub-agent, numbered
1, 2, 3… within the turn — and a denied spawn is blocked. But kiro-cli then runs each
sub-agent under the agent named in its `role` / `agent_name`, often the built-in
`kiro_default`. A built-in agent carries no hooks, so that sub-agent's tool calls run
without evaluation, until the parent's `postToolUse` for the `subagent` call fires when they
finish.

What this means in practice:

- A policy on `spawn` is the control point for kiro-cli sub-agents today. A policy can
  inspect the sub-agent's name and instructions, which are sent in the spawn request.
- Policies on `executeBash`, `read`, `write` and the rest do **not** apply inside a kiro-cli
  sub-agent running under an agent without the hooks.

In the Kiro IDE the same situation does not arise: sub-agent tool calls fire the IDE's hooks
and are evaluated, within the parent session. The IDE also re-submits each sub-agent's
instructions as a prompt event; the plugin recognizes these and continues the current turn,
so the sub-agent count and trace are not reset.

## Verification matrix

`npm test` runs the suite: unit tests per module plus real-subprocess tests that spawn each
compiled hook entrypoint against a throwaway local HTTP server and assert on the real exit
code and output.

| Dimension | Covered by |
|---|---|
| Host detection from both trigger casings, and the no-trigger fallback | `test/host.test.ts` |
| Native output per host and hook: deny as exit 2 + stderr, IDE `ask` JSON, kiro-cli `ask` as text, no output when Reva is unavailable | `test/host.test.ts`, `test/hookOutput.test.ts` |
| Tool-name mapping for both hosts' tool vocabularies, including both shells' command parsing | `test/mapping.test.ts`, `test/shellTargets.test.ts` |
| Multi-resource calls denied if any resource is denied | `test/authorizeMulti.test.ts` |
| Sub-agent spawns numbered per turn; IDE sub-agent prompts continue the turn | `test/spawnCounter.test.ts`, `test/subAgentPrompts.test.ts` |
| Fail-closed and fail-open status matrix, 401 session latch | `test/pdpClient.test.ts`, `test/pdpCircuitBreaker.test.ts` |
| Session registration started once per session from either trigger | `test/sessionIngestion.test.ts`, `test/sessionStart.test.ts` |
| MCP servers registered mid-session | `test/mcpIngestionTrigger.test.ts` |

On a real machine:

```bash
npm run doctor               # hooks present for both hosts, Windows suffix, token, identity
npm run doctor -- --probe-cli  # one real kiro-cli turn with an always-deny hook
```

`--probe-cli` reports whether kiro-cli actually stopped the tool, which is the only reliable
evidence that enforcement works on that machine and kiro-cli version.

To exercise the whole path without a real Reva tenant, run `npm run mock-pdp` and point
`REVA_HOST` at `localhost:8787`.

## Rollout

To update, pull the new version into the cloned folder and re-register the hooks, so both
hosts point at the new build and pick up any change to hook commands:

```bash
cd <plugin folder>
git pull                     # or: git checkout <tag>
npm install
npm run install-hooks
npm run doctor
```

Then start fresh sessions — hooks and configuration are read at session start:

- **Kiro IDE:** restart the IDE and open a trusted workspace.
- **kiro-cli:** start a new `kiro-cli chat`; check with `kiro-cli agent list` that
  `reva-governance` is the default (`*`).

On Windows, hooks registered before the `; exit $LASTEXITCODE` suffix existed stay
audit-only on kiro-cli until `npm run install-hooks` is re-run; `npm run doctor` flags them.
