# Security

## Reporting a vulnerability

Email **info@reva.ai** with "SECURITY" in the subject. Please include what you found, how to
reproduce it, and what an attacker could do with it. Please do not open a public issue for
anything exploitable.

We will acknowledge within 3 business days and keep you updated until it is resolved. If you
would like credit in the release notes, say so and we will include it.

## What this software is, in security terms

This is an **authorization enforcement point that runs on a developer's workstation**. The
Kiro IDE and `kiro-cli` invoke it through five hooks, and on `PreToolUse` / `preToolUse` its
answer decides whether the tool call runs at all.

It is not a passive audit log. It sees the developer's prompts and the arguments of every tool
call, and it sends them to a Reva Policy Decision Point over HTTPS to be evaluated.

**Read the next section before deploying this to a team.** A tool that transmits prompts and
command text off the workstation is a meaningful change to a developer's environment, and the
people running it are entitled to know exactly what leaves their machine.

## What it sends, and what it keeps

Every evaluating hook sends a request to `https://<REVA_HOST>/pdp/v2/ai/evaluation`. The
table below is the complete set of content that leaves the machine.

| Hook | Content transmitted |
|---|---|
| `UserPromptSubmit` | The **full text of the prompt** the developer submitted, truncated to 2000 characters. |
| `PreToolUse` (shell tools) | The **full shell command**, verbatim. |
| `PreToolUse` (glob / grep tools) | The search pattern. |
| `PreToolUse` (all other tools) | `JSON.stringify(tool_input)` — the whole tool input object. For a file write this includes **the file content being written**; for an edit, the **text being replaced and its replacement**; for a sub-agent, **the instructions it is given**. |
| `PostToolUse` | The **serialized tool response**, truncated to 10000 characters — i.e. file contents that were read, and command output — together with the same command, pattern or tool input `PreToolUse` sent. |
| every evaluation | The current turn's user prompt, again, as one `conversation` message. |

Alongside the content, each request carries identity and resource metadata:

| Field | Value | Source |
|---|---|---|
| principal | The developer's **email address** | `kiro-cli whoami`; falls back to the **OS username** if no account is signed in |
| subject / agent id | The Kiro account's **user UUID** | `telemetryUserId` in kiro-cli's local database (`data.sqlite3`), or `REVA_AGENT_ID` when set. Only that one value is read — the database's token tables are never opened. |
| resource id | The file, directory or repository acted on | See "Paths" below |
| session | Session id, turn number, a count of concurrent sessions, and the entry point (`cli` or `ide-kiro`) | local |
| context | Operating system (`Windows` / `macOS` / `Linux`), this machine's hardware id, the model in use | local |
| correlation ids | A per-chat **thread id** — the Kiro session id, sent as `X-Reva-Thread-Id` — plus a per-prompt trace id and a per-operation span id in the W3C `traceparent` header | local |

At **session start** the plugin also registers entities with Reva's ingestion API
(`/ingestion/v2`): the developer's email, this machine's **hardware id** (`IOPlatformUUID` on
macOS, `/etc/machine-id` on Linux, `MachineGuid` on Windows — omitted if it cannot be read,
never invented), the agent id, the agent type `Kiro`, the operating system, and the model.

**MCP servers** are read from Kiro's own `mcp.json` files (`<workspace>/.kiro/settings/mcp.json`,
`~/.kiro/settings/mcp.json`). Every enabled server's **name** is registered on the developer's
User. A **remote** server is additionally registered as an `MCPServer` entity with its base
URL. For a **local (stdio)** server only the name leaves the machine — its `command`, `args`
and `env` are never transmitted, so credentials held in a stdio server's `env` block do not
leave the machine through this plugin.

To report which model a session uses, the plugin reads Kiro's own session records under
`~/.kiro/sessions/` and, once per kiro-cli session, the `--model` value from the command line
that launched `kiro-cli`. Only the model id is kept.

### Paths

A resource id is normally **repo-relative** — `my-repo/src/index.ts` — so one policy applies on
every developer's machine.

It falls back to the **raw absolute path** in two cases: when no git repository root can be
found above the file, and when the path lies outside the repository root. Reading
`C:\Windows\System32\drivers\etc\hosts` or editing a file in `~/Documents` therefore transmits
the absolute path, which on most systems contains the local username.

### What stays on the machine

Turn caches, spawn counters, the active-session list, the cached account lookup, the cached
entity-type ids and, when `REVA_DEBUG=1`, `debug.log` are written **only** inside the plugin's
data directory — `REVA_DATA_DIR`, by default `~/.kiro/reva-governance`. Nothing is written to
your repositories.

`npm run install-hooks` writes the hook registrations: `~/.kiro/hooks/reva-*.json` for the
Kiro IDE and the `hooks` block of `~/.kiro/agents/reva-governance.json` for kiro-cli.

### What Reva does with it

Content is transmitted to the Reva tenant identified by `REVA_HOST` and evaluated there.
Retention, logging and decision-log contents are properties of **that tenant**, not of this
plugin. If your organization has a policy about where prompt text and source code may be sent,
that policy applies to the Reva tenant you point this at — confirm it before a team rollout.

## What blocks, and what does not

`decision` values are the plugin's, not Kiro's. "Pass through" means the hook exits 0 with no
output, so Kiro proceeds exactly as if the plugin were not installed.

| Condition | Outcome |
|---|---|
| PDP returns 200 | **allow** |
| PDP returns 200 with `guardrails.outcome: conditional_allow` | **ask** — the Kiro IDE prompts the developer before a tool call. kiro-cli has no approval prompt for hooks: the agent is told the action needs review, and the tool **runs**. |
| PDP returns 403 | **deny** — the action is blocked |
| PDP returns 401 (bad or expired token) | **pass through** — and latches that session open: the PDP is not called again for the rest of it and every action passes through. A new session calls again. |
| PDP returns 413 (payload too large) | **pass through** — this one request only |
| PDP returns 404 or 424 | **deny** — blocked while Reva is unavailable |
| PDP returns 5xx | **deny** — blocked while Reva is unavailable |
| Network error or timeout | **deny** — blocked while Reva is unavailable |
| PDP returns another 4xx, including 429 | **deny** |
| A tool call touching more than 10 distinct paths | **deny** |
| `REVA_AUTH_TOKEN` missing | **deny — every action**, until configured |
| No Kiro account id can be read and `REVA_AGENT_ID` unset | **deny — every action**, until configured |
| Internal plugin error (bad stdin, mapping bug) | **deny** |

A deny is exit code 2 with the reason on stderr. On **Windows, kiro-cli** runs hooks through
PowerShell, which discards that exit code unless the hook command ends in
`; exit $LASTEXITCODE`. `npm run install-hooks` writes that suffix; hooks registered without
it are **audit-only** on Windows kiro-cli, and `npm run doctor` reports them.

`PostToolUse` is audit only on both hosts: the tool has already run, and neither host acts on
its answer.

Governance holds **through** a Reva-side outage. An unreachable, timing-out or erroring PDP
blocks every action rather than degrading to "no governance for that moment", and a plugin
that is misconfigured must likewise not silently permit everything while appearing to govern.

Two conditions still pass through. A **401** more often means a principal that is not
provisioned yet than a real security failure, so it fails open — but because failing open on
every call for as long as a bad token lasts would be indistinguishable from having no plugin,
it also latches a local circuit open for that session: no further PDP call is made in it, and
no retry storm follows. The latch is keyed by session, so it never silences a different
session — including one started after the problem was fixed — and starting a new session is
how the repair is picked up. It does not expire on its own. A **413** is about one oversized
request, not a sign that Reva is unavailable.

**Only what Reva denies can be blocked.** A guardrail Reva evaluates after answering
(`"status":"deferred"`, `MONITOR` in the decision log) lets the action run and only records a
warning.

**Plan for the fail-closed case before a team rollout.** With the PDP unreachable, every
governed action is blocked, so an outage stops developers working. `REVA_DEBUG=1` writes the
reason to `debug.log`, and `npm run uninstall-hooks` is the only local override.

**Sub-agents.** kiro-cli runs sub-agents under the agent each one is assigned, often the
built-in `kiro_default`, which carries no hooks. The `spawn` itself is evaluated, but a
sub-agent's own tool calls under such an agent are **not**. In the Kiro IDE, sub-agent tool
calls are evaluated, attributed to the parent `Agent`.

## Controls, and what each one actually buys you

**The auth token is the only credential.** One token authenticates both evaluation and
ingestion, sent as the `X-API-Token` header. Kept in `~/.kiro/settings/cli.json` it is a
plaintext file in the developer's home directory, protected by file permissions only. Supplied
as `REVA_AUTH_TOKEN` it is as exposed as any other environment variable, and it takes
priority over the file — for a team rollout, keep it in your secrets manager and let that
populate the environment.

**Transport.** HTTPS for every host except `localhost`, `127.0.0.1` and `[::1]`, which use
plain HTTP so a local mock PDP works for testing. A non-local host is always HTTPS; that cannot
be turned off.

**No third-party runtime dependencies.** The plugin uses only the Node standard library,
including the built-in `node:sqlite`. TypeScript and `@types/node` are dev dependencies. There
is no runtime supply chain to compromise.

**Hooks cannot escalate.** Every hook is a short-lived `node` process reading JSON on stdin and
answering through its exit code and stdout/stderr. It runs as the developer, with no
elevation, and its only network egress is to `REVA_HOST`. Background registration runs as a
detached `node` child with the same limits.

## Hardening checklist

- [ ] `REVA_AUTH_TOKEN` supplied through a secrets manager, or kept in the developer's own
      `~/.kiro/settings/cli.json` — never in a workspace `.kiro/settings/cli.json` that is
      committed to a repository
- [ ] `REVA_HOST` set explicitly for your tenant; the built-in default is `api.reva.ai`
- [ ] No stale `REVA_*` variables in the environment that launches Kiro — they override
      `cli.json`
- [ ] Token rotation has a named owner — the plugin does not detect or warn on expiry, it
      simply passes traffic through for the remainder of each session (401 fails open)
- [ ] Every developer is signed in with `kiro-cli login`, or has `REVA_AGENT_ID` set, or they
      are blocked
- [ ] On Windows, `npm run doctor` shows no kiro-cli hooks missing the `; exit $LASTEXITCODE`
      suffix
- [ ] `reva-governance` is the default kiro-cli agent, so a plain `kiro-cli chat` is governed
- [ ] Policies that must stop an action use a Cedar `forbid` or a synchronous guardrail, not a
      deferred (`MONITOR`) one
- [ ] `REVA_DEBUG` unset in normal use — `debug.log` records prompts, commands and decisions
- [ ] Your team has been told what this transmits, per "What it sends, and what it keeps"
- [ ] The Reva tenant's retention policy for prompt and command content has been reviewed
- [ ] A release tag is checked out rather than tracking a branch

## Supported versions

Security fixes are issued for the latest release. Check out a release tag rather than
tracking a branch (`git checkout <tag>`), and re-run `npm install` and `npm run install-hooks`
after updating so the registered hooks point at the new build.
