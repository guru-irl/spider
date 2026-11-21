# Herdr integration

Herdr is a terminal workspace with two parts: the `hc` core, which owns terminals and remote machines, and `herdr-app`, the window that shows them. When pi runs inside a Herdr terminal, spider shows its work in that window. Remote commands, subagent views, and job results appear under the pi session that owns them, and spider never types into the pi editor.

The integration is optional. Outside Herdr, spider runs as ordinary spider.

This guide covers setup, each feature, the configuration file, and troubleshooting. The code lives in `packages/herdr`. See [packages/herdr/README.md](../../packages/herdr/README.md) for the module map.

## What the integration adds

Spider keeps the session's Herdr status at `working` while its subagents are queued, running, or paused.

`spider exec`, `exec_file`, and `batch` take an `on` machine name. The command runs on that machine, and the full output comes back to pi. Each agent gets one console per machine that shows its commands. A remote job that finishes after its tool call returns posts a `spider.job_done` message to the owning session, at most once.

Plain `ssh` and other SSH transports to a configured machine are refused, with a pointer to `on`. An audited admin command covers the cases that need a real SSH connection.

The left sidebar lists your sessions with their subagent runs, consoles, and live commands. Each subagent run gets a viewer with its own message box for steering.

The spider panel shows, for the selected space, what needs your attention, each session's todos, triggers, and credits this month, and the month's credit pace.

Setup opens each space in one named tab with your sessions as panes. After the core restarts, each restored shell offers to resume its saved session or resumes it automatically when configured.

Setup also writes `hc` templates that start visible worker, reviewer, and watcher pi sessions. It installs a neutral black glass layout, a Dracula+ pi theme, two bundled fonts, and five Herdr keys that open spider views in pi without touching your draft.

## Requirements

- Node.js `>=22.19.0` on the local machine, and Node.js `>=22.18.0` on every remote machine you use with `on`.
- Pi `1.2.0`.
- `hc` `0.1.16` and `0.1.17`, with `herdr-app` `0.1.12`, `0.1.13` or `0.1.16`. Setup verifies the complete built-in mod sources against that release's inventory. A matching version string alone does not admit an edited or relabelled app.
- macOS or Linux. A Linux machine reached from macOS is supported. On other platforms, the doctor reports a failure instead of falling back to local execution.

The automated app stories use `hc` 0.1.16. Compatibility tests cover the 0.1.17 event snapshot and notification policy.

Herdr 0.1.12 changes its mod API to string-only target ids and `watch()` root-path batches. Spider's mods already pass Herdr's own string ids and reload on any batch, so they need no change.

Each remote machine must already be configured in `hc`. Spider validates machines but never adds or restarts them. To use a Node binary that is not on the remote `PATH`, set `nodePath` for that machine.

## Turn the integration on or off

The host setting `herdr.enabled` controls the integration. It accepts `"auto"`, `true`, or `false`, and it defaults to `"auto"`. It is a global-only setting, like `herdr.config`. See [Where the configuration file lives](#where-the-configuration-file-lives).

- With `"auto"`, the integration starts only when pi runs inside a Herdr terminal, a configuration file exists, and the `hc` core is running.
- With `true`, the integration starts whenever pi runs inside a Herdr terminal and a configuration file exists. If it cannot start, spider reports an error.
- With `false`, spider does not read the configuration file and runs as ordinary spider.

When the integration does not start, spider continues as ordinary spider and explains the problem once per session. With `"auto"`, it shows a warning. With `true`, it shows an error. Without a UI, spider prints the message to stderr. With `"auto"`, a session outside Herdr with no configuration file shows nothing. With `false`, spider shows nothing.

While the integration is off, a call with `on` explains that Herdr is off. The command never runs locally instead.

Spider never starts or restarts a Herdr core. It checks that the core's socket accepts a connection before each `hc` call. If the core is down, the call fails with `core-unavailable` and `hc` is not started.

### When the core stops during a session

If the core stops during a session, spider switches that session to ordinary spider. It removes the SSH rule and its shim, stops the session feed, and shows this warning once:

```text
Herdr stopped responding, so the sidebar and panes can't follow this session for now. Everything else in spider still works. Run /reload once Herdr is running again.
```

Calls with `on` then fail. Spider checks for the core every 2 seconds, but it does not reconnect on its own. When the same core is running again, spider shows `Herdr is running again. Run /reload to reconnect this session to the sidebar and panes.` Run `/reload` in the session to turn the integration back on.

If a different core replaced the one that the session's terminal belonged to, that terminal no longer exists in Herdr. The session stays inactive and shows this notice once:

```text
This session's Herdr pane belongs to a Herdr instance that has stopped. Close this session and open a new session in Herdr.
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
Spider ignores the repository's herdr.config setting. Move it to the global spider settings if you want to use it.
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

5. Setup lists any sessions it is waiting for. Close those sessions, as described in [How setup opens your sessions](#how-setup-opens-your-sessions). A rerun keeps verified live sessions open.
6. On the first run, setup opens each configured session in its space and focuses the first space. It prints `Setup verified` with the number of file writes and visible probes.
7. Run the printed doctor command to check the result.

If setup fails after it records work, it keeps its journal and prints a rollback command. When an upgrade checkpoint exists, the command undoes that upgrade:

```text
Rollback: <node> <installed-package>/dist/herdr/cli.mjs rollback --undo-upgrade --config <absolute-config-file>
```

Run that command from a plain shell, or fix the cause and run setup again. See [Undo an upgrade](#undo-an-upgrade). Without a checkpoint, the printed command uses full rollback instead.

Setup accepts these flags:

| Flag | Effect |
| --- | --- |
| `--config <absolute-file>` | The configuration file. The path must be absolute. Without it, setup uses the standard location. |
| `--overwrite-unowned-keys` | Replaces Herdr key bindings that spider does not own, after a backup. Without it, a conflicting key stops setup with `key-binding-conflict`. |
| `--merge-native-keys` | Accepts a pending native-key offer. Herdr 0.1.13 supports Cmd-F search and Cmd-M minimize. Herdr 0.1.16 also supports Cmd-A select all. Setup skips a key bound in any section. |
| `--decline-native-keys` | Declines the offer. This is the default when neither flag is passed. It does not remove keys accepted earlier. |
| `--allow-staging-app` | Allows setup to open a second app window when it has to clone Herdr's built-in layout and mods in a separate staging home. Setup says so before it opens the window. |
| `--adopt-existing-space <name>` | Lets setup add tabs to an existing space with this name that spider does not own. Repeat it for each space. Without it, the name conflict stops setup with `space-name-conflict`. |

Stock Herdr 0.1.13 already binds Cmd-F, and stock 0.1.16 binds all three keys. Setup prints no offer when no supported key is missing. Herdr 0.1.12 has no optional key offer.

A custom binding on these four keys stops setup even with `--overwrite-unowned-keys`: global Cmd-T, Cmd-D, and Cmd-Shift-D, and `spider-glass` Cmd-Shift-W. Restore the stock binding first.

### What setup changes

Setup backs up every file it replaces before the first write and records each step in a journal under `<globalRoot>/herdr/setup`. It changes these things:

1. The `herdr.config` entry in spider's global settings, only when you pass a configuration file outside the standard location.
2. The spider panel mod and picker, plus clones of Herdr's current `agents`, `spaces`, `pane`, `tabs`, and `workspace-chrome` mods with spider's patches applied. Herdr 0.1.13 and 0.1.16 also install Spaces B's cross-machine picker, `spider-menu`, and `spider-new-menu`. Herdr 0.1.16 uses one derived `spider-toast`; 0.1.13 leaves the stock toast untouched.
3. The `spider-glass` layout and Herdr theme. The layout places macOS traffic lights off-window and uses the `spider-chrome` clone for the brand row. The sidebar footer keeps `workspace-chrome`. Only `theme`, `layout` and `sounds.enabled` in the app's settings change. Custom sound paths remain unchanged. A later explicit sound opt-in releases that preference from setup ownership.
4. Five terminal sequences, Cmd-P for Go to, Cmd-N for a local space, and the layout-scoped Cmd-Shift-E Send back action. On 0.1.13 and 0.1.16, Cmd-T opens the machine picker for a new tab, Cmd-D for a split right, and Cmd-Shift-D for a split down. In `spider-glass`, Cmd-Shift-W uses spider's close confirmation for cross-machine panes. Other layouts keep native close, and Ctrl-V image paste stays unchanged. Supported native keys are offered when absent and never changed automatically. Herdr 0.1.12 keeps the native creation bindings and does not install the machine picker entry mods.
5. The `dracula-plus-glass` pi theme. Only the `theme` field of the agent directory's settings file changes.
6. Role templates generated from your global model settings.
7. `notes = false` in the core's `config.toml`. Only the root `notes` key changes.
8. A marked resume block in your shell rc file.
9. The remote runtime on each configured machine. Setup checks each machine's Node version with a visible probe.
10. The spaces and tabs for your sessions.
11. A private `herdr/sessions` folder under `<globalRoot>`, where each session publishes the state that the panel and the sidebar read. Rollback leaves this folder in place.

On Herdr 0.1.13 and 0.1.16, setup verifies the release's complete Spaces A result, applies all B records, and then adds notification hooks. It checks B's input, output, and record digests before writing any files or keys. A stale source, changed output, or missing record stops setup rather than installing a partial picker. The pane split controls, tab `+`, terminal context-menu split actions, and new-menu terminal and agent choices all use the machine picker. `--decline-native-keys` does not disable B or its Cmd-T, Cmd-D, and Cmd-Shift-D bindings.

Setup owns only these parts of each file. Edits you make elsewhere in the same files are kept when setup runs again. Setup compares the parts it owns by value, so a file that was saved again with different formatting but the same values is not rewritten. If you change a part that setup owns, such as the pi theme field or the resume block, setup stops with `managed-artifact-changed` and names the recorded value. Restore that value, then run setup again.

A second run with nothing changed writes nothing, makes no backup, changes no focus, and opens no duplicate session. It still checks each machine's runtime directory, and it installs the runtime again if that directory was deleted. If setup stops partway, run it again. It resumes at the first unfinished step. If a target file changed since setup checked it, setup stops instead of overwriting your edit.

### Upgrade

After you update spider, run setup again with the same configuration file. Each runtime version is installed under a file name derived from its content, so a new version goes next to the old one instead of replacing it. Setup probes Node again on a machine whose runtime changed. When only spider's installed files change, setup does not close and reopen your sessions. Then run the doctor.

On Herdr 0.1.12, setup refuses previously owned machine picker files or bindings and prints the rollback command. Run rollback first, then restore stock bindings or remove any remaining custom picker shortcuts before running setup again.

Earlier versions installed a `spider-machines` mod for a Machines panel. Setup no longer installs it or adds it to the layout, so Herdr does not load it. Setup does not delete that folder from the app's `mods` directory.

### How setup opens your sessions

By default, setup creates one tab per space, named after the space, and opens its sessions as panes. `layout: "tabs"` opens one tab per session instead. When it starts a session, setup uses a fresh terminal and sets `PI_CODING_AGENT_DIR` to the configured `agentDirectory`. On a rerun, it keeps verified live sessions in their current terminals. Before setup starts a session, it waits until no process holds that session. It waits for two kinds of process:

- A pi session that is one of the selected sessions. Setup prints `Close selected session <name>; PIDs: <list>`. Let its work finish or cancel it, then close it.
- A pi process with no record. Setup prints `Unrecorded pi PID <pid>: /reload in that session, or closing it, clears this block.` Every pi session that loads spider records itself when it starts or reloads, whether or not the integration is on.

Sessions that you did not select and that have a record can stay open. When `spaces` is empty, setup does not wait for any process.

Setup prints each waiting message once and repeats it only when the listed sessions or blockers change. It waits up to 30 minutes, then stops with `cutover-deadline`. Close the listed sessions and run setup again.

A session that was started with explicit `--extension` arguments cannot be opened by setup, because setup never replays them. Setup stops with `session-explicit-extensions`. Start that session by hand instead.

A new tab can briefly show a temporary name until pi starts in it. For pane layouts, setup verifies each new terminal, then parks and keeps it beside the recorded pane. It records the move first, so a retry resumes the same terminal even if an app reply was lost. If setup loses track of a session it was opening, it stops with `cutover-reconciliation-required` and does not open the session again. Do not open it by hand. Run setup again.

Setup identifies a live session by its session ID, current feed and heartbeat, and live pi process. It adopts the session's current terminal, even if the core restarted or the terminal changed. If no live terminal holds the session, setup can reopen it. If two terminals hold the same session ID, setup names both panes and leaves them alone. It continues with the other sessions, then reports `duplicate-live-session`.

Setup adopts recorded sessions that you merged into one tab. It keeps the names you chose for the space and tab. Other panes stay in place and are not recorded as owned. Rollback refuses to close a tab containing those panes.

### Undo an upgrade

To restore the local installation files from before the latest upgrade, run:

```sh
node <installed-package>/dist/herdr/cli.mjs rollback --undo-upgrade --config <absolute-config-file>
```

Before setup changes installed files or an endpoint, it records a private checkpoint under `globalRoot/herdr/setup/checkpoint.json`. The JSON records paths, content hashes, and modes. Content-addressed files under `backups/` hold the bytes once. These files have mode `0600`, and their directory has mode `0700`. Setup deletes unreferenced checkpoint blobs after each checkpoint save, including a newer upgrade, undo, or full rollback. The next mutating command also collects blobs and private temporaries left by a crash. Keep other backups until recovery is complete.

Failed attempts and their successful retry form one upgrade. Undo uses the state before the first attempt, not the retry. This also applies when a failed repeat joined an already completed upgrade.

A repeat that changes only the setup journal, cutover metadata, probe records, remote runtime, or runtime-owned layout keeps the completed upgrade checkpoint. It does not create an upgrade checkpoint when none exists. An unchanged repeat does not rewrite the setup journal. The summary reports `setup journal updated` separately from installed-file writes. Undo refuses with `upgrade-checkpoint-bookkeeping-only` if it would restore only setup bookkeeping.

Undo restores installed artifacts, including files an older spider install already owned. In shared files, it restores only setup's parts: the theme field, resume block, root notes setting, app preferences, and managed key sections. Later aliases, key bindings, and unrelated settings stay. Session moves in `spaces.json` stay. Changed runtime instructions and mod store copies stay, including copies changed during an interrupted undo. Undo prints `Runtime store retained: <path>` for a changed store copy. Unchanged copies created by the upgrade are removed.

Undo reverses setup's layout changes in attempt order. It restores mod references and release metadata while preserving unrelated layout edits, including pane sizes and custom entries. It never completes with a layout reference to a mod it removed.

Close the pi sessions that the upgrade created before undo. Undo removes only those new owners, not tabs or sessions that existed before the upgrade. In a shared tab, it removes only the new panes. New mod directories disappear through a verified rename before their files are deleted. Generated app files are removed with them; unrelated user files stay.

If a snapshotted installed path or a managed part changed, undo stops with `upgrade-checkpoint-changed` before restoration. This includes paths that setup did not rewrite. Inspect the named path first. `--replace-changed` permits replacement of an artifact or setup's managed part, never the rest of a shared file. It also clears a refusal for setup's parts changed between a failed attempt and its retry. Unrelated shared-file edits and completed-upgrade runtime rewrites do not trigger this continuity check. The flag never bypasses liveness or ownership.

For `upgrade-layout-reference`, copy the named mod to a custom mod directory and update its layout reference and `modId` props before retrying undo. Alternatively, remove the reference if you no longer want that mod. Before undo starts, this check leaves the mod installed.

For either `upgrade-layout-reference` or `upgrade-layout-ambiguous`, you can preserve the customized layout before retrying:

```sh
mv "<app-home>/layouts/spider-glass.json" "<app-home>/layouts/spider-glass.json.kept"
node <installed-package>/dist/herdr/cli.mjs rollback --undo-upgrade --replace-changed --config <absolute-config-file>
```

The `.kept` file preserves every custom entry. Copy the custom entries you still need into the restored layout. Retain any removed mod under a custom name before restoring its references. For invalid layout JSON, repair the syntax without deleting custom entries, then retry undo.

An interrupted file restore resumes when you repeat the command. Later aliases, keys, settings fields, and layout edits are merged into the restore. A new edit to setup's own part requires `--replace-changed`. Setup, full rollback, and the runtime instruction writer refuse to run while undo is in progress. A setup process that died before its final snapshot can be undone from its recorded writes without the replacement flag. An owner error before any close leaves undo retryable. After a close has begun, `upgrade-undo-interrupted` requires you to inspect the recorded owners before retrying with `--replace-changed`.

For `upgrade-checkpoint-invalid`, preserve `checkpoint.json` and `backups/`. Repair the checkpoint to retain upgrade undo. If you instead move it aside and rerun setup, setup starts a new checkpoint and cannot undo the old sequence. Full rollback is not a substitute for restoring the pre-upgrade state.

Undo does not downgrade the installed spider package. A restored endpoint registry can refer to an older endpoint file that a package update removed. Reinstall the matching package version if necessary, then run the doctor. Remote runtime files and bootstrap state are not restored. The CLI prints `Remote file not restored: <machine> <path>` for each recorded remote file without contacting the machine.

### Remove everything spider installed

Full rollback removes everything spider installed that it still owns, including files and bindings from older installs. To remove the installation instead of undoing one upgrade, run:

```sh
node <installed-package>/dist/herdr/cli.mjs rollback --config <absolute-config-file>
```

Rollback exits with 0 when it restored everything, 3 when some parts stay unrestored, 1 for any other failure, and 2 for a usage error. Setup and the doctor use the same codes, except 3. Rollback undoes only the parts that setup owns, and closes the tabs that setup created. Edits you made elsewhere in the same files stay. If you changed a part that setup owns, rollback leaves that file as it is and prints `<file> not restored:` with the reason. Repair that part, then run rollback again. To preserve a customized setup-owned file intact, move it to a `.kept` file before retrying rollback. Close the pi sessions in the tabs first, or rollback stops with `cutover-owner-live`. It never closes a terminal it did not create. It prints `Rollback restored <n> matching files`.

Full rollback restores the state before the first setup that owned each file, not the most recent upgrade checkpoint. It removes the endpoint registry, including one created by an older installation without a checkpoint or restored by upgrade undo. Full rollback retires the upgrade checkpoint, so a later setup cannot merge with the old sequence. Keep the checkpoint and backups until recovery is complete. If the original bindings were stock, rollback restores Cmd-T to `tab.new` and both split bindings to stock, and removes spider's Cmd-Shift-W binding. Bindings that were originally absent become absent again.

Like setup, rollback stops with `agent-directory-mismatch` when the configured `agentDirectory` differs from the shell's pi agent directory. It also stops with `global-root-mismatch` when the configured `globalRoot` differs from pi's.

Without `--config`, rollback and the doctor use the same file as setup. See [Where the configuration file lives](#where-the-configuration-file-lives).

## The configuration file

The file is JSON. Every path must be absolute. Keep the configuration outside any repository.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `"auto"` | `"auto"`, `true`, or `false`. The host setting `herdr.enabled` overrides it. |
| `app.binary`, `app.home` | Required | The `herdr-app` binary and its home directory. |
| `core.binary`, `core.config` | Required | The `hc` binary and the core's `config.toml`. |
| `agentDirectory` | Required | The pi agent directory. It gets the pi theme, sessions start with it, and it must match the shell's pi agent directory. |
| `globalRoot` | Required | Spider's global directory, which must match the one pi uses. Feeds, jobs, and setup journals live in its `herdr` folder. |
| `shellRc` | Required | The bash or zsh rc file that gets the resume block. |
| `resume` | `"offer"` | `"offer"` prints a manual resume command. `"auto"` starts the saved session after a proved core restart. |
| `layout` | `"panes"` | Default session layout for new space tabs. `"panes"` or `"tabs"`. A space can override it. |
| `spaces` | Required | Ordered spaces. See [Spaces](#spaces). |
| `machines` | Required | Remote machines. See [Machines](#machines). |
| `look.autoHideTabs` | `true` | Hide the tab bar until you hover over its top strip. Set to `false` to keep the full bar visible. |
| `look.windowBlur` | `true` | Neutral transparent window blur on verified Herdr 0.1.16 only. Set to `false` to disable blur. Older releases stay alpha-only and never receive `window_blur`. |
| `fonts.body`, `fonts.label`, `fonts.paths` | Bundled body and label fonts, and Herdr's path font | Optional replacement fonts. Each has a `path` and a `license` file. |
| `limits.auxiliaryPanes` | `2` | Auxiliary pane slots shared by all sessions in a tab, from 1 to 6. |
| `automaticSubagentPanes` | `false` | Let new subagent viewers open in free auxiliary slots automatically. Otherwise they stay parked until you open them. |
| `limits.completedRows` | `50` | Finished rows kept per session in the sidebar. |
| `limits.completedHours` | `24` | Hours a finished row stays in the sidebar. |
| `retention.foregroundDays` | `7` | Parsed but not used. Changing this value does not change log retention. |
| `admin.wrappers` | `[]` | Reviewed wrapper programs for the admin command. Each entry is `{ "path": "<absolute file>", "sha256": "<digest>" }`. See [The admin command](#the-admin-command). |

### Spaces

Each space has a `name`, an ordered `sessions` list, and an optional `layout` choice. The space's `layout` overrides the global `layout`. Both accept `"panes"` or `"tabs"`. Omitting both uses panes. Existing journalled tabs keep their placement on setup reruns, so an older configuration still works.

```json
{
  "layout": "panes",
  "spaces": [
    { "name": "Planning", "sessions": [{ "name": "Planner" }, { "name": "Reviewer" }] },
    { "name": "Work", "layout": "tabs", "sessions": [{ "name": "Builder" }] }
  ]
}
```

In pane mode, session order determines the initial arrangement:

- One session fills the tab. Two sit side by side.
- Three use one pane on the left and two stacked on the right, in that order.
- Four use a 2 by 2 grid. Session order is top left, top right, bottom right, then bottom left.
- Larger groups use `ceil(sqrt(session count))` columns. Setup opens the top row from left to right, then fills each column downwards. Column heights differ by at most one pane, with extra panes in the rightmost columns.

A session selector is one of these:

- `{ "file": "<absolute session file>" }`, the exact session file.
- `{ "name": "<session name>" }`, the session's latest name.
- `{ "name": "<session name>", "sessionId": "<id>" }`, required when two sessions share a name.

Setup checks every selector before it writes anything. An ambiguous name stops setup with `session-selector-ambiguous`. A name that matches no session stops it with `session-selector-missing`. Name lookup streams the whole session file in bounded chunks and uses the latest complete `session_info` name. File selectors use that name too, even when it was set near the start of a large file. Several sessions can share a repository and working directory. Each session opens in its last known live working directory, or else the working directory recorded in its session file.

### Machines

Each machine has these keys:

| Key | Meaning |
| --- | --- |
| `name` | The configured machine name. You can pass it as `on`. |
| `aliases` | Other names for the machine. You can pass these as `on`, and the SSH rule refuses them. |
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

- `on` accepts the configured name, the hc name, or an SSH target alias reported by hc. Names are case-insensitive. An unknown name, a failed connection, or an inactive integration never falls back to local execution.
- A `batch` takes one top-level `on` for every entry. An `on` inside an entry is rejected with `batch-entry-on`.
- With `exec_file`, `path` names a file on the remote machine. Your code runs there with `FILE_CONTENT` and `FILE_CONTENT_PATH` bound, as it does locally. A relative path needs a configured `runtime.cwd`, or the call fails with `remote-cwd-required`.
- A language with no entry in the machine's `runtime.commands` fails before launch with `remote-language-unsupported`. Spider never uses a local interpreter instead.

Output works as it does locally. Stdout and stderr stay separate, stdin is empty, and the model sees at most 10,000 bytes with secrets scrubbed. The complete output goes to private log files for later calls, within the retention limits below. The result keeps the real exit code, and its details add the job ID, machine, terminal address, and receipt paths. A foreground command that writes more than 100 MiB is cancelled with `output-cap-exceeded`. The bytes it wrote stay in the logs.

Each session or subagent run keeps local logs for its newest 64 settled jobs, plus any job settled in the last 10 minutes. A finished job settles after its call returns, its result or completion notice is read, and its terminal is released. This applies to foreground and background jobs. Spider cleans older local logs and journal records during the run. Under heavy use, it can remove settled logs sooner, oldest first, to make room for the next job. On startup, a separate cleanup removes foreground results older than seven days.

### Copy a file

Use `exec` with `on` and a `copy` object. Use absolute paths on both machines.

```text
spider exec on:"build-box" copy:{direction:"to",local:"/local/file",remote:"/remote/file"}
spider exec on:"build-box" copy:{direction:"from",local:"/local/returned-file",remote:"/remote/file"}
```

Each call reports the destination, size, mode, and SHA-256 digest. It preserves the file mode and supports text or binary files up to 64 MiB. The destination must not already exist. Spider transfers bounded text chunks through hc and checks the digest before reporting success.

### Agent consoles

Each session and each subagent run gets one console on each machine it uses. The first remote command creates it, and later commands reuse it. The console title is `<agent name> · <machine>`, where the agent name is the session name or the run's display name. A console opens no pane by default. Its sidebar row appears under its agent and shows the machine name.

The console shows each command's header, its stdout, its stderr with a label, and its exit code. When commands run at the same time, each line has a prefix for its job. A console cannot run commands or cancel jobs, and closing its pane leaves the jobs running.

When the runtime changes, the next command replaces an older console only after that agent's jobs on the machine have finished. The console labels include `spider.kind`, `spider.session`, `spider.owner-core`, `spider.owner-terminal`, `spider.machine`, `spider.display-name`, `spider.runtime`, and, for a subagent, `spider.run`. The `spider.runtime` value is the runtime's SHA-256 digest.

A subagent's consoles stay open while its run is active, even if the parent pi exits. When you resume the same session, spider recognizes those consoles and closes them when the run ends. A session's own consoles close when you quit that session or replace it with `/new`, `/resume`, or a fork. `/reload` keeps those consoles open and closes run consoles only when the run is known to have ended. If a machine is unavailable, spider retries closing its consoles while pi is running and after the machine reconnects, up to 24 failed attempts. A later startup removes abandoned consoles only when their owning session and run are both gone.

### Background jobs and timeouts

`timeout` is the time in milliseconds that the call waits:

- Without `background`, an expired timeout cancels the remote job and the result has `timedOut:true`. A command that traps the hangup and exits 0 still counts as timed out.
- With `background:true`, capture is durable from launch. An expired timeout detaches the job and returns `exitCode:null` with a `backgroundJob` receipt. `exitCode:null` means the outcome is not known yet.
- With `background:true` and no `timeout`, the call waits for the real exit.

Aborting a call requests cancellation of its remote job and returns the output collected so far. The result states whether the job stopped or its state is unknown, and names its terminal and logs. If the state is unknown, the job may still be running. Use the reported terminal address to follow it. Aborting a batch stops the current entry and skips the rest. Closing a pane never cancels a job.

To stop a detached remote job, call `spider kill id:"<job-id>"` with the full ID or a unique prefix. Spider accepts only jobs owned by the current session. It requests TERM for the job's process group and sends KILL after a grace period if owned processes remain. The `spider.job_done` notice reports `cancelled`. `kill id:"all"` still applies only to subagents.

For an older runtime, spider signals only a uniquely identified group leader whose command contains the job's own program path. Otherwise it reports the runtime path and asks you to stop the job by hand.

A shell can turn a signal into an exit code such as 143. The receipt and notice label that as a SIGTERM convention, not proof that the shell received a signal.

A detached job keeps running after the call returns. When it finishes, spider posts a `spider.job_done` message to the owning session, at most once. If the agent is busy, the message reaches it when its current step ends, without waiting for all of its work to finish. The message has the job ID, machine, terminal address, outcome, a short scrubbed output summary, and receipt paths. Spider writes the result to disk before it posts the message, and it never delivers the message through terminal input.

If you close pi, a detached job keeps running and keeps writing logs on the machine. The next time the session starts, spider collects the missing output and posts any notice it has not posted before. It never reruns a job to recover a result. If the evidence is missing or conflicts, the outcome is reported as unknown, not as exit 0.

### Remote commands from subagents

Subagents, and their own children, can pass `on` too. Each child runs the command through its own `hc` connection and gets its own tool result. Nothing is sent back to the parent to run. The child's jobs and consoles belong to the top-level session and carry the child's run ID and name.

When a child run ends, the top-level session takes over the child's unfinished jobs. It stops foreground commands that the child left behind and lets background commands finish. Their notices name the run and are posted at most once, across reloads.

A child finds the configuration file the same way as its session. See [Where the configuration file lives](#where-the-configuration-file-lives). If the child cannot start the integration, it keeps the SSH rule it inherited from its parent. Only `herdr.enabled` set to `false` for the child turns that rule off.

## The tab bar

The tab bar hides behind a 6 px strip above the terminals. Hover over the strip to show the tabs. The bar closes 300 ms after you leave, unless a tab menu, rename field, or drag is active. An active-tab change within the same space shows the bar for 1.5 seconds unless you selected that tab directly in the bar. Switching spaces does not show it. Revealing the bar does not resize your terminals. Drag the strip to move the window.

To keep the full bar visible, add `"look": { "autoHideTabs": false }` to your Herdr configuration file and rerun setup. The default is `true`. Turning it off restores the 42 px bar and its stock menus.

## The left sidebar

The left sidebar is Herdr's agents list, extended by setup. It lists each live pi session. Under a session, it lists active subagent runs by display name and the session's consoles. Under a run, it lists that run's consoles. Expand a console to see its live commands. Parked runs remain visible while they are active. A finished command leaves the list, and finished runs stay for `limits.completedHours`, up to `limits.completedRows` rows.

Finished rows are hidden by default. Click **N finished** under a session to show them, and **Hide finished** to hide them again. A finished parent stays visible when it has a running child. Each session has its own toggle.

The sidebar uses the owner feed to report run activity for local and remote viewers. A live viewer absent from the feed shows **Unknown**. A running entry in a closed or stale feed shows **Disconnected** because the feed cannot confirm that it is still active. Neither status counts toward the live pills. These rows remain visible for up to `limits.completedHours`, measured from the viewer's creation for an unknown run or the feed's last update for a disconnected run, and are limited to `limits.completedRows`. If a viewer has no creation time, the row limit still applies.

When a machine is unavailable, its console, command, and viewer rows show **Unreachable** and cannot be opened. They do not count toward the live pills. The rows update when the machine reconnects. A finished run keeps its recorded outcome when a reachable owner can open its saved local view. Otherwise an unavailable viewer shows **Unreachable**.

Use the chevron to the left of an agent icon to fold its children. The pill on a folded row counts active children and opens the list again. To pin or unpin an agent, hover over its icon and click the pin. The elapsed time stays visible.

Thin thread lines join each row to its parent, so you can see how deep a row sits. An icon shows the row's kind: a terminal for a session, a robot for a subagent run, a list for a console, and a server for a command on a machine. A finished run shows a check. A command leaves the list when it finishes, and a failed command appears in the spider panel.

Clicking a row opens it:

- A session row focuses that session's agent pane.
- A run row shows the run's viewer.
- A console row shows that agent's command history on the machine.
- A command row opens an observer for that one job.

Right-click a subagent row to open its viewer in a new tab or an existing tab. If the viewer already has a pane, the menu offers **Move to new tab**, **Move to tab**, and **Hide**. Hide parks the viewer without stopping the run. **Kill subagent** sends the kill request to the owning session. Finished runs with saved views have the same open options.

The list includes agents from every machine. Use the sort control in the Agents header to group agents by space. When several agents share a tab, each spider session uses its session name, and other agents use their terminal titles.

### Panes

Each tab shares `limits.auxiliaryPanes` auxiliary slots across all its sessions, 2 by default. Spider counts the viewer panes in the app layout, including viewers opened by another session process. Opening an auxiliary view never parks, moves, resizes, or hides your main agent panes.
The close button in spider's pane header asks before closing a pi session. Cancel keeps the pane and session running. Confirm ends pi, but its supervised subagents keep running and reconnect when you resume the same session. Shell and mod panes still close normally. Spider does not park native local main sessions because Herdr cannot reliably give those terminals a pane again. The focused header also accepts `spider-pane.close`, which uses the same confirmation. It is not a new default key binding. Herdr's native `pane.close` command has no close hook, so a custom key binding or another mod that calls it directly can still close without asking. The move menu's explicit Kill session action instead stops its subagents before ending pi.

Subagent viewers stay parked by default and appear under their parent in the sidebar. Local viewers can keep running without a pane; remote viewers use the disposable display leases described below. Open them from the sidebar, the spider panel, or an open or move menu. Consoles and command observers also wait for you to open them.

Set `automaticSubagentPanes: true` to let new subagent viewers fill free auxiliary slots automatically. The setting is off by default. When the tab is full, a new viewer stays parked. Spider never closes a displayed pane to make room for an automatic viewer.

When you open an item from the sidebar or the spider panel, spider does one of these things:

1. If the item is already displayed in any tab, spider focuses it.
2. Otherwise, if the strip has a free slot, spider shows the item there and focuses it.
3. Otherwise, spider opens the item in a new tab named after it, and focuses that tab.

Closing an auxiliary pane frees its slot. When a command finishes, its observer keeps the saved output and shows `Finished, exit <code>. Close this pane when done.` until you close it. If the core goes away first, the observer shows `Disconnected. Close this pane when done.`

A subagent viewer has a bot icon, a run-name pill and a parent pill. It has no path or steering tag. A spacer keeps its status icons at the right. Console and command headers use a terminal icon and keep their name, parent pill and working directory. Long paths are shortened in the middle, with the full path on hover. Named pi sessions show the program logo, a session-name pill and the path. An unnamed session keeps its old header text.

Right-click a terminal pane's header to move it to a new tab or another tab. The menu groups tabs by space and lists the current space first. A terminal can move only between tabs on its own machine. Herdr does not yet support moving mod panes. Herdr's terminal right-click menu cannot be extended, so use the pane header for these actions.

The last menu item stops the item in that pane. It reads **Kill subagent**, **Kill command**, **Kill session…**, or **Kill terminal**. Killing a session asks for confirmation, then waits for its subagents to stop before killing the session's terminal. Cancel leaves both running. **Kill terminal** uses that same backend stop when the terminal owns a pi session; an ordinary shell is killed directly. Session kills require a live owning connection rather than falling back to an unsafe native kill. **Kill command** asks the owning session to cancel the remote process group.

Closing a viewer, console, or observer, or the tab that holds it, never cancels a job or a run. To stop a remote command, abort the call, let its timeout expire, or use `spider kill` with its job ID.

## Remote core replacement

A machine whose native status is `unreachable` with the exact reason
`a different core answers there ("<core-id>")` has a replaced core. Its machine
connection is unknown, not a disconnected transport. Plain `unreachable`
without that reason still means disconnected. The roaming hub uses the same
classification. Core replacement neither starts nor clears a hosting outage
alert, and it never triggers move recovery. Pending hosting notifications
pause while identity is unknown; delivered alerts remain until the machine
is observed as connected again.

## Cross-machine panes

The tab plus action, split actions, Go to → New terminal and agent creation actions choose a machine before starting a program. **This computer** is the local choice. The focused agent's machine is preferred when known. Unreachable machines remain visible but disabled. A pane-menu selection carries its original destination and machine choice into the next action; it cannot start the same program twice by reusing that selection.

The program runs on the chosen core. A remote program appears through a local proxy in a local space and tab, not through a remote app space. Its header uses the target's title, status and current folder, with a neutral machine pill. Local agents, viewers and consoles show **This computer**; an ordinary local shell has no machine pill.

A new remote shell uses a proved current folder from the focused target on that machine, or that machine's home when no suitable folder is available. The remote machine checks the folder. An unreachable machine does not start the program locally instead.

### Close, Send back and reconnect

A remote proxy is a display, not the program it shows:

- **Close** asks before ending the real target. Cancel leaves it running.
- **Send back** removes the display and keeps the program running. Open it again from Agents to attach to the same target, using its saved tab when available. Choose another tab explicitly if the original container was removed.
- A tab or space closing, a display process exiting, or a connection dropping is not a request to stop the remote program.

During an outage the proxy shows reconnecting status and discards input. It does not replay those keys when the connection returns. It verifies the source core and terminal incarnation before enabling input again. Reusing the same machine alias for another core cannot redirect the old presentation.

Native local pi close keeps its existing confirmation. A native `pane.close` call still has no spider close hook.

### Hand-started agents and remote views

Agents discovers named pi sessions on configured machines even when they were started outside spider's space setup. A unique configured name can supply a destination. Otherwise the agent stays unplaced until you choose **Open in tab**, **Move to tab**, **Move to new tab**, or a drop target. Explicit placement is remembered and takes priority over a later name match, including after the presentation helper restarts. A live pi outside an hc terminal is listed as **Not in an hc terminal**; its placement actions are disabled.

A remote subagent view opens relative to its parent's local presentation. If that view cannot fit at 60 columns by 8 rows, it uses an owner-relative tab instead of shrinking the parent. Its display lease lasts 20 seconds and renews while displayed. Closing the display, losing its helper or letting the lease expire may stop that viewer process, never the subagent. Reopening starts a new view of the same run. Consoles are read-only and keep one identity per agent and machine; removing their display does not cancel jobs.

When execution moves between this computer and another machine, presentation readiness preserves the saved local space and tab and changes between a native pane and a proxy. Ownership and display readiness are separate. If the original tab is unfocused and a focus-safe placeholder cannot be proved, conversion remains pending without moving focus or rolling ownership back. The native moved placeholder on 0.1.13 is not implemented.

The [B01–B08 acceptance checklist](../../packages/herdr/e2e/README.md#cross-machine-panes-b01b08) separates packed checks from blocked native keyboard, clipboard, resize and continuous-visibility observations. A headless result does not certify those interactions.

## Raw SSH

Inside Herdr, use `on` to reach managed machines. If plain `ssh` targets a configured machine or alias, spider blocks it and suggests `spider exec` with the machine's `on` value. The same check applies to `scp`, `sftp`, `rsync` over SSH, and `git` over SSH. See [The admin command](#the-admin-command) for repairs that need a direct SSH connection.

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

Each subagent run gets a viewer terminal, parented to the session's agent pane. The viewer uses the host's pi components and theme. It shows the task, steers, assistant markdown and thinking, tool calls and results, bash output, and session summaries. New messages stream while the child runs. Saved session files supply the completed messages. Terminal control sequences in those messages cannot change your terminal.

Press Ctrl+O to expand tool output, Ctrl+T to toggle thinking, and Ctrl+C to close the viewer. Large logs open at the tail and label omitted history. The footer shows the run and owner names, model, thinking level, context use, recorded token usage and cost, and run status. An unfinished status that the owner can no longer confirm is labelled `last known`. Missing values have explicit labels. `tail totals` means the viewer has loaded only part of the saved file.

Only a running RPC child with a live pipe has an editor. Press Enter to send a steer through the owning session. The steer appears above the editor with its real delivery state. It disappears when the child records the instruction. A reply with unknown delivery never triggers a retry. Other runs have no editor and show `read-only` in the footer. Blank text, text that starts with `/`, and text over 16 KiB are refused.

The viewer requires the host's pi 1.2.0 or later as a peer dependency. If pi cannot load, it explains why once and opens the text viewer. Different spider frame versions produce one compatibility notice, not unsupported live output.

During `/reload`, the viewer reconnects silently and keeps its messages and draft. If the owner does not answer IPC for about 3 seconds, the footer shows `owner unreachable` until it recovers. Feed update times do not decide whether the owner is reachable.

When the owning session quits or its terminal closes, the viewer stays open and shows `Owning session closed. Saved log is read-only.` Close the viewer when you are done. After 30 seconds without the owner, the saved log stays open and read-only. A replaced owner's viewer never reattaches, even if that session later resumes. A feed file that stays missing for 30 seconds also leaves the saved log open and read-only.

Spider starts one parked viewer for each unfinished run. Spider does not automatically start a viewer for an already-finished run. If you close a viewer, later events from that run do not open it again. Open it from the sidebar instead.

While the owning session is live, a viewer closes when its run finishes, fails, or is cancelled. Its footer shows the final status, and it holds the output for 2 seconds before closing. An automatic viewer that starts after the run ends closes the same way. A viewer you open while the run is unfinished also closes when the run ends. Focusing an existing automatic viewer does not keep it open after completion.

Owner quit and replacement are exceptions. Those viewers stay open and read-only while the parent is absent. The supervised subagent keeps running. Resuming the same session restores its live handle and lets the viewer reconnect and steer again. During `/reload`, the viewer reconnects without stopping the child.

Opening an already-finished, failed, or cancelled run from the sidebar or the spider panel opens a saved read-only view until you close it. If the live viewer is still closing, spider waits for it to exit before opening the saved view. Viewers never start another subagent and never change how a child runs. Opening or closing a viewer does not change the agent pane.

`hc` accepts only simple names for terminals. Spider names each viewer `run-<hash>`, each observer `obs-<hash>`, and each console `console-<hash>`, and keeps the readable name in the `spider.display-name` label. The sidebar, pane headers, and panel show the readable name, except that console rows in the sidebar show the machine name.

## Use the spider panel

The panel is hidden by default. Click **Spider**, marked with the web icon next to **Files** and **Changes** at the top right, to show it. Click it again to hide it. Herdr remembers the open panel for each space. The dock opens at 368 pixels wide and resizes from 280 to 900 pixels. The [shortcuts](#shortcuts) open spider views in pi without opening the panel.

The panel shows the space that is selected in the sidebar. It has three parts: the notification list, the sessions, and the month bar. When something goes wrong, a problems group appears above the notifications.

### Notifications

A bell heads the panel, with the number of items that need you. The panel shows dismissible cards for a live session that is blocked or failed and for memories waiting for review. A waiting card does not show the question.

Click a session card to focus its pane. Click the memory card to open memory review in the panel. Use the dismiss control to hide a card until its underlying state changes. The panel never polls machines.

### Sessions

The **Sessions** list has one row per session in the space. A session that has no tab in any space appears in every space. A row shows a terminal icon, the session name, small counts for live subagents and open todos, and the session's credits this month in the **Credits** column. The word `unavailable` means spider could not read the session's credits. While spider refreshes the figure, the row keeps showing the previous one. The row shows no status, because the sidebar shows it. A session that is not live has a dimmed name, and its tooltip names the state. A session counts as disconnected after more than 20 seconds without a matching heartbeat.

Click the terminal icon to focus the session. Click anywhere else on the row to expand it. An expanded row shows up to five open todos, a **+N more** link when there are more, the session's loop and schedule triggers with their next run time, and an **All todos, runs and usage** link that opens a session view in the panel.

When the panel reads the session folder and finds no feeds, it says `No live sessions` and offers **Run doctor**. If it could not read the folder, the list says `Spider couldn't read the session feeds, so sessions may be missing here.`, shows the technical reason below it, and offers **Run doctor**. If every feed it found was skipped, the list says `Spider couldn't read any session feed.`

### Problems

Problems that do not stop the panel appear in one group at the top, above the notifications. Each row has a red cross and a sentence, for example `Spider skipped a session feed larger than 1 MB.` or `The run's output didn't open. Its pi session isn't reachable.` The technical reason is in the row's tooltip. Repeated problems appear once, and skipped feeds of the same kind are counted in one row. The group shows three rows; click **+N more** to show the rest and **Show fewer** to fold them again. If doctor takes longer than 30 seconds, its row gives the doctor command to run in a shell.

The panel reports these problems:

- A session feed that is a link or a special file, larger than 1 MB, not valid, or unreadable. Spider skips it.
- Feeds that together exceed what the panel reads at once. Spider hides the oldest sessions first.
- A lost watch on the session folder. The panel then rereads the feeds every 8 seconds.
- A run view, command output, memory review or spider view that did not open.
- A doctor run that took longer than 30 seconds.

An expanded session row also lists that session's own problems, such as `Spider can't read this session's commands.`

### When the panel can't start

The panel needs absolute paths in its layout entry, which setup writes. If they are missing or not absolute, the panel shows only `Spider panel can't start`, a sentence that says what is wrong, and the fix: in pi, run `/herdr-setup`, then run the doctor command it prints. A muted line below names the layout props that are missing or not absolute. The panel then shows no sessions, notifications, month bar or **Run doctor** button, because none of them can work without those paths.

### The month bar

A slim bar at the bottom of the panel shows the month's credits: the month name, a track, and the amount used. When `usage.monthlyBudget` is set, the track fills to the share of the budget used, hatching shows the projection to month end, and a thin mark shows today. If the projection exceeds the budget, the fill turns red. Without a budget, the track stays empty. Hover over the bar to see the used amount, when the numbers were updated, and, with a budget, the projected, budget, and remaining amounts and whether you are on pace. Without a budget, the details say `No budget set, so no pace`. When usage data is missing, the bar says `Usage unavailable` and draws no track.

### Herdr notices

The panel does not post Herdr toasts for feed notices. There are no budget, subagent-result, escalation or job-result toasts. Job results go to the agent that started the job through `spider.job_done`.

## The look

Setup installs a layout named `spider-glass` and a pi theme named `dracula-plus-glass`:

- Surfaces are neutral black `#161618`. Text panes, the spider panel, and menus use it at 94 percent opacity.
- Hover, selected, and raised fills are white at 7, 8, and 11 percent.
- Panes have a 12-pixel radius, an 8-pixel gap, and a 1-pixel `#38383a` border. The focused pane uses the light grey accent for its border. The panel has the same radius and neutral border.
- The layout has no bottom status bar, leaving its space for panes.
- Herdr's window chrome uses neutral greys. Its only accent colours are red and amber, and they mark states, such as a failure or a session that waits for you.
- The terminal palette and the pi theme are Dracula+. Pi's boxes use opaque neutral greys, because pi themes have no alpha.
- Herdr's UI text uses the bundled Google Sans Flex. Paths, names, and numbers in spider's views use Herdr's bundled JetBrains Mono. Your terminal font does not change.

Herdr 0.1.13 uses an opaque window with a 176-degree gradient from `#18181a` to `#22201e`. Its chrome and sidebar are transparent over that gradient.

Verified Herdr 0.1.16 enables neutral window blur by default. Its root and canvas are transparent neutral black, with alpha rising where text sits. Bare chrome uses about 0.6 alpha, menus about 0.94, and text-heavy surfaces use higher alpha to preserve contrast over bright backdrops. The existing dividers and card edges stay unchanged; blur adds no new edges or shadows. Terminal colors remain Dracula+ over neutral black, never its purple-grey background.

Set `"look": { "windowBlur": false }` to disable blur without changing those surface colors. With blur off, the theme background shows behind the transparent `#16161800` root and canvas. The 0.1.16 sidebar is `#161618fa`, not transparent. Herdr 0.1.13 never receives `window_blur`.

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

Spider records which session runs in each Herdr terminal. When the `hc` core restarts and restores a shell, the default `"resume": "offer"` prints the saved session name and defines a `spider_resume` function:

```text
Resume <name>: run spider_resume (or keep this shell).
```

Run `spider_resume` to resume the session, or ignore the offer to keep the shell. In auto mode, the shell prints `Resuming <name>…` at its first prompt, starts pi, and returns to a normal shell when pi exits.

Both modes resume the exact session file in its saved working directory, only after a proved core restart and when no other process holds the file. Persistent interactive top-level sessions record their launch environment, program, arguments, and Node runtime arguments at startup and again on `/reload`. Sessions started with `--no-session` do not store launch data. Print, JSON, RPC, and subagent sessions do not create resume mappings.

### What resume restores

Resume starts with the restored shell's environment, then overlays recorded variables, including credentials, routing settings, and `PI_INTERCOM_STABLE_ID`. Variables added since launch stay in place. Terminal and login identities keep their current values instead of stale launch values:

- Herdr and terminal identity: `HC_*`, `HERDR_*`, `TERM_SESSION_ID`, `TERM`, `COLORTERM`, `TERM_PROGRAM*`, `TERMINFO`, `TERMINFO_DIRS`, `TERM_FEATURES`, `TERMINAL_EMULATOR`, `LC_TERMINAL*`, `TERMUX_VERSION`, and `WARP_TERMINAL_SESSION_UUID`.
- Shell and login state: `SHLVL`, `PWD`, `OLDPWD`, `_`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`, `TMPDIR`, `XPC_*`, `__CF*`, `SECURITYSESSIONID`, `LaunchInstanceID`, `GPG_TTY`, `GPG_AGENT_INFO`, `GIT_ASKPASS`, `SSH_ASKPASS`, and `KRB5CCNAME`. Any saved value pointing at `/dev/tty*` or `/dev/pts/*` also keeps its current value or absence.
- Desktop and systemd session state: `XDG_RUNTIME_DIR`, `XDG_SESSION_*`, `XDG_SEAT`, `XDG_VTNR`, `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `SESSION_MANAGER`, `GNOME_KEYRING_CONTROL`, `INVOCATION_ID`, `JOURNAL_STREAM`, `MANAGERPID`, `SYSTEMD_EXEC_PID`, `NOTIFY_SOCKET`, `LISTEN_PID`, `LISTEN_FDS`, `LISTEN_FDNAMES`, `WATCHDOG_PID`, `WATCHDOG_USEC`, `MAINPID`, `MAINPIDFDID`, `MANAGERPIDFDID`, `MONITOR_SERVICE_RESULT`, `MONITOR_EXIT_CODE`, `MONITOR_EXIT_STATUS`, `MONITOR_INVOCATION_ID`, and `MONITOR_UNIT`.
- Editor, terminal, and multiplexer endpoints: `VSCODE_IPC_HOOK_CLI`, `VSCODE_GIT_IPC_HANDLE`, `VSCODE_GIT_ASKPASS_*`, `VSCODE_PID`, `VSCODE_CWD`, `VSCODE_INJECTION`, `VSCODE_NONCE`, `VSCODE_SHELL_INTEGRATION`, `KITTY_LISTEN_ON`, `KITTY_WINDOW_ID`, `KITTY_PID`, `ALACRITTY_SOCKET`, `ALACRITTY_WINDOW_ID`, `ALACRITTY_LOG`, `WEZTERM_UNIX_SOCKET`, `WEZTERM_PANE`, `WEZTERM_EXECUTABLE`, `WEZTERM_EXECUTABLE_DIR`, `ZELLIJ`, `ZELLIJ_SESSION_NAME`, `ZELLIJ_PANE_ID`, `ITERM_SESSION_ID`, `ITERM_PROFILE`, `ITERM_SHELL_INTEGRATION_INSTALLED`, `KONSOLE_DBUS_*`, `GNOME_TERMINAL_SCREEN`, `GNOME_TERMINAL_SERVICE`, `VTE_VERSION`, `VTE_SHELL_PID`, `NVIM`, `NVIM_LISTEN_ADDRESS`, `TMUX`, `TMUX_PANE`, `STY`, `WINDOW`, `WINDOWID`, and `WT_SESSION`.
- Pi and spider process markers: `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`, `PI_SPIDER_*`, `PI_SUBAGENT_*`, `PI_INTERCOM_SESSION_ID`, `PI_INTERCOM_SCOPE_ID`, `SPIDER_HERDR_*`, `SPIDER_TOOL_NAME`, `SPIDER_PARAMETERS`, and `SPIDER_VIEWER_*`. The launcher creates fresh lease variables.

Persistent terminal configuration, such as `KITTY_CONFIG_DIRECTORY`, `WEZTERM_CONFIG_FILE`, and `ZELLIJ_AUTO_ATTACH`, still replays.

Resume uses the recorded program when it is still available, or `pi` from PATH otherwise. A program launched through Node keeps its Node `execArgv`, such as `--max-old-space-size`. If that Node executable is gone, resume uses `node` from PATH. It replays process options such as `--tools`, resource paths, system prompts, trust overrides, and extension-defined flags. Relative `--extension`, `--skill`, `--prompt-template`, `--theme`, `--session-dir`, and `PI_CODING_AGENT_DIR` paths resolve against the original launch cwd. It leaves out session selectors, positional prompts, `@file` attachments, and everything after `--`. It also omits the original `--model`, `--provider`, `--thinking`, and `--name`, so the session's current values win.

An original `--api-key` needs an explicit model in pi's CLI. The current model is the latest explicit selection on the active session branch, not a physical model named in a routed response. When the current session model has the same provider as the launch model, resume pairs the key with that current provider-qualified model. If the session has no model, it uses the original launch model. Older session files without a `model_change` entry use the last assistant response as a fallback. A routed response can name a physical provider and cause a false `session-key-provider-changed` refusal. Resume those files manually because they contain no reliable selected-provider evidence. The launch model includes pi's selected default when no `--model` was supplied, and its provider stays fixed across `/reload`.

If the provider changed, resume refuses with `session-key-provider-changed`. The notice names both providers and gives a quoted manual command for the current model, with `<API_KEY>` instead of the key. Supply a key for that provider, and reapply any other process options you need. Resume never silently drops the original key or sends it to another provider.

`session-key-provider-unknown` uses the same visible refusal and placeholder command when the original provider cannot be established. This can happen when the first capture occurs at `/reload`, or when startup never reaches terminal registration because ownership, admission, or the core is unavailable. An explicit `--provider` can establish the original provider even without a recorded startup model. The current model is not evidence of the original provider, and a model string alone can be ambiguous. Environment replay without an argv `--api-key` is unaffected. Replaying `--api-key` puts the key in the resumed process's argv, just as at the original launch.

Local extension paths replay when they still exist. Package sources with `npm:`, `git:`, `github:`, `http:`, `https:`, `ssh:`, or `builtin:` prefixes replay verbatim. `file:` URLs also replay verbatim after a local existence check. `session-extensions-missing` names the missing flags and their argument positions, never the extension values. Setup cutover still refuses explicit extensions, and older mappings without complete launch data keep their previous plain `pi --session` behavior and extension refusal.

### Private launch records

The complete launch environment, auth variables included, and argv live only in `<agentDirectory>/spider/herdr/launch-environments/<terminal-hash>-<publication-id>.json`. This replaces the earlier no-auth-storage rule because a session can depend on launch-time credentials. Each record is an atomic 0600 file in a 0700 directory, capped at 8 MiB. Readers and writers refuse symlinks and non-regular files. Terminal maps, doctor output, and shell offers do not contain the private data.

Records persist after normal exit and crashes until their terminal state is removed or a later launch replaces them. Each publication writes a new record before publishing its mapping, syncs both directories after the renames, and then removes the old record. The next write also removes leftover `.new` files for that terminal. A missing, unsafe, or mismatched private record stops resume instead of launching with partial settings. The refusal names the session and gives a quoted manual command with an API-key placeholder. The same refusal appears once per terminal mapping, not at every new shell. Starting pi again replaces that mapping. A stale `spider_resume` offer also refuses rather than dropping the saved launch settings. Records never travel with roaming state, workspace snapshots, remote runtimes, or remote file copies. Keep them out of external sync and backup exports too.

### When automatic resume runs

When pi exits or crashes and its shell returns to a prompt, the shell marks that session ended. A later restart skips it. A backgrounded or suspended pi stays live while its process exists. When the core restart kills both pi and its shell, no prompt runs and the session stays resumable. Starting pi again clears the ended state.

Automatic resume covers sessions started or reloaded since the update. It makes at most one launch attempt per terminal for each core restart. A session held by another process remains eligible when that process exits. Private-record and launch-configuration refusals appear once per terminal mapping. A failed or interrupted launch is not retried until a later proved core restart.

On macOS, Node does not expose `F_FULLFSYNC`. A power failure immediately after a marker changes can lose it, causing a missed or repeated resume attempt.

If the resume hook, the Node binary, or the CLI that setup recorded is missing, the block does nothing and the shell starts without an error. Noninteractive shells and shells outside Herdr are unchanged. The prompt check is installed when a shell starts, so shells already open before the update do not have it. Put the resume block after other prompt-hook setup, including any lines that replace `PROMPT_COMMAND` or `precmd_functions`.

### Turning on automatic resume

1. Set `"resume": "auto"` in the Herdr configuration file. See [Where the configuration file lives](#where-the-configuration-file-lives).
2. Check that the CLI path in the marked block in your shell rc file points to the updated spider installation. If the path changed, run setup again to update the block.
3. Run the updated installation's doctor command and check that it reports `resume-mode: auto`. See [Troubleshooting](#troubleshooting).

## Troubleshooting

Run the doctor from a plain shell:

```sh
node <installed-package>/dist/herdr/cli.mjs doctor --config <absolute-config-file>
```

Without `--config`, the doctor uses the global `herdr.config` setting or the standard location. It reports the configured `resume` mode. The doctor prints each failure or warning as a code, a message, and a `Repair:` line. A check that it cannot run is a warning with an `unavailable` code, not a pass. When there are warnings, it prints a summary of passed, unavailable, and failed checks. When there are no warnings and no failures, it prints `Doctor checks passed`. It exits 1 if any check failed, and 0 otherwise. The doctor never restarts a core, changes the layout, sends terminal input, or edits a user database. It checks Node on each machine with a visible probe every time, and checks each machine's runtime directory. It also checks that the Node binaries that setup recorded for the resume block, the cutover, and the mods still exist and are supported.

The spider panel's **Run doctor** button runs the same command.

| Code | Cause | Fix |
| --- | --- | --- |
| `core-unavailable` | The `hc` core is not running. Spider does not start it. | Start the core, then retry. If it stopped during a session, wait for the recovery notice and run `/reload` in that session. |
| `global-root-mismatch` | The configuration's `globalRoot` differs from the spider global root. | Set `globalRoot` to the path that the message names, then run setup or the doctor again. |
| `agent-directory-mismatch` | The configuration's `agentDirectory` differs from the pi agent directory of the shell that runs setup or rollback. | Change `agentDirectory` to the path that the message names, or set `PI_CODING_AGENT_DIR` in the shell to the configured path. |
| `pinned-node-unavailable` | A Node binary that setup recorded is missing or unsupported. | Restore a supported Node at that path, or run setup again from a plain shell with a supported Node. |
| `remote-node-unavailable` | A machine has no Node or a version below 22.18.0. | Set an absolute `nodePath` for the machine, or install Node `>=22.18.0` on its `PATH`. |
| `runtime-root-invalid` | A machine's runtime directory is missing, is not a private directory owned by you, or the runtime cannot run there. | Fix the directory's owner and mode, then run setup again. |
| `runtime-not-installed` | A remote call found the machine's runtime missing or outdated. | Run setup again. |
| `native-notes-enabled` | The core's root `notes` key is not exactly `false`. | Fix the root `notes` key, then run setup again from a plain shell. |
| `launch-notify-enabled` | A spider launch permits native notifications. | Update spider, then run setup and the doctor again. |\n| `launch-history-unavailable` | The doctor could not read the core's terminal event snapshot. | Check that Herdr is running, then run the doctor again. |\n| `inspection-unavailable` | The doctor could not inspect a check, including a launch with no readable notification policy. | Follow the repair line for that check. For launch policy, run setup, start a spider pane or remote command, then run the doctor again. |\n| `installed-artifact-changed` | An installed spider mod or another checked file differs from this spider version. | For a mod, run setup again. For another file, follow the repair line. |\n| `upstream-source-unknown` | A built-in Herdr mod differs from the supported source. | Update spider or restore an unmodified supported Herdr release, then run setup again. |\n| `upstream-version-mismatch` | The installed Herdr app version is not supported. | Update spider, or use a verified supported Herdr release. |\n| `doctor-inspection-failed` | The doctor could not complete a check, including when a built-in source is not recognized. | Follow the message and repair line. |\n| `duplicate-live-session` | Two terminals hold the same session ID. Setup left both alone and continued with the other sessions. | Close one of the sessions, then run setup again. |
| `key-binding-conflict` | A Herdr key is bound to something spider does not own. | Restore stock for the four strict picker keys, or use `--overwrite-unowned-keys` for other keys. |
| `legacy-picker-binding` | An unsupported release has previously installed picker files or bindings. | Run the rollback command in the message, then restore stock bindings or remove any remaining custom picker shortcuts. |
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
| Setup lists process IDs and waits. | These pi processes hold sessions that setup needs to open, or have no record. Run `/reload` in an unrecorded session, or close it. Close only the sessions that setup lists. |
| A panel session name is dimmed. | The session is not live. Its heartbeat is more than 20 seconds old, or the session closed. The tooltip names the state. |
| Status shows working with no visible activity. | The session has queued, running, or paused subagents. Open the agents list with Cmd-Shift-A. |
| Pi says that Herdr features are off in the session. | The integration did not start. See [Turn the integration on or off](#turn-the-integration-on-or-off). |
| Pi says Herdr is running again. | Spider does not reconnect on its own. Run `/reload` in the session. |
| Pi says the session's Herdr pane belongs to an instance that has stopped. | A new core replaced the session's core. Close the session and open it again in Herdr. |
| Pi or the CLI says it ignores the repository's `herdr.config` or `herdr.enabled` setting. | The key is global-only. Move the value to the global `config.json`, and delete it from the repository file. |
