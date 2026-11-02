# Reva runtime authorization for Kiro

A Kiro plugin that authorizes every tool call and every submitted prompt. Kiro calls it
before an action runs; it asks Reva's PDP whether the action is allowed, and answers allow,
ask or block — **before it runs**, not logged after the fact.

The same enforcement Reva applies at the API gateway, brought down to the coding-agent layer.

Plugin id: `reva-governance`. One codebase serves both Kiro hosts — the **Kiro IDE** and
**`kiro-cli`**.

- [How it works](#how-it-works)
- [Supported Kiro surfaces](#supported-kiro-surfaces)
- [What gets governed](#what-gets-governed)
- [What it sends](#what-it-sends)
- [What blocks, and what doesn't](#what-blocks-and-what-doesnt)
- [Install](#install)
- [Documentation](#documentation)

## How it works

The plugin hooks five points in a Kiro session:

| When | Kiro IDE trigger | kiro-cli trigger | What happens |
| --- | --- | --- | --- |
| A session starts | `SessionStart` | `agentSpawn` | Registers you, your machine, this Kiro account and your MCP servers with Reva's directory, so policies can reference you by the time you do anything. Never blocks a session from starting. |
| You submit a prompt | `UserPromptSubmit` | `userPromptSubmit` | Checks whether you're allowed to invoke the coding agent at all this turn. Also rechecks Kiro's `mcp.json` files roughly every 15 minutes, so a server added mid-session doesn't wait until your next session to register. |
| Before any tool call | `PreToolUse` | `preToolUse` | Checks whether that specific action is allowed, and blocks it if not. The first call to a tool of an MCP server that isn't registered yet also registers that server in the background. |
| After a tool call completes | `PostToolUse` | `postToolUse` | Re-evaluates with the actual result, for policies that care what a command returned. Audit only — the tool has already run. |
| Kiro finishes responding | `Stop` | `stop` | Removes the session from local active-session tracking and logs the model used. No Reva request. |

Every check is synchronous, before (or immediately after) the action. The session-start
registration also starts from the first prompt of a session, so it still happens when a
Kiro version doesn't fire its session-start trigger.

## Supported Kiro surfaces

| Surface | Governed |
| --- | --- |
| Kiro IDE (desktop app) chat, in a trusted workspace | yes |
| `kiro-cli chat` running the `reva-governance` agent (or any agent you installed the hooks into) | yes |
| `kiro-cli chat` running an agent without the hooks, including Kiro's built-in agents | **no** |
| Sub-agents a kiro-cli session starts under a built-in agent such as `kiro_default` | **no** |

In kiro-cli, hooks belong to an agent's own config file, so only agents that carry them are
governed. Make `reva-governance` your default agent so a plain `kiro-cli chat` is governed —
see [docs/INSTALL.md](docs/INSTALL.md#individual-install).

See [docs/DESKTOP-COMPATIBILITY.md](docs/DESKTOP-COMPATIBILITY.md) for how the two hosts are
told apart, what each one can enforce, and the sub-agent limitation in detail.

## What gets governed

Each Kiro tool maps to a named action, so a policy can distinguish "read a file" from "run
an arbitrary shell command" rather than lumping everything under one permission:

| Kiro does this | Kiro tools | Governed as |
| --- | --- | --- |
| Runs a shell command | `shell`, `execute_cmd`, `execute_bash`, `execute_pwsh`, `control_pwsh_process`, `control_bash_process` | `executeBash` |
| Reads a file or lists a folder | `fs_read`, `read_file`, `readFile`, `list_directory`, … | `read` |
| Creates or deletes a file | `fs_write` (`create`), `delete_file` | `write` |
| Edits a file | `fs_write` (`str_replace` / `insert` / `append`), `str_replace`, … | `edit` |
| Searches by file name | `glob`, `file_search`, `fileSearch` | `glob` |
| Searches file contents | `grep`, `grep_search`, `codebaseSearch` | `grep` |
| Calls an MCP tool (`@server/tool`) | any | `invokeTool` |
| Spawns a sub-agent | `subagent`, `use_subagent`, `invoke_sub_agent`, `delegate` | `spawn` — one per sub-agent, numbered per turn |
| Starts a new turn | — | `invokeAgent` |

Anything unrecognized is still evaluated, as `invokeTool` — an unknown tool is a policy
question, never a reason to skip governance.

**One tool call, every resource it touches.** A chained shell command, a batched read, or an
MCP tool given file paths is evaluated once per resource, and the call is **denied if any one
is denied**. A call touching more than 10 distinct paths is denied outright. Shell commands
are parsed by the shell they run in — PowerShell rules on Windows, POSIX rules on macOS and
Linux.

Resources are identified by a **repository-relative** path — `my-repo/src/index.ts` — so a
policy written once ("only allow this inside `my-repo/src/**`") works on every developer's
machine regardless of where they cloned it. When a file is not inside a git repository, or
lies outside the repository root, the plugin falls back to the absolute path.

## What it sends

This plugin transmits **the text of your prompts, your shell commands, and the contents of
files being written or read** to your Reva tenant for evaluation.

That is the point — a policy cannot judge an action it cannot see — but it is a real change
to your environment, and anyone rolling this out to a team should read the field-by-field
statement first:

**→ [SECURITY.md — What it sends, and what it keeps](SECURITY.md#what-it-sends-and-what-it-keeps)**

Local state is written only to the plugin's data directory, `~/.kiro/reva-governance` by
default. Nothing is written to your repositories.

## What blocks, and what doesn't

| Condition | Kiro IDE | kiro-cli |
|---|---|---|
| Policy denies | **blocked** | **blocked** |
| Guardrails return `conditional_allow` on a tool call | Kiro **asks** you | the agent is told it needs review; the tool **runs** |
| Reva unreachable, times out, or errors (5xx, 424, 404) | **blocked, every action** — fails closed | **blocked, every action** — fails closed |
| Token rejected (401) | **passes through for the rest of that session** — fails open | same |
| Payload too large (413) | **passes through** — fails open | same |
| `REVA_AUTH_TOKEN` missing, or no Kiro account id | **blocked, every action** — fails closed | same |

Governance holds even through a Reva-side outage: if the PDP is down, erroring, or
unreachable, actions are blocked rather than silently let through. The two exceptions are a
rejected token (401) — which passes through for the rest of that session, since it more often
reflects a principal that isn't provisioned yet than a real security failure — and an
oversized payload (413), which is about that one request, not a sign Reva itself is
unavailable. After a 401 the plugin stops calling Reva for that session; other sessions are
unaffected, and starting a new session checks again.

**kiro-cli on Windows** runs hooks through PowerShell, which drops a hook's exit code. The
installer writes Windows kiro-cli hooks as `node "<script>"; exit $LASTEXITCODE` so a deny
actually blocks. Hooks installed without that suffix are audit-only — `npm run doctor` flags
them.

**The plugin can only block what Reva denies.** A guardrail Reva evaluates *after* answering
(`"guardrails":{"status":"deferred"}`, shown as `MONITOR` in the decision log) never reaches
the hook as a deny. To stop an action, use a guardrail mode Reva evaluates before it answers,
or a Cedar `forbid` policy.

## Install

Requires **Node.js 22.5+** with `node` on your `PATH` — every hook runs as a `node` process,
and reading your Kiro account id needs Node's built-in SQLite support — and **Git**.

Kiro powers cannot register hooks, so the plugin is installed by cloning this repository into
a permanent folder and registering its hooks with both the Kiro IDE and kiro-cli:

```bash
kiro-cli login
git clone https://github.com/reva-ai/reva-kiro-authorization.git ~/tools/reva-governance-kiro
cd ~/tools/reva-governance-kiro
npm install            # also builds
npm run install-hooks
kiro-cli settings chat.defaultAgent reva-governance
npm run doctor
```

Then put your token in `~/.kiro/settings/cli.json`:

```json
{
  "env": {
    "REVA_AUTH_TOKEN": "<your token>",
    "REVA_HOST": "<your Reva host>"
  }
}
```

Restart the Kiro IDE, or start a new `kiro-cli chat` session. Leave out `REVA_HOST` if your
tenant is on `api.reva.ai`.

Step-by-step Windows and macOS instructions, updating, team rollout, token rotation, and
uninstall are in [docs/INSTALL.md](docs/INSTALL.md).

## Documentation

| | |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Requirements, individual and team install, updating your token |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every environment variable, identity, hosts and transport, policies |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Debug output, why everything is blocked, why nothing is governed, known limitations |
| [docs/DESKTOP-COMPATIBILITY.md](docs/DESKTOP-COMPATIBILITY.md) | Kiro IDE versus kiro-cli, what each enforces, verification, and rollout |
| [SECURITY.md](SECURITY.md) | What leaves your machine, the threat model, hardening checklist, reporting a vulnerability |

## License

Not specified.
