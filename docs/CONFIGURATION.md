# Configuration

The plugin reads the environment variables below. One is required in practice; the rest have
working defaults, and the last few exist for tests and for the plugin's own detached child
processes rather than for you to set.

Put them in the `env` block of Kiro's settings file, `~/.kiro/settings/cli.json`. A workspace
`<project>/.kiro/settings/cli.json` overrides the global file for that project. A plain
`REVA_*` environment variable in the process that launches Kiro **takes priority** over both,
which is what makes local development and the mock-PDP workflow possible without editing the
file — and also why a stale variable left in your environment silently wins.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `REVA_AUTH_TOKEN` | **yes** | — | Authenticates every request: PDP evaluation and ingestion. Sent as `X-API-Token`. |
| `REVA_AGENT_ID` | **conditionally** | your Kiro account's user UUID | The agent's Cedar identity. Resolved automatically from kiro-cli's local database. **Required explicitly when no Kiro account id can be read** — see below. |
| `REVA_HOST` | no | `api.reva.ai` | Your Reva tenant's API host. |
| `REVA_DEBUG` | no | off | Set to `1` to append each decision, timestamped, to `debug.log` in the data directory. Never written to stderr, so a deny reason shown by Kiro stays clean. |
| `REVA_DEBUG_LOG_FILE` | no | `<REVA_DATA_DIR>/debug.log` | A different path for the debug log. |
| `REVA_DATA_DIR` | no | `~/.kiro/reva-governance` | Where turn, hop, spawn and session state, the account cache and the entity-type cache are kept. |
| `REVA_PDP_TIMEOUT_MS` | no | `25000` | Timeout for an evaluation call. On timeout the plugin fails **closed** — the action is blocked. |
| `REVA_INGESTION_TIMEOUT_MS` | no | `5000` | Timeout for ingestion calls. Deliberately much shorter — ingestion is best-effort and never gates an action. |
| `REVA_POLICY_STORE_ID` | no | unset | Sent as a request header on evaluation and ingestion when set. Unset means Reva resolves the store from the token, which is the normal case. |
| `REVA_POLICY_STORE_HEADER` | no | `policyStoreId` | The header name carrying the above. |
| `REVA_MODEL` | no | unset | Pins the model reported to Reva. Unset reads it from Kiro — see "Model" below. |
| `REVA_SESSION_ENTRYPOINT` | no | `cli` / `Kiro Desktop` | Overrides `context.sessionEntryPoint`. |
| `REVA_KIRO_DB_PATH` | no | kiro-cli's `data.sqlite3` | Where to read the Kiro account id from. Intended for tests and non-standard installs. |
| `REVA_KIRO_SETTINGS_PATH` | no | `~/.kiro/settings/cli.json` | Overrides which settings file `REVA_*` values are read from. Intended for tests. |
| `REVA_SESSION_CWD` | no | the hook's own cwd | Set by the plugin when it spawns its detached MCP-ingestion child. Not intended to be set by hand. |
| `REVA_INVOKED_MCP_SERVER` | no | — | Set by the plugin on that same child to name the MCP server whose tool call triggered it. Not intended to be set by hand. |
| `REVA_INGESTION_SPAWNED` | no | — | Set by the plugin on its detached session-registration child. Not intended to be set by hand. |

**Identity.** Two identities go on every request, both from the Kiro account you are signed
into:

| Cedar entity | Value | Override |
|---|---|---|
| `User` (the principal) | your `kiro-cli whoami` email | none |
| `Agent` (the subject for tool calls) | your Kiro account's user UUID — the part after the `.` in `telemetryUserId` (`d-<directory>.<uuid>`) | `REVA_AGENT_ID` |


**Model.** Kiro does not put the model on the hook payload, so the plugin resolves it, in this
order: `REVA_MODEL`; Kiro's session record once the session has a completed turn; the value
remembered for this session; the `--model` flag kiro-cli was launched with; your
`chat.defaultModel` setting; Kiro's default. When Kiro is in `auto` mode it chooses the model
on its servers and never records which one, so `auto` is reported as is.

**Entry point.** `context.sessionEntryPoint` is `cli` for kiro-cli and `Kiro Desktop` for the
Kiro IDE. kiro-cli V3 sends the same hook payload as the Kiro IDE, so for those payloads the
plugin checks which Kiro program started the hook — `kiro-cli` gives `cli`, the Kiro app gives
`Kiro Desktop` — once per session (about 1.5 seconds on Windows, at session start). kiro-cli
run inside the Kiro app's terminal is reported as `cli`.

## If you are not signed in to Kiro

Read this section if you have not run `kiro-cli login` on this machine, or if kiro-cli's
local database cannot be read.

The plugin derives the agent's identity from your Kiro account's user id, stored by kiro-cli
in its local database:

| OS | Location |
|---|---|
| Windows | `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3` |
| macOS | `~/Library/Application Support/kiro-cli/data.sqlite3` |

It exists only after `kiro-cli login`, and reading it needs Node.js 22.5+. Without it the
plugin deliberately does **not** substitute a machine id or a random value — an invented
identity would be meaningless to a policy.

The result is that the plugin **fails closed and blocks every action** with:

```
Reva governance is not configured — missing: REVA_AGENT_ID. Could not resolve the Kiro
account id: either no account is logged in (`kiro-cli whoami` returned no Email line, is not
on PATH, or timed out), or kiro-cli's local database could not be read (it needs Node 22.5+;
set REVA_KIRO_DB_PATH if data.sqlite3 lives somewhere unusual).
```

Fix it with `kiro-cli login` and Node.js 22.5+. If that is not possible, set `REVA_AGENT_ID`
explicitly to a stable identifier for this agent, and make sure the matching entity exists in
your Reva tenant.

Separately, if `kiro-cli whoami` returns no email, the principal falls back to your **OS
username**, which is almost certainly not a provisioned user and will be denied everything.
`npm run doctor` reports that as a failure.

## Hosts and transport

`REVA_HOST` accepts a bare host (`api.example.reva.ai`) or one with a scheme, which is
stripped. Trailing slashes are removed. Paths are fixed in code:

- evaluation: `/pdp/v2/ai/evaluation`
- ingestion: `/ingestion/v2`

The scheme is **HTTPS for every host** except `localhost`, `127.0.0.1` and `[::1]`, which
use plain HTTP so a local mock PDP (`npm run mock-pdp`, on `localhost:8787`) works. This
cannot be overridden for a remote host.

## What blocks and what does not

A short version of the table in [SECURITY.md](../SECURITY.md#what-blocks-and-what-does-not):

| Condition | Outcome |
|---|---|
| Policy denies (403) | **blocked** |
| Guardrails return `conditional_allow` | Kiro IDE **asks** you; kiro-cli tells the agent and the tool **runs** |
| Reva unreachable, times out, or errors (5xx, 424, 404) | **blocked, every action** — fails closed |
| Token rejected (401) | **passes through for the rest of that session** — fails open |
| Payload too large (413) | **passes through** — fails open |
| `REVA_AUTH_TOKEN` missing, or no Kiro account id and no `REVA_AGENT_ID` | **blocked, every action** — fails closed |

Governance holds through a Reva-side outage: an unreachable or erroring PDP blocks rather
than silently letting actions through. The exceptions are a rejected token (401), which
passes through for the rest of that session because it usually means a principal that is
not provisioned yet, and an oversized payload (413), which concerns one request only. A
401 latches that session open with no retry; a new session calls the PDP again. A
misconfiguration must never silently permit everything while appearing to govern.


## Policies

Policies are authored and managed in Reva, not here — this plugin only enforces what your
organization has configured. Rules can be scoped to any governed action and to specific
resources, from "no shell commands anywhere" to "file writes only inside this repository".
To actually stop an action, use a Cedar `forbid` policy or a guardrail Reva evaluates before
it answers; a deferred (`MONITOR`) guardrail only records a warning. See your Reva console.
