# Herdr integration

Herdr is a terminal workspace with two parts: the `hc` core, which owns terminals and remote machines, and `herdr-app`, the window that shows them. When pi runs inside a Herdr terminal, spider shows its work in that window. Remote commands, subagent views, and job results appear under the pi session that owns them, and spider never types into the pi editor.

The integration is optional. Outside Herdr, spider runs as ordinary spider.

This guide covers setup, each feature, the configuration file, and troubleshooting. The code lives in `packages/herdr`. See [packages/herdr/README.md](../../packages/herdr/README.md) for the module map.

## What the integration adds

Spider keeps the session's Herdr status at `working` while its subagents are queued, running, or paused.

`spider exec`, `exec_file`, and `batch` take an `on` machine name. The command runs on that machine, and the full output comes back to pi. Each agent gets one console per machine that shows its commands. A remote job that finishes after its tool call returns posts a `spider.job_done` message to the owning session, at most once.

Plain `ssh` and other SSH transports to a configured machine are refused, with a pointer to `on`. An audited admin command covers the cases that need a real SSH connection.

The left sidebar lists your sessions with their subagent runs, consoles, and live commands, and a Machines section shows the status of each configured machine. Each subagent run gets a viewer with its own message box for steering.

The spider panel shows, for the selected space, what needs your attention, each session's todos, triggers, and credits this month, and the month's credit pace.

Setup opens your sessions in named spaces and tabs. After the core restarts, each restored shell offers to resume its saved session.

Setup also writes `hc` templates that start visible worker, reviewer, and watcher pi sessions. It installs a neutral black glass layout, a Dracula+ pi theme, two bundled fonts, and five Herdr keys that open spider views in pi without touching your draft.

## Requirements

- Node.js `>=22.19.0` on the local machine, and Node.js `>=22.18.0` on every remote machine you use with `on`.
- Pi `1.2.0`.
- `hc` `0.1.16` and `herdr-app` `0.1.11`. Other versions are not supported.
- macOS or Linux. A Linux machine reached from macOS is supported. On other platforms, the doctor reports a failure instead of falling back to local execution.

Each remote machine must already be configured in `hc`. Spider validates machines but never adds or restarts them. To use a Node binary that is not on the remote `PATH`, set `nodePath` for that machine.

## Turn the integration on or off

The host setting `herdr.enabled` controls the integration. It accepts `"auto"`, `true`, or `false`, and it defaults to `"auto"`. It is a global-only setting, like `herdr.config`. See [Where the configuration file lives](#where-the-configuration-file-lives).

- With `"auto"`, the integration starts only when pi runs inside a Herdr terminal, a configuration file exists, and the `hc` core is running.
- With `true`, the integration starts whenever pi runs inside a Herdr terminal and a configuration file exists. If it cannot start, spider reports an error.
- With `false`, spider does not read the configuration file and runs as ordinary spider.

When the integration does not start, spider continues as ordinary spider and tells you once per session. With `"auto"`, it shows the warning `Herdr unavailable: <reason>. Regular spider remains available.` With `true`, it shows the error `Herdr activation failed: <reason>. Regular spider remains available.` Without a UI, spider prints the message to stderr. The reason is, for example, `no Herdr configuration`, `not inside Herdr`, or `Herdr core is not running`. With `"auto"`, a session outside Herdr with no configuration file shows nothing. With `false`, spider shows nothing.

While the integration is off, a call with `on` fails with `herdr-disabled: on requires an enabled live Herdr owner`, and nothing runs locally instead.

Spider never starts or restarts a Herdr core. It checks that the core's socket accepts a connection before each `hc` call. If the core is down, the call fails with `core-unavailable` and `hc` is not started.

### When the core stops during a session

If the core stops during a session, spider switches that session to ordinary spider. It removes the SSH rule and its shim, stops the session feed, and shows this warning once:

```text
Herdr unavailable: Herdr core unavailable; use /reload to recover. Regular spider remains available.
```

Calls with `on` then fail with `herdr-disabled`. Spider checks for the core every 2 seconds, but it does not reconnect on its own. When the same core is running again, spider shows `Herdr core is back. /reload to reconnect.` Run `/reload` in the session to turn the integration back on.

If a different core replaced the one that the session's terminal belonged to, that terminal no longer exists in Herdr. The session stays inactive and shows this notice once:

```text
this session's Herdr terminal belongs to a core that is no longer running; start a new session in Herdr
```

The same notice appears when such a session starts or reloads. Start the session again in a Herdr terminal of the running core.

The configuration file also has an `enabled` field. The host setting `herdr.enabled` overrides it.

To change the setting, run:

```text
spider control command:"config" op:"set" key:"herdr.enabled" value:false scope:"global"
```

## Set up the integration

Setup runs from a plain shell, not from inside pi. It refuses to run in a pi process or a subagent child.

### Where the configuration file lives

The standard location is `<spider global root>/herdr/config.json`. The spider global root is the directory in `SPIDER_GLOBAL_ROOT`, or else `~/.pi/agent/spider`. `PI_CODING_AGENT_DIR` does not change it. Pi sessions find a file at the standard location without any setting.

To keep the file somewhere else, pass its absolute path to setup with `--config`. Setup then records the path in the global host setting `herdr.config`, and pi sessions read that file. A relative `herdr.config` value resolves against the spider global root. If you later run setup with the standard location again, setup removes the setting it recorded.

`herdr.config` and `herdr.enabled` are global-only settings. Spider reads them only from the global `config.json`. If a repository's settings set either key, spider ignores that value and warns once per key:

```text
herdr.config in <repository config file> is ignored: global scope only
```

To set either key with `spider control`, pass `scope:"global"`. Any other scope fails with `<key> is global-only; use scope:"global"`.

Pi sessions, subagents, the setup CLI, and the admin command all use this lookup. When you leave out `--config`, the CLI reads the global `herdr.config` setting, then falls back to the standard location. The CLI prints the same warning for a repository value.

The file's `globalRoot` must be the same spider global root that pi uses. Feeds, jobs, and the SSH cache live under `globalRoot`, while process records and IPC sockets live under the global root that pi resolves. Setup and rollback check that the two match before they write anything. If they differ, they stop with `global-root-mismatch`, and the doctor reports the same code.

The file's `agentDirectory` must be the pi agent directory that your shell uses: the directory in `PI_CODING_AGENT_DIR`, or pi's default. Setup and rollback compare the two before they change anything. If they differ, they stop with `agent-directory-mismatch` and name both paths. Change `agentDirectory` in the file, or set `PI_CODING_AGENT_DIR` in the shell, so that the two match.

### Run setup

1. Write your configuration file outside any repository. Start from `packages/herdr/assets/config.example.json`. See [The configuration file](#the-configuration-file).
2. Save the sessions you list in `spaces`. Run `/reload` in every other open pi session, so that setup can identify it.
3. In pi, run `/herdr-setup`, or `/herdr-setup <config-file>` for a file outside the standard location. Pi prints the exact setup and doctor commands for your installation, quoted for the shell. It does not run setup itself.
4. From a plain shell, run the printed setup command. It has this form:

	```sh
	node <installed-package>/dist/herdr/cli.mjs setup --config <absolute-config-file>
	```

5. Setup lists the sessions it is waiting for. Close them, as described in [How setup opens your sessions](#how-setup-opens-your-sessions).
6. Setup opens each configured session in a fresh terminal in its space and tab, then focuses the first space. It prints `Setup verified` with the number of file writes and visible probes.
7. Run the printed doctor command to check the result.

If setup fails after it starts opening sessions, it keeps its journal and ends the error with the exact command that undoes it:

```text
Rollback: <node> <installed-package>/dist/herdr/cli.mjs rollback --config <absolute-config-file>
```

Run that command from a plain shell, or fix the cause and run setup again. See [Roll back](#roll-back).

Setup accepts these flags:

| Flag | Effect |
| --- | --- |
| `--config <absolute-file>` | The configuration file. The path must be absolute. Without it, setup uses the standard location. |
| `--overwrite-unowned-keys` | Replaces Herdr key bindings that spider does not own, after a backup. Without it, a conflicting key stops setup with `key-binding-conflict`. |
| `--allow-staging-app` | Allows setup to open a second app window when it has to clone Herdr's built-in layout and mods in a separate staging home. Setup says so before it opens the window. |
| `--adopt-existing-space <name>` | Lets setup add tabs to an existing space with this name that spider does not own. Repeat it for each space. Without it, the name conflict stops setup with `space-name-conflict`. |

### What setup changes

Setup backs up every file it replaces before the first write and records each step in a journal under `<globalRoot>/herdr/setup`. It changes these things:

1. The `herdr.config` entry in spider's global settings, only when you pass a configuration file outside the standard location.
2. The spider panel mod, plus clones of Herdr's current `agents`, `spaces`, `pane`, and `tabs` mods with spider's patches applied.
3. The `spider-glass` layout and Herdr theme. Only the `theme` and `layout` fields of the app's settings change.
4. Five key bindings in Herdr's terminal section. Other sections, including the Ctrl-V image paste binding, stay unchanged.
5. The `dracula-plus-glass` pi theme. Only the `theme` field of the agent directory's settings file changes.
6. Role templates generated from your global model settings.
7. `notes = false` in the core's `config.toml`. Only the root `notes` key changes.
8. A marked resume block in your shell rc file.
9. The remote runtime on each configured machine. Setup checks each machine's Node version with a visible probe.
10. The spaces and tabs for your sessions.
11. A private `herdr/sessions` folder under `<globalRoot>`, where each session publishes the state that the panel and the sidebar read. Rollback leaves this folder in place.

Setup owns only these parts of each file. Edits you make elsewhere in the same files are kept when setup runs again. Setup compares the parts it owns by value, so a file that was saved again with different formatting but the same values is not rewritten. If you change a part that setup owns, such as the pi theme field or the resume block, setup stops with `managed-artifact-changed` and names the recorded value. Restore that value, then run setup again.

A second run with nothing changed writes nothing, makes no backup, changes no focus, and opens no duplicate session. It still checks each machine's runtime directory, and it installs the runtime again if that directory was deleted. If setup stops partway, run it again. It resumes at the first unfinished step. If a target file changed since setup checked it, setup stops instead of overwriting your edit.

### Upgrade

After you update spider, run setup again with the same configuration file. Each runtime version is installed under a file name derived from its content, so a new version goes next to the old one instead of replacing it. Setup probes Node again on a machine whose runtime changed. When only spider's installed files change, setup does not close and reopen your sessions. Then run the doctor.

Earlier versions installed a `spider-machines` mod for a Machines panel. Setup no longer installs it or adds it to the layout, so Herdr does not load it. Setup does not delete that folder from the app's `mods` directory.

### How setup opens your sessions

Setup opens each session listed in `spaces` in a fresh terminal. It never reuses a terminal that held an earlier session. It starts pi there with `PI_CODING_AGENT_DIR` set to the configured `agentDirectory`, so the session uses that directory even when the terminal's shell has a different setting. Before setup opens anything, it waits until no process holds the selected session files. It waits for two kinds of process:

- A pi session that is one of the selected sessions. Setup prints `Close selected session <name>; PIDs: <list>`. Let its work finish or cancel it, then close it.
- A pi process with no record. Setup prints `Unrecorded pi PID <pid>: /reload in that session, or closing it, clears this block.` Every pi session that loads spider records itself when it starts or reloads, whether or not the integration is on.

Sessions that you did not select and that have a record can stay open. When `spaces` is empty, setup does not wait for any process.

Setup waits up to 30 minutes, then stops with `cutover-deadline`. Close the listed sessions and run setup again.

A session that was started with explicit `--extension` arguments cannot be opened by setup, because setup never replays them. Setup stops with `session-explicit-extensions`. Start that session by hand instead.

A new tab can briefly show a temporary name until pi starts in it. If setup loses track of a session it was opening, it stops with `cutover-reconciliation-required` and does not open the session again. Do not open it by hand. Run setup again. It checks the tabs it created and the live session owners, then retries only after it proves the earlier attempt finished or opened nothing.

### Roll back

To undo the installed files, run:

```sh
node <installed-package>/dist/herdr/cli.mjs rollback --config <absolute-config-file>
```

Rollback exits with 0 when it restored everything, 3 when some parts stay unrestored, 1 for any other failure, and 2 for a usage error. Setup and the doctor use the same codes, except 3. Rollback undoes only the parts that setup owns, and closes the tabs that setup created. Edits you made elsewhere in the same files stay. If you changed a part that setup owns, rollback leaves that file as it is and prints `<file> not restored:` with the reason. Repair that part, then run rollback again. Close the pi sessions in the tabs first, or rollback stops with `cutover-owner-live`. It never closes a terminal it did not create. It prints `Rollback restored <n> matching files`.

Like setup, rollback stops with `agent-directory-mismatch` when the configured `agentDirectory` differs from the shell's pi agent directory. It also stops with `global-root-mismatch` when the configured `globalRoot` differs from pi's.

Without `--config`, rollback and the doctor use the same file as setup. See [Where the configuration file lives](#where-the-configuration-file-lives).

## The configuration file

The file is JSON. Every path must be absolute. Session, space, and machine names come only from this file, so keep it outside any repository.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `"auto"` | `"auto"`, `true`, or `false`. The host setting `herdr.enabled` overrides it. |
| `app.binary`, `app.home` | Required | The `herdr-app` binary and its home directory. |
| `core.binary`, `core.config` | Required | The `hc` binary and the core's `config.toml`. |
| `agentDirectory` | Required | The pi agent directory. It gets the pi theme, sessions start with it, and it must match the shell's pi agent directory. |
| `globalRoot` | Required | Spider's global directory, which must match the one pi uses. Feeds, jobs, and setup journals live in its `herdr` folder. |
| `shellRc` | Required | The bash or zsh rc file that gets the resume block. |
| `spaces` | Required | Ordered spaces. See [Spaces](#spaces). |
| `machines` | Required | Remote machines. See [Machines](#machines). |
| `fonts.body`, `fonts.label`, `fonts.paths` | Bundled body and label fonts, and Herdr's path font | Optional replacement fonts. Each has a `path` and a `license` file. |
| `limits.auxiliaryPanes` | `2` | Auxiliary pane slots per tab, from 1 to 6. |
| `limits.completedRows` | `50` | Finished rows kept per session in the sidebar. |
| `limits.completedHours` | `24` | Hours a finished row stays in the sidebar. |
| `retention.foregroundDays` | `7` | Days to keep logs and journals of finished foreground jobs. |
| `admin.wrappers` | `[]` | Reviewed wrapper programs for the admin command. Each entry is `{ "path": "<absolute file>", "sha256": "<digest>" }`. See [The admin command](#the-admin-command). |

### Spaces

Each space has a `name` and an ordered `sessions` list. A session selector is one of these:

- `{ "file": "<absolute session file>" }`, the exact session file.
- `{ "name": "<session name>" }`, the session's latest name.
- `{ "name": "<session name>", "sessionId": "<id>" }`, required when two sessions share a name.

Setup checks every selector before it writes anything. An ambiguous name stops setup with `session-selector-ambiguous`. A name that matches no session stops it with `session-selector-missing`. Name lookup reads only the end of each session file, so use a `file` selector for a session whose name was set long ago. Several sessions can share a repository and working directory. Each session opens in its last known live working directory, or else the working directory recorded in its session file.

### Machines

Each machine has these keys:

| Key | Meaning |
| --- | --- |
| `name` | The exact `hc` machine name. This is the value you pass as `on`. |
| `aliases` | Other names for the machine. The SSH rule refuses these too. |
| `nodePath` | Optional absolute Node path on the machine. Without it, spider uses `node` from the machine's `PATH`. |
| `runtime.directory` | A private absolute directory on the machine for consoles and job files. Setup installs the runtime file in its parent directory. |
| `runtime.cwd` | The working directory for remote commands, or `null`. With `null`, commands start in the machine's home directory. |
| `runtime.commands` | Interpreter commands by language, such as `"shell": ["/bin/sh"]`. |

Spider ignores other keys in a machine entry.

## Run commands on a remote machine

Pass `on` to `spider exec`, `exec_file`, or `batch`:

```text
spider exec language:"shell" on:"build-box" code:"make test"
```

`build-box` stands for one of your configured machine names. Without `on`, execution is local and unchanged.

The first time setup runs, it installs a small Node runtime on each machine. Every remote command starts through that runtime as its own `hc` job. No pane opens for it, and the command does not wait for free space in the tab. Before the runtime releases the command, spider confirms that the job's labelled terminal exists. If that takes more than 10 seconds, spider removes the job without running it.

Before each launch, spider checks that the machine has the runtime that matches this version of spider. If the runtime is missing or outdated, the call fails with `runtime-not-installed` before anything runs. Run setup again to install it.

These rules apply to `on`:

- The name must match a configured machine exactly. An unknown name, a failed connection, or an inactive integration never falls back to local execution.
- A `batch` takes one top-level `on` for every entry. An `on` inside an entry is rejected with `batch-entry-on`.
- With `exec_file`, `path` names a file on the remote machine. Your code runs there with `FILE_CONTENT` and `FILE_CONTENT_PATH` bound, as it does locally. A relative path needs a configured `runtime.cwd`, or the call fails with `remote-cwd-required`.
- A language with no entry in the machine's `runtime.commands` fails before launch with `remote-language-unsupported`. Spider never uses a local interpreter instead.

Output works as it does locally. Stdout and stderr stay separate, stdin is empty, and the model sees at most 10,000 bytes with secrets scrubbed. The complete output goes to private log files, which you can analyze with later calls. The result keeps the real exit code, and its details add the job ID, machine, terminal address, and receipt paths. A foreground command that writes more than 100 MiB is cancelled with `output-cap-exceeded`. The bytes it wrote stay in the logs.

### Agent consoles

Each session and each subagent run gets one console on each machine it uses. The first remote command creates it, and later commands reuse it. Its title is `<agent name> · <machine>`, where the agent name is the session name or the run's display name. A console opens no pane by default. It appears in the left sidebar under its agent.

The console shows each command's header, its stdout, its stderr with a label, and its exit code. When commands run at the same time, each line has a prefix for its job. A console cannot run commands or cancel jobs, and closing its pane leaves the jobs running.

A subagent's consoles close when its run ends. A session's consoles close when you quit the session or replace it with `/new`, `/resume`, or a fork. `/reload` keeps them open. If a session crashes, its consoles stay until a pi session next starts without a reload. That start removes session consoles whose owner is gone.

### Background jobs and timeouts

`timeout` is the time in milliseconds that the call waits:

- Without `background`, an expired timeout cancels the remote job and the result has `timedOut:true`. A command that traps the hangup and exits 0 still counts as timed out.
- With `background:true`, capture is durable from launch. An expired timeout detaches the job and returns `exitCode:null` with a `backgroundJob` receipt. `exitCode:null` means the outcome is not known yet.
- With `background:true` and no `timeout`, the call waits for the real exit.

Aborting a call cancels its remote job. Aborting a batch stops the current entry and skips the rest. Closing a pane never cancels a job.

A detached job keeps running after the call returns. When it finishes, spider posts a `spider.job_done` message to the owning session, at most once. The message has the job ID, machine, terminal address, outcome, a short scrubbed output summary, and receipt paths. Spider writes the result to disk before it posts the message, and it never delivers the message through terminal input.

If you close pi, a detached job keeps running and keeps writing logs on the machine. The next time the session starts, spider collects the missing output and posts any notice it has not posted before. It never reruns a job to recover a result. If the evidence is missing or conflicts, the outcome is reported as unknown, not as exit 0.

### Remote commands from subagents

Subagents, and their own children, can pass `on` too. Each child runs the command through its own `hc` connection and gets its own tool result. Nothing is sent back to the parent to run. The child's jobs and consoles belong to the top-level session and carry the child's run ID and name.

When a child run ends, the top-level session takes over the child's unfinished jobs. It stops foreground commands that the child left behind and lets background commands finish. Their notices name the run and are posted at most once, across reloads.

A child finds the configuration file the same way as its session. See [Where the configuration file lives](#where-the-configuration-file-lives). If the child cannot start the integration, it keeps the SSH rule it inherited from its parent. Only `herdr.enabled` set to `false` for the child turns that rule off.

## The left sidebar

The left sidebar is Herdr's agents list, extended by setup. It lists each live pi session. Under a session, it lists the session's subagent runs by display name and the session's consoles. Under a run, it lists that run's consoles. Expand a console to see its live commands. A finished command leaves the list, and finished runs stay for `limits.completedHours`, up to `limits.completedRows` rows.

Thin thread lines join each row to its parent, so you can see how deep a row sits. An icon shows the row's kind: a terminal for a session, a robot for a subagent run, a list for a console, and a server for a command on a machine. A finished run shows a check. A command leaves the list when it finishes, and a failed command appears in the spider panel.

Clicking a row opens it:

- A session row focuses that session's agent pane.
- A run row shows the run's viewer.
- A console row shows that agent's command history on the machine.
- A command row opens an observer for that one job.

Two filter chips sit above the list. Use them to show one machine or one agent. The filters apply to the rows under each session. Session rows always stay. Choose **All machines** or **All agents**, or click the x on a chip, to clear its filter. When the sidebar is collapsed to its rail and a filter is set, the rail shows **Clear**. Each installed copy of the sidebar keeps its own choices.

### Machines

The **Machines** section sits under the agents list. It lists every configured machine, for all spaces, with a server icon and the machine name. The row shows only the machine's status:

- Connected: no mark.
- Disconnected: a red x.
- Stopped, connecting, or unknown to Herdr: the row is dimmed.

Spider reads Herdr's machine list when the sidebar starts and every 15 seconds after that. Click a machine to filter the agents list to that machine's jobs. Click it again to clear the filter. The section is hidden when the sidebar is collapsed.

### Panes

Each tab has an auxiliary strip next to the agent pane, with `limits.auxiliaryPanes` slots (2 by default). Your main agent panes always stay visible. Spider never parks, moves, resizes, or hides them.

Subagent viewers fill free slots on their own. When the strip is full, a new viewer stays parked, and its run keeps working and stays in the sidebar. Spider never closes a displayed pane to make room for an automatic viewer. Consoles and command observers open only when you click them.

When you open an item from the sidebar or the spider panel, spider does one of these things:

1. If the item is already displayed in any tab, spider focuses it.
2. Otherwise, if the strip has a free slot, spider shows the item there and focuses it.
3. Otherwise, spider opens the item in a new tab named after it, and focuses that tab.

Closing an auxiliary pane frees its slot. When a command finishes, its observer keeps the saved output and shows `Finished, exit <code>. Close this pane when done.` until you close it. If the core goes away first, the observer shows `Disconnected. Close this pane when done.`

Each viewer, console, and observer pane has a header with its name, its parent agent as a pill, and its working directory. A long directory is shortened in the middle, and the full path shows on hover. A viewer's header also shows **Can steer** for an RPC child, or **Read-only** for any other run.

Closing a viewer, console, or observer, or the tab that holds it, never cancels a job or a run. To stop a remote command, abort the call or let its timeout expire.

## Raw SSH

Inside Herdr, managed machines are reached through `on`. Plain `ssh` to a configured machine or alias is refused with `Raw SSH to a managed machine is unavailable; use spider exec with on:<machine>`, where `<machine>` is the configured name. The same check refuses `scp`, `sftp`, `rsync` over SSH, and `git` over SSH to a configured machine, with a message that also names the audited admin route.

The check covers shell `exec`, `exec_file`, every `batch` entry, the built-in bash tool, and `!` commands typed in pi. A shim on `PATH` covers `ssh` started from other programs. Other hosts pass through unchanged to the first `ssh` on your `PATH` after the shim. Subagents follow the same rule as their parent, and machine names match without regard to case. Ordinary shell commands still work in subagents.

A `git` command that names no remote, such as `git status`, runs even when `GIT_SSH_COMMAND` is set. For a command that reaches a remote over SSH, spider checks the destination it connects to. An SSH override in `GIT_SSH_COMMAND`, `core.sshCommand`, or `rsync -e` must run `ssh`. Any other transport program is refused.

The machine list refreshes every 30 seconds and is valid for 120 seconds. If no valid list is available, all raw SSH is refused. This is a routing rule for agents, not a security boundary. An absolute-path `ssh` inside another program, a shell function, or a replaced environment can bypass it.

### The admin command

Some repairs need a real SSH connection, for example when `hc` itself is broken on a machine. For those, use the packaged admin command:

```sh
node <installed-package>/dist/herdr/cli.mjs admin \
  --session-id <current-session-id> \
  --wrapper <absolute-wrapper-path> \
  --reason "Repair the machine's hc installation" \
  --destination build-box -- uname -a
```

A subagent can leave out `--session-id`, because it inherits `PI_SPIDER_SESSION_ID`. A top-level session passes its own session ID. The command takes no `--config`. It reads the wrappers and machines from the configuration file that the global settings select, as described in [Where the configuration file lives](#where-the-configuration-file-lives). Because it does not ask `hc`, it works when `hc` is unhealthy or the machine list is unavailable. It passes the wrapper's stdin, stdout, stderr, and exit code through unchanged.

The wrapper must be listed in `admin.wrappers` with its path and SHA-256 digest:

```json
{
  "admin": {
    "wrappers": [
      { "path": "/path/to/reviewed-admin-wrapper", "sha256": "<64 lowercase hexadecimal characters>" }
    ]
  }
}
```

An entry with only a path is rejected. If the file is readable, the error prints its current SHA-256. Review the file before you copy that digest into the entry. The zero digest in the example configuration is a placeholder, not an approval. If you edit the wrapper, review it again and update the digest.

The wrapper receives the destination first, followed by the arguments after `--`. A wrapper that only runs SSH can be this:

```sh
#!/bin/sh
exec ssh "$@"
```

The reason must not be blank, must be at most 2,048 characters, and must contain no control characters. The destination must be a configured machine or alias. Otherwise the command fails with `admin-not-authorized`. Each approved use is appended to `<globalRoot>/herdr/admin/audit.jsonl` before the wrapper starts. A row records the time in `at`, the wrapper's arguments in `argv`, the admin process ID in `pid`, the session, the wrapper path and digest, the reason, and the destination. If the audit log cannot be written, the command refuses to run.

The admin command creates a one-time token file for each use, passes the token to the wrapper in `SPIDER_HERDR_SSH_BYPASS`, and deletes the file when the wrapper exits. The SSH shim lets a managed destination through only while that file exists, and only for 60 seconds after the admin command creates it. An SSH connection that is already running is not affected when the token expires. Setting the variable yourself authorizes nothing. While the integration is on, spider refuses any `exec`, `exec_file`, `batch`, or bash call whose code or file sets or exports `SPIDER_HERDR_SSH_BYPASS`. A call that only reads or mentions the name runs. A wrapper that starts anything other than the SSH transport, or another agent, must clear the variable first.

## Watch and steer subagents

Each subagent run that a session dispatches gets a viewer terminal, parented to the session's agent pane. The viewer shows the run's text, tool activity, escalations, and final result. It strips terminal control sequences, so a transcript cannot change your terminal.

The viewer has its own message box. Press Enter to send the text to the running child as a steer through the owning session. The viewer shows the real reply: delivered, accepted but not confirmed, consumed by an extension, refused, or delivery unknown. It does not resend a steer whose delivery is unknown.

Only a running RPC child with a live pipe accepts a steer. For a queued, paused, finished, cancelled, failed, or print-mode run, the viewer explains why the box is disabled. Blank text, text that starts with `/`, and text over 16 KiB are refused.

When the owning session quits, or its terminal closes, the viewer stays open and prints `Owning session closed. Saved log is read-only.` You can read the log but not steer. Close the viewer when you are done. During a reload, the viewer shows `[reconnecting]` and keeps its text, cursor, and draft. If the owning session stops updating its feed or is replaced, and stays that way for 30 seconds, the viewer prints `Owning session unavailable for 30 seconds. Saved log is read-only.` and stays open. If the owning session's feed file is gone for 30 seconds, the viewer closes.

A viewer opens on its own once for each unfinished run. Spider does not automatically open a viewer for an already-finished run. If you close a viewer, later events from that run do not open it again. Open it from the sidebar instead.

While the owning session is live, a viewer closes when its run finishes, fails, or is cancelled. It shows `This run is <status>.` and holds the final output for 2 seconds before closing. An automatic viewer that attaches after the run ends closes the same way. A viewer you open while the run is unfinished also closes when the run ends. Focusing an existing automatic viewer does not keep it open after completion.

Owner quit and replacement are exceptions. Those viewers stay open and read-only as described above, even when shutdown cancels the run. During `/reload`, the viewer reconnects.

Opening an already-finished, failed, or cancelled run from the sidebar or the spider panel opens a saved read-only view until you close it. If the live viewer is still closing, spider waits for it to exit before opening the saved view. Viewers never start another subagent and never change how a child runs. Opening or closing a viewer does not change the agent pane.

`hc` accepts only simple names for terminals. Spider names each viewer `run-<hash>`, each observer `obs-<hash>`, and each console `console-<hash>`, and keeps the readable name in the `spider.display-name` label. The sidebar, the pane headers, and the panel show the readable name.

## Use the spider panel

The panel is hidden by default. Click **Spider** next to **Files** and **Changes** at the top right to show it, and click it again to hide it. Herdr remembers the open panel for each space. The dock opens at 368 pixels wide and resizes from 280 to 900 pixels.

The panel shows the space that is selected in the sidebar. It has three parts: the notification list, the sessions, and the month bar. When something goes wrong, a problems group appears above the notifications.

### Notifications

A bell heads the panel, with the number of items that need you. Under it, one row describes each item in words, with the agent and the machine as small pills and a command as inline code. The list can hold these items:

- `<agent> is waiting`: a live session waits for you. The row does not show the question.
- `<agent> failed`: a live session reports an error, or a subagent run failed in the last 24 hours.
- ``<agent> `<command>` failed on <machine>``: a remote command failed in the last 24 hours. The exit code is in the command's output, not in the row.
- `<machine> <state>`: a configured machine is not connected. The state is Herdr's word for it, such as `stopped`, or `unreachable` when Herdr does not list the machine.
- `<n> memories to review`: memory candidates wait for approval.
- `Over budget pace`: the projected month total exceeds `usage.monthlyBudget`.

The whole row is the button. Click it, or move to it with Tab and press Enter or Space. A waiting or failed session focuses that session's agent pane. A failed run opens its viewer. A failed command focuses its output pane if that pane is still open. Otherwise the session that ran it opens the command's output in a free pane, or in a new tab when the layout is full. When that session is not live, the row is disabled. The memory row opens memory review in pi, and the budget row opens usage. A machine row has no action. The panel opens views through the owning session and never types into a pi editor.

### Sessions

The **Sessions** list has one row per session in the space. A session that has no tab in any space appears in every space. A row shows a terminal icon, the session name, small counts for live subagents and open todos, and the session's credits this month in the **Credits** column. The word `unavailable` means spider could not read the session's credits. While spider refreshes the figure, the row keeps showing the previous one. The row shows no status, because the sidebar shows it. A session that is not live has a dimmed name, and its tooltip names the state. A session whose feed is older than 10 seconds counts as disconnected.

Click the terminal icon to focus the session. Click anywhere else on the row to expand it. An expanded row shows up to five open todos, a **+N more** link when there are more, the session's loop and schedule triggers with their next run time, and an **All todos, runs and usage** link that opens spider's todos view in that session.

When the panel reads the session folder and finds no feeds, it says `No live sessions` and offers **Run doctor**. If it could not read the folder, the list says `Spider couldn't read the session feeds, so sessions may be missing here.`, shows the technical reason below it, and offers **Run doctor**. If every feed it found was skipped, the list says `Spider couldn't read any session feed.`

### Problems

Problems that do not stop the panel appear in one group at the top, above the notifications. Each row has a red cross and a sentence, for example `Spider skipped a session feed larger than 1 MB.` or `The run's output didn't open. Its pi session isn't reachable.` The technical reason is in the row's tooltip. Repeated problems appear once, and skipped feeds of the same kind are counted in one row. The group shows three rows; click **+N more** to show the rest and **Show fewer** to fold them again. If doctor takes longer than 30 seconds, its row gives the doctor command to run in a shell.

The panel reports these problems:

- A session feed that is a link or a special file, larger than 1 MB, not valid, or unreadable. Spider skips it.
- Feeds that together exceed what the panel reads at once. Spider hides the oldest sessions first.
- A lost watch on the session folder. The panel then rereads the feeds every 8 seconds.
- Herdr notices that could not be posted, and notice actions that did not run.
- A run view, command output, memory review or spider view that did not open.
- A doctor run that took longer than 30 seconds.

An expanded session row also lists that session's own problems, such as `Spider can't read this session's commands.`

### When the panel can't start

The panel needs absolute paths in its layout entry, which setup writes. If they are missing or not absolute, the panel shows only `Spider panel can't start`, a sentence that says what is wrong, and the fix: in pi, run `/herdr-setup`, then run the doctor command it prints. A muted line below names the layout props that are missing or not absolute. The panel then shows no sessions, notifications, month bar or **Run doctor** button, because none of them can work without those paths.

### The month bar

A slim bar at the bottom of the panel shows the month's credits: the month name, a track, and the amount used. When `usage.monthlyBudget` is set, the track fills to the share of the budget used, hatching shows the projection to month end, and a thin mark shows today. If the projection exceeds the budget, the fill turns red. Without a budget, the track stays empty. Hover over the bar to see the used amount, when the numbers were updated, and, with a budget, the projected, budget, and remaining amounts and whether you are on pace. Without a budget, the details say `No budget set, so no pace`. When usage data is missing, the bar says `Usage unavailable` and draws no track.

### Herdr notices

The panel also posts a Herdr notice once for a subagent result, an escalation, a finished job, and each budget threshold: 80 percent used, 100 percent used, and a projected overrun. A session notice focuses its session. A budget notice opens usage.

## The look

Setup installs a layout named `spider-glass` and a pi theme named `dracula-plus-glass`:

- Surfaces are neutral black `#161618`. Text panes, the spider panel, and menus use it at 94 percent opacity.
- Hover, selected, and raised fills are white at 7, 8, and 11 percent.
- Panes have a 12-pixel radius and an 8-pixel gap, with no borders or focus outlines.
- Herdr's window chrome uses neutral greys. Its only accent colours are red and amber, and they mark states, such as a failure or a session that waits for you.
- The terminal palette and the pi theme are Dracula+. Pi's boxes use opaque neutral greys, because pi themes have no alpha.
- Herdr's UI text uses the bundled Google Sans Flex. Paths, names, and numbers in spider's views use Herdr's bundled JetBrains Mono. Your terminal font does not change.

The window ground copies the Firefox Liquid Fox glass: its 176-degree window tint over its inactive-window fill `rgb(24, 24, 26)`, a gradient from `#18181a` to `#22201e`. Herdr's window is opaque and has no backdrop blur, so no desktop shows through. A transparent layout background shows the theme background instead. The chrome and sidebar are transparent over this ground, as Firefox's toolbars are.

## Shortcuts

Setup adds five keys to Herdr's terminal section. Each sends a key event that pi handles with the same handler as the matching spider command:

| Herdr key | Pi shortcut | Opens |
| --- | --- | --- |
| Cmd-Shift-A | `ctrl+shift+a` | Agents |
| Cmd-Shift-O | `ctrl+shift+o` | Todos |
| Cmd-Shift-U | `ctrl+shift+u` | Usage |
| Cmd-Shift-M | `ctrl+shift+m` | Pending memory approvals |
| Cmd-Shift-K | `ctrl+shift+k` | Upcoming triggers |

The keys leave your draft and cursor unchanged. Ctrl-V image paste and pi's `ctrl+shift+f` search still work. Inside pi's tree view, `ctrl+shift+o` also cycles the tree filter backward. If pi rejects one of these keys, spider shows a collision warning at session start. If a view cannot open, for example because the session has no interactive UI, pi shows `Could not open spider <view>` with the reason. Run `/hotkeys` to see the current bindings.

## Role templates

Setup writes three `hc` templates: `spider-worker`, `spider-reviewer`, and `spider-watcher`. Each starts a visible, interactive pi session with an explicit provider-qualified `--model` and a `--thinking` level. The models come from the global `models.defaults` for each role. Project settings never change these shared templates. A role you have not configured uses spider's built-in role policy. During setup, a configured model that is not available stops setup with `role-unresolved` before any template is written.

Each pi session that starts inside Herdr regenerates the templates from the current global settings and skips files that have not changed. If a configured model is not available then, spider shows a warning and leaves that role's template out.

To start a worker, run:

```sh
hc run --bg --no-notify spider-worker
```

Do not pass a task argument. `hc` would paste it into the new pi editor. Give the session work through `spider message`, intercom, or by typing in its editor. Each role's instructions ask it to stay in scope, not to start nested subagents unless told to, and to report through spider messages or intercom.

## Resume after a restart

Spider records which session runs in each Herdr terminal. When the `hc` core restarts and restores a shell, the resume block in your rc file prints the saved session name and defines a `spider_resume` function:

```text
Resume <name>: run spider_resume (or keep this shell).
```

If the resume hook, the Node binary, or the CLI that setup recorded is missing, the block does nothing and the shell starts without an error.

Run `spider_resume` to start `pi --session <exact file>` in the saved working directory, with `PI_CODING_AGENT_DIR` set to the configured `agentDirectory`. Ignore it to keep a normal shell. Spider never types or starts pi on its own. It offers a resume only after a proved core restart, and only when no other process holds the session file. It never uses `--continue` and never changes the session name or model.

## Troubleshooting

Run the doctor from a plain shell:

```sh
node <installed-package>/dist/herdr/cli.mjs doctor --config <absolute-config-file>
```

Without `--config`, the doctor uses the global `herdr.config` setting or the standard location. The doctor prints each failure or warning as a code, a message, and a `Repair:` line. A check that it cannot run is a warning with an `unavailable` code, not a pass. When there are warnings, it prints a summary of passed, unavailable, and failed checks. When there are no warnings and no failures, it prints `Doctor checks passed`. It exits 1 if any check failed, and 0 otherwise. The doctor never restarts a core, changes the layout, sends terminal input, or edits a user database. It checks Node on each machine with a visible probe every time, and checks each machine's runtime directory. It also checks that the Node binaries that setup recorded for the resume block, the cutover, and the mods still exist and are supported.

The spider panel's **Run doctor** button runs the same command.

| Code | Cause | Fix |
| --- | --- | --- |
| `herdr-disabled` | A call passed `on` while the integration is off. | Start pi inside Herdr with a running core and a configuration file. |
| `core-unavailable` | The `hc` core is not running. Spider does not start it. | Start the core yourself, then retry. If it stopped during a session, wait for `Herdr core is back. /reload to reconnect.`, then run `/reload` in that session. |
| `global-root-mismatch` | The configuration's `globalRoot` differs from the spider global root. | Set `globalRoot` to the path that the message names, then run setup or the doctor again. |
| `agent-directory-mismatch` | The configuration's `agentDirectory` differs from the pi agent directory of the shell that runs setup or rollback. | Change `agentDirectory` to the path that the message names, or set `PI_CODING_AGENT_DIR` in the shell to the configured path. |
| `pinned-node-unavailable` | A Node binary that setup recorded is missing or unsupported. | Restore a supported Node at that path, or run setup again from a plain shell with a supported Node. |
| `remote-node-unavailable` | A machine has no Node or a version below 22.18.0. | Set an absolute `nodePath` for the machine, or install Node `>=22.18.0` on its `PATH`. |
| `runtime-root-invalid` | A machine's runtime directory is missing, is not a private directory owned by you, or the runtime cannot run there. | Fix the directory's owner and mode, then run setup again. |
| `runtime-not-installed` | A remote call found the machine's runtime missing or outdated. | Run setup again. |
| `native-notes-enabled` | The core's root `notes` key is not exactly `false`. | Fix the root `notes` key, then run setup again from a plain shell. |
| `launch-notify-enabled` | A spider `hc run` omitted `--no-notify`. | Report it. Every spider launch must pass `--no-notify`. |
| `key-binding-conflict` | A Herdr key is bound to something spider does not own. | Change the binding, or run setup with `--overwrite-unowned-keys`. |
| `managed-artifact-changed` | A part of a file that setup owns was edited. | Restore the recorded value that the message names, then run setup again. |
| `role-unresolved` | A configured role model is not available. | Fix that role in `models.defaults`, or sign in to its provider. |
| `catalog-unavailable` | No eligible models exist. | Sign in to a provider, then run setup again. |
| `setup-locked` | Another setup is running, or an earlier one stopped while it held the lock. | Wait for it to finish. If none is running, follow the message to inspect the lock. |
| `feed-directory-owner-mismatch` | `<globalRoot>/herdr` or its `sessions` folder is a link, is not a folder, or belongs to another user. | Replace it with a folder that you own, with mode 0700, then run setup again. |
| `session-selector-ambiguous` | Two sessions share a configured name. | Add `sessionId` to the selector. |
| `session-selector-missing` | No session matches a configured selector. | Fix the name, ID, or file in `spaces`. |
| `session-explicit-extensions` | A selected session was started with explicit `--extension` arguments. | Start that session by hand. |
| `space-name-conflict` | A space with a configured name exists and spider does not own it. | Rename it, or pass `--adopt-existing-space <name>`. |
| `cutover-deadline` | The sessions that setup needs stayed open for 30 minutes. | Close the listed sessions, then run setup again. |
| `cutover-reconciliation-required` | Setup lost track of a session it was opening, so it cannot tell whether that session started. | Do not open the session by hand. Run setup again. It retries only after it verifies the earlier result or proves that nothing started. |
| `status-instance-unavailable` | No live pi session answered the status check, or pi's status method had an unexpected shape. | Start or `/reload` a pi session inside Herdr, then run the doctor again. If it persists, check that pi is version `1.2.0`. |
| `remote-cwd-required` | `exec_file` got a relative path, and the machine has no `runtime.cwd`. | Pass an absolute path, or set `runtime.cwd`. |
| `remote-language-unsupported` | The machine's `runtime.commands` has no entry for the language. | Add the interpreter to `runtime.commands`. |
| `admin-not-authorized` | The admin command got an unlisted wrapper, a changed wrapper, a bad reason, or a destination that is not a managed machine. | Check the wrapper's entry and digest in `admin.wrappers`, the reason, and the destination. |

Other symptoms:

| Symptom | Cause and fix |
| --- | --- |
| A remote call fails with `release-timeout`, or with a spawn error that says `Payload release deadline expired`. | Spider could not confirm the job's terminal within 10 seconds, so the command never ran. Check that the core and the machine are healthy, then retry. |
| Setup lists process IDs and waits. | These pi processes hold session files that setup needs, or have no record. Run `/reload` in an unrecorded session, or close it. Close each selected session. |
| A panel session name is dimmed. | The session is not live. Its feed is older than 10 seconds, or the session closed. The tooltip names the state. |
| Status shows working with no visible activity. | The session has queued, running, or paused subagents. Open the agents list with Cmd-Shift-A. |
| Pi shows `Herdr unavailable: <reason>` or `Herdr activation failed: <reason>`. | The integration did not start. The reason names the cause. See [Turn the integration on or off](#turn-the-integration-on-or-off). |
| Pi shows `Herdr core is back. /reload to reconnect.` | The core stopped and is running again. Spider does not reconnect on its own. Run `/reload` in the session. |
| Pi shows `this session's Herdr terminal belongs to a core that is no longer running`. | A new core replaced the session's core. Start the session again in a Herdr terminal. |
| Pi or the CLI warns `herdr.config in <file> is ignored: global scope only`, or the same for `herdr.enabled`. | A repository's settings set a global-only key. Move the value to the global `config.json`, and delete it from the repository file. |
