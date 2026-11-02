# @spider/herdr

This package integrates spider with Herdr, a terminal workspace made of the `hc` core and the `herdr-app` window. It contains the `hc` and app clients, the status adapter, the session feed and its IPC endpoint, remote execution, agent consoles, the job monitor, subagent viewers, session records and resume, spaces setup, role templates, the SSH routing policy, the installer, and the doctor. Its assets are the Herdr mods, patches for cloned Herdr mods, themes, key bindings, and fonts.

For setup and use, see the [Herdr integration guide](../../docs/guide/herdr.md).

## Responsibility

This package owns:

- The canonical types, label keys, and `spider.kind` values in `src/contracts.ts`. Other packages and the mods use these instead of defining their own.
- Every call spider makes to `hc` and to the app. Every `hc run` that spider issues passes `--no-notify`. Every `hc` call first checks that the core's socket is live, so spider never starts a core.
- The files under `<global spider directory>/herdr`: the standard configuration file, session feeds, job journals, terminal mappings, process presence records, setup journals, the admin audit log and one-time admin token files, and IPC sockets.
- The programs that run outside pi: the setup and admin CLI, the viewer, the remote observer, and the remote runtime.

This package does not own:

- Pi lifecycle and database access. `@spider/host` supplies them through the port interfaces each `register*` function takes.
- Language preparation and model-facing output shaping. Those stay in `@spider/context`.
- Child processes, run events, and message delivery. Those stay in `@spider/subagents`.

## Key modules

| Path | What it does |
| --- | --- |
| `src/contracts.ts` | Branded ID types, feed and job records, labels, IPC request and reply types, and their boundary parsers. |
| `src/config.ts` | `parseHerdrConfig` validates the user configuration file and applies its defaults. |
| `src/client/` | `createHcClient`, `createHcEventStream`, `createAppClient`, the core liveness check, and the reply parsers. |
| `src/status/` | `registerHerdrStatusContribution` wraps pi's program-status setter so pending subagent runs keep the session `working`. |
| `src/feed/` | The session feed publisher, the IPC server, and the IPC client. |
| `src/remote/` | Remote execution, agent consoles, chunked output transfer, and the remote runtime that runs on the destination machine. |
| `src/jobs/` | `registerHerdrJobs`, the job monitor and journal, the handoff of a finished child's jobs to its session, pane placement, and remote observers. |
| `src/ssh/` | `registerHerdrRouting`, the SSH parser, policy, transport checks, machine cache, `PATH` shim, and the audited admin command. |
| `src/viewers/` | `registerHerdrViewers`, the viewer program, transcript paging, and steering. |
| `src/sessions/` | `registerHerdrSessions`, process presence, session-file leases, the terminal registry, the leased launcher, and resume offers. |
| `src/spaces/` | Session discovery, the cutover, and space and tab setup. |
| `src/templates/` | `regenerateGlobalHerdrTemplates`, which host calls at session start, and the role template generator. |
| `src/shortcuts/` | `registerHerdrShortcuts` and the key collision check. |
| `src/look/` | Patch application, layout edits, font installation, and the contrast check. |
| `src/setup/` | `runHerdrCli`, the transactional installer, backups, rollback, and the doctor. |
| `assets/mods/spider/` | The spider panel mod. It is plain JavaScript and uses no Node APIs. |
| `assets/shared/feed.js` | The feed parser shared by the mods. Setup copies it into each mod that uses it. |
| `assets/agents/children.js` | The projection of runs, consoles, and jobs into sidebar rows, and of configured machines into the sidebar's Machines section. Setup copies it into the cloned agents mod. |
| `assets/look/`, `assets/themes/`, `assets/fonts/` | Patches, layout edits, the Herdr and pi themes, and the bundled fonts. |
| `assets/keys.json` | The five terminal key bindings. |
| `assets/shell/resume.sh` | The resume hook that the rc block sources. |
| `assets/templates/` | The role template and role instructions. |
| `assets/config.example.json` | A placeholder configuration file. |
| `scripts/` | The generator for the mod API names. See [scripts/README.md](scripts/README.md). |

## Public surface

`src/index.ts` exports the contract types, `HERDR_LABELS`, `HERDR_KINDS`, `HerdrLabelContract`, the IPC argv and message parsers, `parseHerdrConfig`, `parseFeed`, `createHcClient`, `createHcEventStream`, `createAppClient`, `HerdrError`, and the terminal and program-status parsers. The `./*` export map also exposes each module directly, for example `@spider/herdr/ssh/shim`.

The setup CLI takes these commands:

```sh
node <installed-package>/dist/herdr/cli.mjs setup [--config <absolute-file>] [--overwrite-unowned-keys] [--allow-staging-app] [--adopt-existing-space <name>]...
node <installed-package>/dist/herdr/cli.mjs doctor [--config <absolute-file>]
node <installed-package>/dist/herdr/cli.mjs rollback [--config <absolute-file>]
node <installed-package>/dist/herdr/cli.mjs admin [--session-id <id>] --wrapper <absolute-path> --reason <text> --destination <managed-machine> -- <argv...>
```

Without `--config`, setup, doctor, and rollback use the path in the global `herdr.config` setting, or else `<global spider directory>/herdr/config.json`. The admin command takes no `--config` and always uses that lookup. A `herdr.config` or `herdr.enabled` in repository settings has no effect on the CLI, and the CLI prints a warning for it. Setup and rollback refuse to run inside a pi process or a subagent child. They also refuse when the configured `agentDirectory` differs from the shell's pi agent directory. Usage errors exit 2, failures exit 1, and success exits 0. The admin command exits with the wrapper's exit code. Run the CLI with `--help` for the full list, which also covers the commands that the resume block, the mods, and the SSH shim call.

## How it fits

`@spider/herdr` sits between the action and service packages and `@spider/host`:

- It imports from `@spider/db-core`, from `@spider/models` for role defaults, and the `Language` type from `@spider/context`. Its `package.json` does not list these workspace dependencies.
- `@spider/context` imports only contract types from it, for remote execution ports.
- `@spider/subagents` imports `finalChildEnvironment` from `ssh/shim`, so children get the same SSH `PATH` shim and environment.
- `@spider/host` composes it in `host/src/herdr/mount.ts` for a top-level session and `host/src/herdr/child.ts` for a subagent child. Host passes adapters for pi and the databases into the `register*` functions it composes, and supplies the data source, transcript source, and shortcut views from `host/src/herdr/`.

Each `register*` function takes pi's `ExtensionAPI` and registers its own pi event handlers. Each returns a disposable, so host can remove them on shutdown.

Each part runs in its own process:

- The status adapter, feed publisher, IPC endpoint, and job monitor run inside the owning pi process. A subagent child runs its own job monitor and remote executor.
- The mods run inside the Herdr app.
- A viewer or remote observer runs as a separate Node program in a local `hc` terminal.
- The remote runtime runs on the destination machine, for each job and for each agent console. It uses only Node built-ins and never imports pi, SQLite, or `@spider/context`.
- Setup runs from a plain shell. The admin command runs from a plain shell or from an agent's wrapper script.

## Notes

- Feeds are written atomically with user-only permissions. Readers reject symlinks, oversized files, and unknown versions.
- The IPC endpoint is a Unix socket under `herdr/ipc` with a per-generation capability file. It has no TCP listener and allows only `ping`, `openView`, `openRun`, `openJob`, `subscribeRun`, and `steerRun`.
- Mods reach pi only through the IPC client, started with Herdr's bounded `exec`. No path in this package writes text into a pi terminal's input.
- Each installed mod copy has a unique `modId` that equals its directory name.

## Tests

The default suite runs every scenario against a fake `hc` (`src/__tests__/fake-hc.mjs`) and a fake app. Scrubbed recordings in `src/__tests__/recordings/` pin the real reply shapes. `vitest.setup.ts` removes every `HC_*` and `HERDR_*` variable and puts stubs that refuse to run first on `PATH`. To also drive a real `hc` in isolated local and remote cores, set `SPIDER_HERDR_E2E=1`. Real mode fails rather than skips when it cannot prove isolation.

## License

The code is MIT. The bundled fonts are under the SIL Open Font License 1.1. Portions of `assets/look/patches.json` are derived from Herdr's built-in mods under the Apache License 2.0. The package license is `MIT AND OFL-1.1 AND Apache-2.0`. See [LICENSE](LICENSE), the notices in `assets/fonts/`, and `assets/look/NOTICE`.
