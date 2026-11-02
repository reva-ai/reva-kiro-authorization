# Troubleshooting

Start here. Add `"REVA_DEBUG": "1"` to the `env` block of `~/.kiro/settings/cli.json`, start
a new session, and read the log:

```bash
# macOS / Linux
tail -f ~/.kiro/reva-governance/debug.log
```

```powershell
# Windows
Get-Content "$env:USERPROFILE\.kiro\reva-governance\debug.log" -Wait -Tail 50
```

Every hook then logs the raw payload Kiro sent, the action it mapped, the decision it
received and the reason. Almost everything below is diagnosable from that output, or from:

```bash
npm run doctor
```

## Every action is blocked

The plugin fails closed on **misconfiguration** and on a **Reva outage**. Four causes, in
order of likelihood:

**`REVA_AUTH_TOKEN` is not set.** The log shows
`Reva governance is not configured — missing: REVA_AUTH_TOKEN`. Check that
`~/.kiro/settings/cli.json` holds exactly one JSON object with the token inside its `env`
block — see [INSTALL.md](INSTALL.md#individual-install).

**The Kiro account id cannot be read.** The log shows `missing: REVA_AGENT_ID`. Run
`kiro-cli login`, check `node -v` is 22.5 or later, or set `REVA_AGENT_ID` — see
[CONFIGURATION.md](CONFIGURATION.md#if-you-are-not-signed-in-to-kiro).

**Reva cannot be reached.** The reason reads `blocked while Reva is unavailable`. Check
`REVA_HOST`, and that no stale `REVA_HOST` in your environment is overriding `cli.json`:

```powershell
# Windows
[Environment]::GetEnvironmentVariable('REVA_HOST', 'User')
```

```bash
# macOS / Linux
echo "$REVA_HOST"
```

**Your policy genuinely denies it.** The block reason names the policy decision rather than
a configuration problem. Check the decision log in your Reva console. A brand-new user is
created `active: "false"` and is denied until an admin activates it; if `npm run doctor`
reports `OS USERNAME FALLBACK`, you are being evaluated as your OS username — run
`kiro-cli login`, then `npm run install-hooks`.

## Nothing appears to be governed

The plugin fails **closed** when Reva cannot give an answer, so an outage shows up as
everything being blocked, not as ungoverned work. Look at these instead, in order:

1. **Is this session running a governed agent?** In kiro-cli only agents carrying the hooks
   are governed. Run `kiro-cli agent list` — the `*` should be on `reva-governance`. If not,
   run `kiro-cli settings chat.defaultAgent reva-governance` or
   `kiro-cli chat --agent reva-governance`.
2. **Did the Kiro IDE load the hooks?** Hooks load at the start of a chat session, in a
   **trusted** workspace. `npm run doctor` lists the five `~/.kiro/hooks/reva-*.json` files;
   then restart the IDE.
3. **Is `node` on your PATH?** Every hook runs it. `node -v` in the same shell or environment
   Kiro starts from.
4. **Is the token still valid?** A 401 fails open by design and latches that session open:
   the PDP is not called again until a new session starts. The log shows
   `failing open for this request`, then `circuit open for this session`.
5. **Did Reva answer "allow" with a deferred guardrail?** A response with
   `"guardrails":{"status":"deferred"}` (`MONITOR` in the decision log) lets the action run and
   only records a warning. Use a Cedar `forbid` or a synchronous guardrail.
6. **kiro-cli on Windows: does the hook command end in `; exit $LASTEXITCODE`?** Without it
   PowerShell turns a deny into a harmless hook error and the tool runs. `npm run doctor`
   flags this; re-run `npm run install-hooks`. To prove it on your machine:
   `npm run doctor -- --probe-cli`.
7. **Did you start a new session?** Configuration is read at session start.

## `dist/src/...js` not found

The hooks execute compiled JavaScript from `dist/`, which `npm install` builds after
`git clone`. If it is missing, the build did not run, or the cloned folder was moved or
deleted after the hooks were registered:

```bash
cd <plugin folder>
npm install
npm run build
npm run install-hooks
```

If the folder was deleted, clone the repository again first — see
[INSTALL.md](INSTALL.md#individual-install).

## Kiro hangs on a tool call

An evaluation call can take up to `REVA_PDP_TIMEOUT_MS` (default 25 s) before the plugin
gives up and blocks the action. The installer caps the `PreToolUse` and `PostToolUse` hooks at
45 s and `UserPromptSubmit` at 30 s.

If calls are routinely slow, lower `REVA_PDP_TIMEOUT_MS` — you are trading a longer stall
for a sooner block on a slow link.

The first prompt on a new machine can also wait on `kiro-cli whoami`, which takes around 10 s
on Windows. Its result is cached for 24 hours; `npm run install-hooks` pre-warms it.

## Session start is slow

Session registration is best-effort, runs in a detached background process, and uses its own
`REVA_INGESTION_TIMEOUT_MS` (default 5 s) per call. It never blocks a session from starting;
a failure is logged under `REVA_DEBUG=1` and otherwise ignored.

On a brand-new install there can be a brief window before you are fully provisioned in
Reva's directory, during which policies referencing you may not match as expected.

If the debug log shows `404 Entity type not found` after you changed token or tenant, start a
new session — cached entity-type ids are stored per host, store and token, and are looked up
again for the new combination.

## A file outside a repository is denied unexpectedly

Resource ids are repository-relative — `my-repo/src/index.ts` — so one policy works on every
machine. When the file is **not** inside a git repository, or lies outside the repository
root, the plugin falls back to the **absolute path**. A policy written against a
repo-relative pattern will not match that, so the action may be denied by a catch-all rule.

A shell command touching more than 10 distinct paths is denied outright. Split it into
narrower commands.

## MCP servers are not showing up in Reva

The plugin reads servers from Kiro's own config files —
`~/.kiro/settings/mcp.json` (what `kiro-cli mcp add --scope global` writes),
`<project>/.kiro/settings/mcp.json`, and `<project>/mcp.json`. A server marked
`"disabled": true` is skipped.

- Every enabled server's **name** is added to your User's `registeredMcpServers`, shown as
  "Linked MCP Servers".
- Only a **remote** server (one with a `url`) also gets an `MCPServer` entity, since a local
  stdio server has no base URL and the plugin will not invent one.

A server added mid-session is picked up within about 15 minutes by the prompt hook, or
immediately the first time one of its tools is called. Look for `ingestMcpServers:` lines in
the debug log — each server is reported as `ok` or `FAILED`, and a failed one is retried
later.

MCP tool calls are evaluated as `invokeTool` whether or not the server is registered.

## Known limitations

- **kiro-cli sub-agents running under a built-in agent are not governed.** Their `spawn` is
  evaluated, but kiro-cli runs each sub-agent under the agent it is assigned — often the
  built-in `kiro_default`, which carries no hooks — so that sub-agent's own tool calls never
  reach the plugin.
- **Sub-agent tool calls in the Kiro IDE are evaluated as the parent `Agent`**, not as a
  `SubAgent`: the IDE sends no field that marks them as coming from a sub-agent.
- **"Ask" exists only on the Kiro IDE's tool calls.** On kiro-cli, and on the IDE's prompt
  hook, a `conditional_allow` is passed to the agent as text and the action proceeds.
- **`PostToolUse` is audit only** on both hosts — the tool has already run.
- Raw model completions and MCP tool-**listing** calls are not gated — only actual tool
  calls and prompts are, since those are the only points Kiro exposes a hook for.
- Shell command targeting is a best-effort heuristic, not a full shell parser. Variables,
  substitutions and unusual constructs fall back to the working directory as the resource.
- **`auto` model mode is reported as `auto`**: Kiro chooses the underlying model on its
  servers and never records it locally.
- Directory registration happens in the background and is best-effort.

## Still stuck

Contact your Reva administrator with your `debug.log` and `npm run doctor` output.
**Redact the transmitted content first** — the debug log includes prompt and command text.

For anything security-sensitive, email **info@reva.ai** with "SECURITY" in the subject
rather than opening a public issue.
