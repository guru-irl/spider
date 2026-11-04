<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/spider-mark-dark.svg">
    <img src="docs/assets/spider-mark-light.svg" alt="" width="32" height="32" style="vertical-align: middle;">
  </picture>
  spider
</h1>

Spider is a [pi coding-agent](https://github.com/earendil-works/pi) extension for memory, search, todos, subagents, execution, web fetch, and skills.
It adds one `spider` tool and stores its data in local SQLite databases.
It replaces `pi-subagents`, `context-mode`, and the standalone todo tool.

## What spider adds

- Save reviewed notes globally or for one repository. Each session gets a fixed snapshot of those notes in its prompt.
- Search memory, content, sessions, and todos with full-text and vector search.
- Keep per-session todo lists that persist and open in a live overlay.
- Run child tasks in the background, individually or as parallel tasks, chains, or pipelines.
- Execute scripts and filter their output before it enters the model's context.
- Fetch, index, and import reference material for later searches.
- Use bundled skills and propose new ones. Proposed skills wait for approval in a staging queue.
- Propose memory and skills from session activity through background learning.
- Set opt-in [compaction thresholds](docs/guide/compaction.md) per model. Spider can summarize the parent session and limit the files listed in its summary.
- Define [loops and scheduled wakeups](docs/guide/loop-and-schedule.md) with names and wall-clock due times. Interval, cron, self-paced, and one-shot triggers survive reload and same-session resume.
- Use [Herdr integration](docs/guide/herdr.md) for remote execution, agent consoles, subagent viewers, and the spider panel inside a Herdr terminal workspace.

Spider bundles the superpowers workflow skills and 31 skills adapted from [pstack](https://github.com/michael-denyer/pstack-claude). The pstack set includes `how`, `why`, `teach`, writing guidance and decision principles. `spider skill` lists and views both collections next to project skills, and shows each skill's source even when names overlap. Background curation never touches bundled skills.

## Requirements

- Use Node 26 to install spider and run pi, so native modules use the same ABI. Development pins `26.4.0`, and all CI workflows use `26.x`. The package declares `>=22.19.0`, but CI does not test lower versions.
- Use pi `1.2.0` or later, including `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`. Development and tests use `1.2.0`. Older hosts are not supported.
- Spider uses `better-sqlite3`, a Node addon, and `sqlite-vec`, a platform library. Build the addon for pi's Node ABI.
- If no native prebuild is available, `better-sqlite3` needs Python and a C or C++ toolchain for `node-gyp`.
- CI runs on Linux. The workflows do not cover other operating systems.
- Memory review and background learning use `github-copilot/gpt-6-luna`. Skill review uses `github-copilot/gpt-6-luna` at xhigh thinking. Sign in to GitHub Copilot with pi's `/login`, or [configure another authenticated provider](docs/guide/configuration.md#reviewer-and-learner-models).

## Install, update, and remove

### Install a release

Install a versioned tarball from [GitHub releases](https://github.com/guru-irl/spider/releases). You do not need an npm account.
The example requires a published `v0.1.0` release.

Quit pi before installing or changing its native dependencies. Run this command in your terminal, then start pi again:

```bash
pi install npm:@guru-irl/spider@https://github.com/guru-irl/spider/releases/download/v0.1.0/guru-irl-spider-0.1.0.tgz
```

Keep `@guru-irl/spider@` before the URL. Pi needs the package name to find the installed extension.
Run `pi list` to see the configured source, then `/doctor` in pi to check the installation.
Each release includes `SHA256SUMS` for its tarball.

The URL pins the version. To refresh the installation without choosing another release, quit pi and run:

```bash
pi update npm:@guru-irl/spider@https://github.com/guru-irl/spider/releases/download/v0.1.0/guru-irl-spider-0.1.0.tgz
```

This does not select a newer release. To change versions, run `pi install` with the new release's command. Pi replaces the entry for the same package name.
Start pi again after either change.

To remove the release package, quit pi and run:

```bash
pi remove npm:@guru-irl/spider@https://github.com/guru-irl/spider/releases/download/v0.1.0/guru-irl-spider-0.1.0.tgz
```

### Install a clone for development

Use a clone if you want to change spider or build it yourself. Do not load a clone and a release package at the same time.

```bash
git clone https://github.com/guru-irl/spider.git
cd spider
npm ci
npm run link
```

`npm ci` installs development dependencies, checks native modules, and runs the `prepare` build, including the bundle checks.
`npm run link` writes `~/.pi/agent/extensions/spider.ts`, a loader file that points at the clone's `dist/extension.js`. It also removes an existing development loader.
Run `/reload` in pi or start a new process, then run `/doctor` to check the bundle, native modules, databases, and config.

Keep the clone at its linked path. See [Linked shims](docs/architecture/runtime-lifecycle.md#linked-shims) for loading precautions and fallback behavior.
Direct `pi install git:` installs are not supported. Pi omits development dependencies, which spider needs to build the unbundled source.

To update the clone, run `git pull` inside it. If `package-lock.json` changed, quit pi, run `npm ci`, then start pi again.
Otherwise, run `npm run build` and `/reload`. If `/doctor` reports `RESTART NEEDED`, restart pi instead.
Reload refreshes the bundle, not dependencies or native modules.

To remove a linked clone, run `npm run unlink` in the clone. If you used `npm run dev:link`, also run `npm run dev:unlink`.
Then quit pi and delete the clone.

### Remove stored data

Neither install path removes local databases or the managed instructions in `~/.pi/agent/AGENTS.md`.
Remove the managed block described under [Data and privacy](#data-and-privacy), then restart pi if needed.
To remove all stored data, also delete `~/.pi/agent/spider/`, `<git-common-dir>/spider/`, and `<worktree>/.spider/` in each repository you used.
The [data table](#data-and-privacy) lists what each location holds.

## Start using spider

Run `/doctor` and fix any failures it reports.
The examples below are tool calls for the agent, not terminal commands.

Ask the agent to index reference material and search it:

```text
spider index path:"docs/"
spider search query:"deployment steps"
```

Add work to the session list, then open `/todos`:

```text
spider todo op:"add" text:"Add a regression test for retries"
spider todo op:"list"
```

Save a lasting project fact with a reason and a source:

```text
spider remember scope:"repo" category:"convention" content:"Use the test gate in package.json" link:"package.json" justification:"The gate remains useful after this task; other agents need it; it is specific to this repository."
```

To replace an active note, add `supersedes:["<uuid-or-unique-prefix>"]` to a foreground `remember` call.
Each target must be active and in the same scope. An unknown, ambiguous, inactive, or out-of-scope target rejects the call without a write.
Spider subtracts the targets' sizes when checking the cap, then archives the targets and inserts the new note atomically.
The reviewer still checks durability, usefulness, and scope. Explicit replacement also works when review is unavailable.
Staged and automatic writes do not support `supersedes`, and approving a staged write never archives related entries.
See [Memory and learning](docs/guide/memory-and-learning.md).

Use `/memory` to read notes and `/agents` to inspect child runs.
Before non-trivial work, load a skill that applies. Run `spider skill op:"list"` to find one.

## Usage reference

### `spider` actions

| Action | Use |
| --- | --- |
| `search` | Search memory, content, sessions, and todos. Filter with `kinds`. |
| `remember` | Propose durable memory with `content`, `category`, and `justification`. Optional `supersedes` replaces active entries in the same scope, given as UUIDs or unique prefixes. |
| `recall` | Read active memory. Filter by `query`, `category`, or `scope`. |
| `exec` | Run a script with `language` and `code`. |
| `exec_file` | Load a file into a script for analysis. |
| `batch` | Run a sequence of commands. |
| `index` | Index a file, a directory, or content you pass in. |
| `fetch` | Fetch and index URLs. Use `force:true` to skip the cache. |
| `run` | Start a child task, `tasks`, `chain`, or `pipeline`. |
| `kill` | Stop a run by ID, prefix, name, or `id:"all"`. |
| `todo` | `add`, `list`, `toggle`, `remove`, `clear`, `sessions`, or `view`. |
| `skill` | `list`, `view`, `distill`, `add`, `approve`, or `reject`. |
| `import` | Import local pi session transcripts. |
| `message` | Send text to a peer session, or steer an RPC child that this session owns. |
| `loop` | Define a named interval, zoned `cron`, or self-paced trigger. Cron has no immediate first prompt. Omit definition fields to list triggers. `stop:true` stops only the named loop and its re-arm, not an independent one-shot. |
| `schedule` | Define a named one-shot with `delaySeconds` or offset-bearing `at`. Relative delays clamp to 60 through 3600 seconds. Replace or cancel only that name. Re-arm a self-paced loop with its exact name and prompt. |
| `control` | Run the administrative commands below. |

### `spider control` commands

| Command | Use |
| --- | --- |
| `doctor` | Check health and compare the loaded bundle with the installed one. |
| `config` | Read, set, or unset configuration keys. |
| `memory` | Use `pending`, `approve`, `reject`, `status`, or `forget`. |
| `models` | List the model catalog. `op:"set"` sets a global role default. `control models clear` with `op:"clear"` removes a local role override. |
| `stats` | Show token savings and row counts. |
| `insights` | Inspect the learning graph. |
| `skill` | Use `sub:"curate"` to run curation, with optional `force` and `consolidate`. |
| `migrate` | Preview legacy data migration. `apply:true` backs up the data and applies the migration. |
| `bind`, `unbind` | Set or remove a session's worktree binding. |
| `upstream-watch` | Inspect vendored upstream changes or mark a reviewed baseline. |

### Slash commands and overlays

| Command | Use |
| --- | --- |
| `/spider`, `/stats` | Open the statistics dashboard. |
| `/search <query>` | Run a unified search. |
| `/memory` | Read active memory. |
| `/doctor` | Check health. |
| `/insights` | Inspect the learning graph. |
| `/usage` | Open the local usage dashboard in a parent pi session. |
| `/learn <note>` | Queue a prompt to distill a skill, without approving it. |
| `/bind <path>` | Bind the session to a worktree. |
| `/exec-enforce on\|off` | Change bash enforcement in local config for this worktree only. With no argument, report its current state. |
| `/todos` | Open the live todo overlay. |
| `/agents`, `alt+shift+up` | Open the run selector. `Enter` opens details. Press `k` twice to confirm killing a run. |

Use `/loop [5m|1h] <prompt>` to check external work immediately and at a fixed interval.
Without an interval, the loop runs at the agent's own pace. `/loop` lists triggers and usage.
`/loop stop` stops the default `loop` and `wakeup`. `/loop stop <name>` stops one name, and `/loop stop all` stops all names.
Other words after `/loop stop` form a stop request or usage error, not a prompt.

Loops and wakeups require a persistent top-level session. They survive `/reload` and same-session resume, but new sessions and forks start empty.
Nothing fires while closed or asleep. Missed one-shot and cron triggers fire once, late.
Intervals resume from their anchor without catch-up. Do not poll subagents with loops, because completion notices arrive on their own.

Set `ui.footer=false` to turn off the agents widget and run selector starting with the next session. This does not turn off the usage footer.
The [usage footer](docs/guide/usage.md) shows context percentage and window size, session credits, cache-hit rate as `CH`, and `month` as a whole percentage.
It also shows input, output, cache-read, and cache-write tokens. Middle dots separate the fields.
The usage guide covers the local ledger, account counter, collection health, and doctor diagnostics.

### Dashboard

The local dashboard has three pages, Overview, Session, and Calibration & data.
It shows credits by default. A switch changes the view to Tokens.

To set a positive monthly credit budget, run `/spider config set usage.monthlyBudget <credits> --global`.
To remove it, run `/spider config unset usage.monthlyBudget --global`.
The footer's `month` field uses the budget when set, or the account allowance otherwise. It omits the field if neither is available.
See [Usage dashboard](docs/guide/usage.md) for controls, correction, and recovery.

## Configuration

Keys are flat JSON properties with dots in their names, such as `"organism.enabled": false`.
Values come from built-in defaults, then `~/.pi/agent/spider/config.json`, then `<worktree>/.spider/config.json`. Later values take precedence.
The global-only keys are `subagents.extensions`, `subagents.profiles.reviewer.excludeTools`, `herdr.config`, `herdr.enabled`, and the usage keys.

`SPIDER_GLOBAL_ROOT` overrides the global root. Use an absolute path, drive-qualified or UNC on Windows.
A relative value, including a Windows root-relative path, stops spider from loading with `paths: SPIDER_GLOBAL_ROOT must be absolute; received "<value>"`.
Spider treats an empty value as unset.

For writes, `scope:"global"` selects global config. An omitted scope or `scope:"repo"` selects worktree-local config.
Spider rejects other write scopes. `get` reports effective values and their sources. Global writes report when a local value shadows them.
Set and unset accept only known keys. Values must follow the [validation rules](docs/guide/configuration.md#validation).

```text
spider control command:"config" op:"get"
spider control command:"config" op:"set" key:"organism.enabled" value:false scope:"repo"
spider control command:"config" op:"unset" key:"organism.enabled" scope:"repo"
# To use an authenticated alternative to the default reviewer and learner:
spider control command:"config" op:"set" key:"memory.reviewer.model" value:"provider/model" scope:"global"
spider control command:"config" op:"set" key:"skills.reviewer.model" value:"provider/model" scope:"global"
spider control command:"config" op:"set" key:"auxiliary.background_review.model" value:"provider/model" scope:"global"
```

Common defaults include `organism.enabled:true`, `subagents.childMode:"rpc"`, and `ui.footer:true`.
Both `memory.reviewer.enabled` and `skills.reviewer.enabled` default to `true`.

Usage keys are global only. `usage.footer` and `usage.counter.poll` default to `true`.
`usage.alerts.sessionCredits` and `usage.alerts.runCredits` default to `0`, but alerts are not implemented.
`usage.calibration` defaults to `auto`, which uses counter evidence when enough is available. With `off`, it shows published estimates and keeps no factor history.
`usage.monthlyBudget` is an optional positive credit budget, unset by default.
Changes to the footer, polling, calibration, and budget take effect immediately.

`models.defaults` maps roles to model references. Spider checks the explicit model, local override, global default, then the role default bundled with spider.
For unknown roles, or when the catalog has no eligible model, it uses the parent's model.

By default, `memory.snapshotCharCap` does not limit active memory injected into the prompt. It does not change the storage cap.
`exec.enforce` defaults to `true`, and the model-callable config action cannot change it.
See [Configuration](docs/guide/configuration.md) for defaults, sources, validation, and when changes take effect.

## Data and privacy

| Tier | Location | Data |
| --- | --- | --- |
| Global | `~/.pi/agent/spider/spider.db` | Global memory, project registry, bindings, messages, insights, model stats, run routes, upstream baselines. |
| Repository | `<git-common-dir>/spider/repo.db` | Memory, skills, embeddings, curator state, skill review queue. |
| Worktree | `<worktree>/.spider/project.db` | Sessions, runs, todos, content, events, embeddings. |

Sibling worktrees share repository memory and skills, but not runs or todos.
Temporary files and logs live under `<worktree>/.spider/`. Global work uses `~/.pi/agent/spider/`.
Spider writes a managed block between `<!-- spider:start -->` and `<!-- spider:end -->` in `~/.pi/agent/AGENTS.md` when it activates.
Keep personal notes outside the markers. Spider overwrites their contents.

Databases, local config, logs, and temporary files belong to one machine. Never commit them.
This repository's ignore rules cover the worktree files.

Local storage does not make spider offline. Model calls send prompts to configured providers, fetch downloads URLs, and embeddings setup can download a model in the background.
Recall and search use full-text results while the embedder starts. Once ready, they can also use existing vectors.
Parent sessions process queued embeddings in a separate fastembed child process. This keeps aborts during native ORT teardown out of pi.
Shutdown cancels in-progress embeddings and waits for the child to exit. If the parent dies, downloads and loads stop too.
Child sessions never process the queue. Set `embeddings.drain:false` to disable this maintenance.
Run `/doctor` to check provider and queue health.

Memory review, skill review, and background learning can send candidate text, active memory, skill guidance, or conversation excerpts to a model provider.
Pi saves the frozen global and repository memory block in the session's `spider_memory` system-prompt section.
It saves an unchanged section once and records changes as patches. Compaction can save another copy in its prompt checkpoint.
Old values remain in the session file. Exported HTML and JSONL can include this memory, so review them before sharing.

Treat databases, transcripts, fetched content, and logs as potentially sensitive. Secret scanning does not guarantee removal.
See [Data model](docs/architecture/data-model.md) for path resolution, binding, and legacy migration.

## Subagents

Runs report back asynchronously through `spider.subagent_done`. There is no blocking wait.
Set an explicit provider-qualified `model` and a suitable `thinking` level.
For `tasks`, `chain`, and `pipeline`, put these fields on each item, not at the top level.
Runs stay in the database of the dispatching session, even when a child has a different `cwd`.

`/reload` keeps eligible children running. It stops chains and does not resume later pipeline stages.
Quitting pi or replacing the session stops that session's children.
See [Subagents](docs/guide/subagents.md) for dispatch, shutdown, escalation, and delivery guarantees.

## Background learning

Spider's background learner runs only in parent sessions, at compaction and shutdown.
A drain step processes accumulated session activity. Background memory writes are staged. Approve or reject them through `control memory`.
Spider reviews and stages skill proposals, but never activates them automatically.

The first `before_agent_start` freezes the memory block in the session's `spider_memory` section, including runs started by completion notifications.
New writes and approvals persist at once, but enter the prompt in the next session. Use `recall` to read them sooner.
Spider takes a fresh snapshot when the session ID or file changes, the extension reloads, or the memory binding target changes.
Each subagent freezes its own snapshot.

Set `organism.enabled:false` to turn off automatic learning. Foreground reviewers have separate settings.
See [Memory and learning](docs/guide/memory-and-learning.md) for model defaults, limits, and failure behavior.

## Sandboxed execution

Use `spider exec`, `exec_file`, or `batch`, and print only the output you need.
Bash enforcement redirects the agent to spider execution. It is not an operating-system security boundary.
See [Using spider](docs/guide/using-spider.md#execution) for examples, background receipts, exit status, and cleanup cautions.

## Herdr

When pi runs in a [Herdr](docs/guide/herdr.md) terminal, spider shows its work in the Herdr window. It never types into the pi editor.
Outside Herdr, or with the global setting `herdr.enabled:false`, spider runs as usual.

`spider exec`, `exec_file`, and `batch` accept an `on` machine name. Each agent gets one console per machine, and pi receives the command's full output.
Subagents can also use `on`. Spider refuses plain `ssh` and other SSH transports to managed machines, directing you to `on` instead.
An audited admin command handles repairs that need SSH.

The left sidebar lists sessions, subagent runs, consoles, and live commands, plus each configured machine's status.
Each subagent run gets a viewer with a separate steering message box.
The spider panel shows items that need your attention in the selected space, session todos, triggers, credits this month, and the month's credit pace.

Run setup once from a plain shell with a config file outside the repository. The supported setup uses `hc` `0.1.16` and `herdr-app` `0.1.11`.
Run `/herdr-setup` in pi to print the exact commands.
See [Herdr integration](docs/guide/herdr.md) for setup, configuration, the sidebar, shortcuts, resume, and doctor checks.

## Troubleshooting

If native modules fail or report a Node ABI mismatch, check [Requirements](#requirements).
For a linked clone, run `npm rebuild better-sqlite3` inside the clone, restart pi, and run `/doctor`.
A later `npm ci` replaces the manual rebuild, so keep the Node version consistent.
For a release install, quit pi, remove the package with `pi remove`, and install it again using pi's Node version.

If `sqlite-vec` fails, check `/doctor` and the [native install diagnostics](docs/architecture/runtime-lifecycle.md#install-time-native-checks) for the effect on search.

If the bundle is stale, follow `/doctor`. A directly loaded bundle needs a restart. Current linked loaders support `/reload` after a rebuild.
For an old loader or moved checkout, run `npm run link` or `npm run dev:link` again, then restart pi once.
For duplicate tool registration, follow the [linked-shim precautions](docs/architecture/runtime-lifecycle.md#linked-shims).

If config is invalid, fix the JSON file named by `/doctor`. Reads skip malformed layers, but writes refuse to overwrite them.
If a reviewer or learner model is unavailable, check the [model settings and failure behavior](docs/guide/configuration.md#reviewer-and-learner-models), `/doctor`, and the local reviewer logs.
See [Runtime lifecycle](docs/architecture/runtime-lifecycle.md) for cache behavior and reload limits.

## Contributing and documentation

- Read [Contributing](CONTRIBUTING.md) for setup, test isolation, package boundaries, lockfile checks, and PR requirements.
- The [documentation index](docs/README.md) links guides, architecture, package references, and UI development.
- Read [Architecture](docs/architecture/README.md) for package interactions and call flow.
- [Feedback and learning loops](docs/architecture/feedback-and-learning-loops.md) has diagrams of routing and learning.
- Follow the [release process](docs/release-process.md) to publish a tagged build.

## License

Spider's own code is licensed under [MIT](LICENSE).
`packages/context` and the portions of `dist/extension.js` built from it use the [Elastic License 2.0](packages/context/LICENSE).
See [NOTICE.md](NOTICE.md) for upstream attribution.
