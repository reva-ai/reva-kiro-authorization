# Installing

## Requirements

- **Kiro IDE and/or `kiro-cli`**, signed in. The plugin uses your Kiro login email as your
  Reva user, and your Kiro account id as the agent's identity:

  ```bash
  kiro-cli login
  kiro-cli whoami        # should print your email
  ```

- **Node.js 22.5 or later**, with `node` on your `PATH`. Every hook runs as a short-lived
  `node` process, so if `node` is not resolvable the plugin cannot run at all. 22.5 is the
  first version with the built-in SQLite module used to read your Kiro account id.
- **Git**, to clone the plugin's repository. Check with `git --version`.
- A **Reva auth token** for your tenant, and your tenant's **API host** unless you are on
  the default `api.reva.ai`.

The plugin is distributed as a public GitHub repository,
[reva-ai/reva-kiro-authorization](https://github.com/reva-ai/reva-kiro-authorization).
Kiro powers installed from GitHub (the Kiro IDE's **Powers → Import power from GitHub**, or
`kiro-cli powers install`) bring in files and MCP servers but cannot register hooks, so the
plugin is installed by cloning the repository and running `npm run install-hooks`, which
registers the hooks with both the Kiro IDE and kiro-cli.

The hooks point at the cloned folder by its full path, so clone it somewhere permanent — for
example `C:\tools\reva-governance-kiro` or `~/tools/reva-governance-kiro`. If you move it
later, run `npm run install-hooks` again.

## Individual install

Follow the steps for your operating system — [Windows](#windows) or [macOS](#macos). Linux
follows the macOS steps, except that you install Node.js with your package manager and open
files with `nano` or your editor instead of `open -e`.

### Windows

Run every command in **Windows PowerShell**.

**1. Check the prerequisites.**

```powershell
node -v                  # v22.5.0 or later
git --version
kiro-cli --version
kiro-cli whoami          # prints your email; if not, run: kiro-cli login
```

If `node` is missing or older than 22.5, install the current LTS from
[nodejs.org](https://nodejs.org); if `git` is missing, install it from
[git-scm.com](https://git-scm.com). Then open a new PowerShell window.

**2. Clone the plugin into a permanent folder.**

```powershell
New-Item -ItemType Directory -Force C:\tools | Out-Null
git clone https://github.com/reva-ai/reva-kiro-authorization.git C:\tools\reva-governance-kiro
cd C:\tools\reva-governance-kiro
```

**3. Build and register the hooks.**

```powershell
npm install              # also builds
npm run install-hooks
```

The installer ends each kiro-cli hook command with `; exit $LASTEXITCODE`. PowerShell, which
kiro-cli runs hooks through on Windows, otherwise drops the exit code and a deny would not
stop the tool. Do not remove it.

**4. Add your Reva token.** Create the settings folder if needed and open the file in Notepad:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.kiro\settings" | Out-Null
notepad "$env:USERPROFILE\.kiro\settings\cli.json"
```

Add the `env` block inside the existing `{ }` (or paste the whole object into a new file),
then save:

```json
{
  "env": {
    "REVA_AUTH_TOKEN": "<your token>",
    "REVA_HOST": "<your Reva host>"
  }
}
```

**5. Remove stale Reva environment variables.** A `REVA_*` variable set on your machine
overrides `cli.json`. Check, and clear any you find:

```powershell
[Environment]::GetEnvironmentVariable('REVA_HOST', 'User')
[Environment]::GetEnvironmentVariable('REVA_AUTH_TOKEN', 'User')

[Environment]::SetEnvironmentVariable('REVA_HOST', $null, 'User')
[Environment]::SetEnvironmentVariable('REVA_AUTH_TOKEN', $null, 'User')
```

Close and reopen PowerShell, the Kiro IDE and VS Code afterwards — running programs keep the
old values.

**6. Make kiro-cli use the governed agent by default.**

```powershell
kiro-cli settings chat.defaultAgent reva-governance
kiro-cli agent list      # the * must be on reva-governance
```

**7. Check the install.**

```powershell
npm run doctor
npm run doctor -- --probe-cli
```

Everything should be `[ok]`, and the probe should report that the denied tool was stopped.

**8. Use it.** Restart the Kiro IDE and open a trusted workspace, or start a new
`kiro-cli chat`. To watch decisions, add `"REVA_DEBUG": "1"` to the `env` block and run:

```powershell
Get-Content "$env:USERPROFILE\.kiro\reva-governance\debug.log" -Wait -Tail 50
```

### macOS

Run every command in **Terminal**.

**1. Check the prerequisites.**

```bash
node -v                  # v22.5.0 or later
git --version
kiro-cli --version
kiro-cli whoami          # prints your email; if not, run: kiro-cli login
```

If `node` is missing or older than 22.5, install the current LTS from
[nodejs.org](https://nodejs.org) or with `brew install node`. If `git` is missing, run
`xcode-select --install`. Then open a new Terminal window.

**2. Clone the plugin into a permanent folder.**

```bash
mkdir -p ~/tools
git clone https://github.com/reva-ai/reva-kiro-authorization.git ~/tools/reva-governance-kiro
cd ~/tools/reva-governance-kiro
```

**3. Build and register the hooks.**

```bash
npm install              # also builds
npm run install-hooks
```

**4. Add your Reva token.** Create the file if needed and open it in TextEdit:

```bash
mkdir -p ~/.kiro/settings
touch ~/.kiro/settings/cli.json
open -e ~/.kiro/settings/cli.json
```

Add the `env` block inside the existing `{ }` (or paste the whole object into the empty
file), then save. TextEdit must be in plain-text mode (Format → Make Plain Text) so quotes
stay straight:

```json
{
  "env": {
    "REVA_AUTH_TOKEN": "<your token>",
    "REVA_HOST": "<your Reva host>"
  }
}
```

**5. Remove stale Reva environment variables.** A `REVA_*` variable in your shell overrides
`cli.json`. Check:

```bash
env | grep REVA_
grep -n REVA_ ~/.zshrc ~/.zprofile ~/.bash_profile 2>/dev/null
```

Delete any `export REVA_...` lines those files show, then run `unset REVA_HOST
REVA_AUTH_TOKEN` and open a new Terminal window. Quit and reopen the Kiro IDE too.

**6. Make kiro-cli use the governed agent by default.**

```bash
kiro-cli settings chat.defaultAgent reva-governance
kiro-cli agent list      # the * must be on reva-governance
```

**7. Check the install.**

```bash
npm run doctor
npm run doctor -- --probe-cli
```

Everything should be `[ok]`. If the doctor reports the Agent id as unresolved, check where
kiro-cli keeps its database and point the plugin at it:

```bash
ls ~/Library/Application\ Support/kiro-cli/data.sqlite3
```

If the file is somewhere else, add `"REVA_KIRO_DB_PATH": "<full path to data.sqlite3>"` to
the `env` block.

**8. Use it.** Quit and reopen the Kiro IDE and open a trusted workspace, or start a new
`kiro-cli chat`. To watch decisions, add `"REVA_DEBUG": "1"` to the `env` block and run:

```bash
tail -f ~/.kiro/reva-governance/debug.log
```

### What the installer sets up

`install-hooks` sets up both hosts:

- **Kiro IDE** → five files in `~/.kiro/hooks/` (`reva-session-start.json`,
  `reva-prompt-submit.json`, `reva-pre-tool-use.json`, `reva-post-tool-use.json`,
  `reva-session-end.json`). They apply to every project. Use `--project <path>` to install into
  one project instead. An older `reva-stop.json` is removed — `Stop` fires after every reply,
  not when a session closes.
- **kiro-cli** → a `hooks` block in `~/.kiro/agents/reva-governance.json`. A new agent is
  created with the `shell` and `use_subagent` tools; an existing one only has its `hooks`
  field changed. Use `--agent <name>` to add the hooks to an agent you already use.

To set up only one host:

```bash
npm run install-hooks -- --ide
npm run install-hooks -- --cli
```

About `cli.json`, on both systems:

- It must hold exactly one JSON object; two objects one after the other break both Kiro and
  the plugin. Leave out `REVA_HOST` if your tenant is on `api.reva.ai`.
- A `REVA_*` variable in the environment that launches Kiro **overrides** this file — see
  [CONFIGURATION.md](CONFIGURATION.md).
- Without the default-agent setting, start sessions with `kiro-cli chat --agent
  reva-governance`. Any other agent runs without the hooks.
- Configuration is read at the start of each session, so always start a new one after a
  change.

### Updating the plugin

Pull the new version into the same folder, rebuild, and re-register the hooks so both hosts
pick up any change to the hook commands:

```bash
cd <plugin folder>
git pull
npm install
npm run install-hooks
npm run doctor
```

Then restart the Kiro IDE, or start a new `kiro-cli chat`. To stay on a fixed release
instead of the latest commit, check out a tag (`git checkout <tag>`) in place of `git pull`.

## Team rollout

There is no central policy file that Kiro reads for plugins, so a rollout installs the plugin
on each workstation with your own tooling.

**1. Store your workspace token in your organization's secrets manager**, exposed to each
workstation as the environment variable `REVA_AUTH_TOKEN`. Keep it there — not in a shared
config file — so it stays under your secrets manager's own access controls. Set `REVA_HOST`
the same way if you are not on the default host. Environment variables take priority over
`cli.json`, so nobody has to edit a file.

**2. Clone the repository to the same path on every workstation**, pinned to a release tag,
with Node.js 22.5+ and Git installed:

```bash
git clone --branch <tag> https://github.com/reva-ai/reva-kiro-authorization.git <plugin folder>
```

**3. Run, as each developer** (the hooks and agent file live in their own `~/.kiro`):

```bash
cd <plugin folder>
npm install
npm run install-hooks
kiro-cli settings chat.defaultAgent reva-governance
npm run doctor
```

**4. Have each developer sign in** with `kiro-cli login`. The plugin creates a new Reva user
as `active: "false"`; an admin activates it in Reva before policies permit anything.

**Before you roll this out to a team, read
[SECURITY.md](../SECURITY.md#what-it-sends-and-what-it-keeps).** The plugin transmits prompt
text, shell commands and file contents to your Reva tenant, and your developers are entitled
to know that.

## Updating your token

- **Set in `~/.kiro/settings/cli.json`**: edit `REVA_AUTH_TOKEN` there. No reinstall needed.
- **Set as an environment variable**: update it at the source — your shell profile, user
  environment variables, or your secrets manager. No reinstall needed.

Either way, start a fresh session afterwards: restart the Kiro IDE, or start a new
`kiro-cli chat`. A session that already received a 401 keeps passing through until it ends.

If you switch to a token for a different policy store, nothing else needs clearing — cached
entity-type ids are stored per host, store and token.

## Uninstalling

```bash
npm run uninstall-hooks
```

This removes the five `reva-*.json` files from `~/.kiro/hooks/` and the Reva hooks from the
kiro-cli agent. Local state stays in `~/.kiro/reva-governance` (or your `REVA_DATA_DIR`) —
delete that folder to remove it. Nothing was written to your repositories.

```powershell
# Windows
Remove-Item -Recurse -Force "$env:USERPROFILE\.kiro\reva-governance"
```

```bash
# macOS / Linux
rm -rf ~/.kiro/reva-governance
```

Finally, remove the `REVA_*` entries from the `env` block of `~/.kiro/settings/cli.json`,
and delete the cloned plugin folder.
