# spider

Spider is a [pi coding-agent](https://github.com/earendil-works/pi) extension for memory, search, todos, subagents, execution, web fetch, and skills.
It adds one `spider` tool, which keeps its data in local SQLite databases.
It replaces `pi-subagents`, `context-mode`, and the standalone todo tool.

## Features

- Memory: reviewed notes, scoped either globally or to one repository. Each session gets a fixed snapshot of them in its prompt.
- Search: full-text and vector search over memory, content, sessions, and todos.
- Todos: per-session lists that persist, with a live overlay.
- Subagents: child runs in the background, as single tasks, parallel tasks, chains, or pipelines.
- Execution: run scripts and filter their output before it enters the model's context.
- Reference material: fetch, index, and import content to search later.
- Skills: bundled procedures, plus proposed skills that wait in a staging queue until someone approves them.
- Background learning: proposes memory and skills from session activity.
- [Compaction](docs/guide/compaction.md): opt-in thresholds per model, and spider-managed summaries of the parent session, with a limit on how many files they list.
- [Loops and scheduled wakeups](docs/guide/loop-and-schedule.md): named interval, cron, self-paced, and one-shot triggers that keep wall-clock due times across reload and same-session resume.

Spider bundles the superpowers workflow skills and 31 skills adapted from [pstack](https://github.com/michael-denyer/pstack-claude). The pstack set includes `how`, `why`, `teach`, writing guidance and decision principles. `spider skill` lists and views both collections next to project skills, and shows each skill's source even when names overlap. Background curation never touches bundled skills.

## Requirements

- Use Node 26 to install spider and to run pi, so that native modules use the same ABI. Development pins `26.4.0`, and all CI workflows use `26.x`. The package declares `>=22.19.0`, but those workflows do not test lower versions.
- Pi `1.2.0` or later, including `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` and `@earendil-works/pi-tui`. Development and tests use `1.2.0`. Older hosts are not supported.
- Native dependencies are `better-sqlite3` (a Node addon) and `sqlite-vec` (a platform library). Build the addon for the Node ABI that pi uses.
- If no native prebuild is available, building `better-sqlite3` needs Python and a C/C++ toolchain for `node-gyp`.
- CI runs on Linux. The workflows do not cover other operating systems.
- Memory review and background learning use `github-copilot/gpt-6-luna`. Skill review uses `github-copilot/gpt-6-luna` at xhigh thinking. Sign in to GitHub Copilot with pi's `/login`, or [configure another authenticated provider](docs/guide/configuration.md#reviewer-and-learner-models).

## Install, update, and remove

```bash
git clone https://github.com/guru-irl/spider.git
cd spider
npm ci
npm run build
npm run link
```

- `npm ci` installs the build dependencies, runs the native checks, and runs the `prepare` build. The explicit build then checks the bundle as well.
- `npm run link` writes `~/.pi/agent/extensions/spider.ts`, a small loader file (a shim) that points at this clone's `dist/extension.js`. It removes the development shim if one exists.
- In pi, run `/reload` or start a new process. Then run `/doctor` to check native modules, databases, config, and which bundle is loaded.
- `pi install git:` is not supported yet. Pi installs packages without dev dependencies, and spider's build needs them.
- Keep the clone at the path you linked. See [Linked shims](docs/architecture/runtime-lifecycle.md#linked-shims) for loading precautions and fallback behavior.

To update, run these commands in the clone:

```bash
git pull
# If package-lock.json changed, quit pi before running:
npm ci
npm run build
```

- If the update ran `npm ci`, start pi again after the build. `/reload` refreshes only the bundle, not dependencies or native modules.
- If the pull did not change the lockfile, run `/reload` after the build. If `/doctor` says `RESTART NEEDED`, restart pi instead.
- To uninstall, run `npm run unlink` in the clone. If you used `npm run dev:link`, also run `npm run dev:unlink`. Then quit pi and delete the clone.
- Remove the managed block described under [Data and privacy](#data-and-privacy) from `~/.pi/agent/AGENTS.md`, then restart pi if needed. Unlinking does not remove that block or the local databases.
- To remove everything, also delete `~/.pi/agent/spider/`, `<git-common-dir>/spider/` and `<worktree>/.spider/` in each repo you used. The [tier table](#data-and-privacy) lists what each one holds.

## Quickstart

- Run `/doctor` and fix any failures it reports.
- Ask the agent to index reference material, then search it:

```text
spider index path:"docs/"
spider search query:"deployment steps"
```

- Add work to the session list, then open `/todos`:

```text
spider todo op:"add" text:"Add a regression test for retries"
spider todo op:"list"
```

- Save a lasting project fact with a reason and a source:

```text
spider remember scope:"repo" category:"convention" content:"Use the test gate in package.json" link:"package.json" justification:"The gate remains useful after this task; other agents need it; it is specific to this repository."
```

- To replace an active note, add `supersedes:["<uuid-or-unique-prefix>"]` to a foreground `remember` call. Each target must be active and in the same scope. If a target is unknown, ambiguous, inactive or in another scope, the call is rejected and nothing is written. The size cap check subtracts the targets' current sizes, and spider archives the targets and inserts the new note in one atomic step. The reviewer still checks that the note is durable, useful and correctly scoped. Explicit replacement also works when review is unavailable. Staged and automatic writes do not support explicit `supersedes`, and approving a staged write never archives related entries. See [Memory and learning](docs/guide/memory-and-learning.md).
- Use `/memory` to read notes and `/agents` to inspect child runs.
- Before non-trivial work, load a skill that applies. To find one, run `spider skill op:"list"`.
- These examples are tool calls for the agent, not terminal commands.

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
| `loop` | Define a named interval, zoned `cron`, or self-paced trigger. Cron has no immediate first prompt. No definition fields lists all triggers. `stop:true` stops only the named loop and re-arm, not an independent one-shot. |
| `schedule` | Define a named one-shot with `delaySeconds` or offset-bearing `at`. Relative delays clamp to 60 through 3600. Replace or cancel only that name. Re-arm a self-paced loop with its exact name and prompt. |
| `control` | Run the administrative commands below. |

### `spider control` commands

- `doctor`: runs health checks and compares the loaded bundle with the installed one.
- `config`: reads, sets, or unsets configuration keys.
- `memory`: `pending`, `approve`, `reject`, `status`, or `forget`.
- `models`: lists the model catalog. `op:"set"` sets a global default for a role. `control models clear` (`op:"clear"`) removes only the local override for a role.
- `stats`: shows token savings and row counts.
- `insights`: inspects the learning graph.
- `skill sub:"curate"`: runs skill curation, with optional `force` and `consolidate`.
- `migrate`: previews migration of legacy data. `apply:true` backs up the data and then applies the migration.
- `bind` / `unbind`: sets or removes a session's worktree binding.
- `upstream-watch`: inspects changes in vendored upstream code, or marks a reviewed baseline.

### Slash commands and overlays

- `/spider`, `/stats`: statistics dashboard.
- `/search <query>`: unified search. `/memory`: active memory.
- `/doctor`: health check. `/insights`: learning graph.
- `/usage`: opens the local usage dashboard in a parent pi session.
- `/learn <note>`: queues a prompt to distill a skill. It does not approve a skill.
- `/bind <path>`: binds this session to a worktree.
- `/exec-enforce on|off`: the user's switch for bash enforcement. It writes worktree-local config and does not affect other repos. With no argument it reports the current state.
- `/todos`: live todo overlay.
- `/agents` or `alt+shift+up`: run selector. `Enter` opens details, and pressing `k` twice confirms killing a run.
- `/loop [5m|1h] <prompt>`: checks external work right away and then at a fixed interval, or at the agent's own pace if you give no interval. `/loop` lists all triggers and usage. `/loop stop` stops default `loop` and `wakeup`; `/loop stop <name>` stops one name and `/loop stop all` stops all. `/loop stop <words>` is a stop request or usage error, not a prompt.
- Loops and wakeups need a persistent top-level session. They survive `/reload` and same-session resume; new sessions and forks start empty. Nothing fires while closed or asleep. Missed once and cron runs fire once late; intervals resume from their anchor without catch-up. Do not use them to poll subagents, because completion notices arrive on their own.
- `ui.footer=false` turns off the agents widget and the run selector from the next session on. It does not turn off the usage footer.
- [Usage dashboard](docs/guide/usage.md): the credits footer, the local ledger, the account counter, collection health and doctor diagnostics. The footer shows, separated by middle dots: context percentage and window size, session credits, cache-hit rate (`CH`), `month` as a whole percentage, input and output tokens, and cache read and write tokens.

### Dashboard

- The local dashboard has three pages: Overview, Session, and Calibration & data. It shows credits by default, and a switch changes the view to Tokens. To set an optional monthly budget (a positive number), run `/spider config set usage.monthlyBudget <credits> --global`. To remove it, run `/spider config unset usage.monthlyBudget --global`. The footer's `month` item uses the budget when one is set, and otherwise the account allowance. If neither is available, the footer leaves it out. See [Usage dashboard](docs/guide/usage.md) for controls, correction and recovery.

## Configuration

- Keys are flat JSON properties with dots in their names, for example `"organism.enabled": false`.
- Precedence, from lowest to highest: built-in defaults, then `~/.pi/agent/spider/config.json`, then `<worktree>/.spider/config.json`. The exceptions are `subagents.extensions` and the usage keys, which spider reads from global config only.
- `SPIDER_GLOBAL_ROOT` overrides the global root and must be an absolute path (drive-qualified or UNC on Windows). A relative value, including a Windows root-relative path, stops spider from loading with `paths: SPIDER_GLOBAL_ROOT must be absolute; received "<value>"`. Spider treats an empty value as unset.
- For writes, `scope:"global"` selects global config. An omitted scope or `scope:"repo"` selects worktree-local config. Spider rejects any other write scope.
- `get` reports the effective values and where each came from. Global writes report when a local value shadows them.
- Set and unset accept only known keys, and values must follow the [validation rules](docs/guide/configuration.md#validation).

```text
spider control command:"config" op:"get"
spider control command:"config" op:"set" key:"organism.enabled" value:false scope:"repo"
spider control command:"config" op:"unset" key:"organism.enabled" scope:"repo"
# To use an authenticated alternative to the default reviewer and learner:
spider control command:"config" op:"set" key:"memory.reviewer.model" value:"provider/model" scope:"global"
spider control command:"config" op:"set" key:"skills.reviewer.model" value:"provider/model" scope:"global"
spider control command:"config" op:"set" key:"auxiliary.background_review.model" value:"provider/model" scope:"global"
```

- Common keys: `organism.enabled` (default `true`), `subagents.childMode` (`"rpc"`), `ui.footer` (`true`).
- Usage keys, global only: `usage.footer` and `usage.counter.poll` default to `true`. `usage.alerts.sessionCredits` and `usage.alerts.runCredits` default to `0`. `usage.calibration` defaults to `auto`. `auto` uses counter evidence when there is enough of it. With `off`, it shows published estimates and keeps no factor history. `usage.monthlyBudget` is an optional positive credit budget and is unset by default. Changes to the footer, polling, calibration and budget take effect immediately. Alerts are not implemented.
- Reviewers: `memory.reviewer.enabled` and `skills.reviewer.enabled` default to `true`.
- `models.defaults` maps roles to model references. Spider picks a model in this order: the explicit model, the local override, the global default, and the role default that ships with spider. For unknown roles, or when the catalog has no eligible model, it uses the parent's model.
- By default, `memory.snapshotCharCap` puts no limit on how much active memory spider injects. It does not change the storage cap.
- `exec.enforce` defaults to `true`. The config action that the model can call cannot change it.
- See [Configuration](docs/guide/configuration.md) for defaults, value sources, validation, and when changes take effect.

## Data and privacy

| Tier | Location | Data |
| --- | --- | --- |
| Global | `~/.pi/agent/spider/spider.db` | Global memory, project registry, bindings, messages, insights, model stats, run routes, upstream baselines. |
| Repository | `<git-common-dir>/spider/repo.db` | Memory, skills, embeddings, curator state, skill review queue. |
| Worktree | `<worktree>/.spider/project.db` | Sessions, runs, todos, content, events, embeddings. |

- Sibling worktrees share repository memory and skills. They do not share runs or todos.
- Scratch files and logs live under `<worktree>/.spider/`. Global work uses `~/.pi/agent/spider/`.
- When spider activates, it writes a managed block between `<!-- spider:start -->` and `<!-- spider:end -->` in `~/.pi/agent/AGENTS.md`. Keep personal notes outside those markers, because spider overwrites anything inside them.
- Databases, local config, logs, and scratch files are state for one machine. Never commit them. This repository's ignore rules already cover the worktree files.
- Local storage does not mean spider works offline. Model calls send prompts to the providers you configure, fetch downloads URLs, and setting up embeddings can download a model in the background. While the embedder starts up, recall and search use full-text results. Once it is ready, they can also use existing vectors. Parent sessions work through queued embeddings in the background in a separate fastembed child process. This keeps aborts during native ORT teardown out of the pi process. Shutdown cancels embeds in progress and waits for the child to exit. If the parent dies, downloads and loads stop too. Child sessions never process the queue. Set `embeddings.drain` to `false` to turn off this maintenance. `/doctor` shows the health of the provider and the queue.
- The memory and skill reviewers and background learning can send candidate text, active memory, skill guidance, or conversation excerpts to a model provider.
- Pi saves the frozen global and repo memory block in the session's `spider_memory` system-prompt section. It saves an unchanged section once and records changes as patches. Compaction can save another copy in its prompt checkpoint. Old values stay in the session file. Exported HTML and JSONL can include this memory, so review them before you share them.
- Treat databases, transcripts, fetched content, and logs as possibly sensitive. Secret scanning does not guarantee that secrets are removed.
- See [Data model](docs/architecture/data-model.md) for path resolution, binding, and legacy migration.

## Subagents

- Runs report back asynchronously through `spider.subagent_done`. There is no blocking wait.
- Set an explicit provider-qualified `model` and a suitable `thinking` level.
- For `tasks`, `chain`, and `pipeline`, put `model` and `thinking` on each item, not at the top level.
- Runs stay in the database of the session that dispatched them, even when a child has a different `cwd`.
- `/reload` keeps eligible children running. It stops chains and does not resume later pipeline stages. Quitting pi or replacing the session stops the children that session owns.
- See [Subagents](docs/guide/subagents.md) for dispatch, shutdown, escalation, and delivery guarantees.

## Background learning

- The organism (spider's background learner) runs only in parent sessions, at compaction and at shutdown. A drain step processes the session activity that has built up.
- Background memory writes are staged. Approve or reject them through `control memory`.
- The first `before_agent_start` freezes the memory block in the named `spider_memory` section for that session. That includes runs started by completion notifications. New writes and approvals are saved at once but reach the prompt in the next session. Use `recall` to read them sooner.
- Spider takes a fresh snapshot when the session ID or file changes, when the extension reloads, or when the memory binding target changes. Each subagent session freezes its own block.
- Spider reviews and stages skill proposals. It never activates them automatically.
- To turn off automatic work, set `organism.enabled:false`. The foreground reviewers have their own settings.
- See [Memory and learning](docs/guide/memory-and-learning.md) for model defaults, limits, and failure behavior.

## Sandboxed execution

- Use `spider exec`, `exec_file`, or `batch` and print only the output you need.
- Bash enforcement redirects the agent to spider execution. It is not an OS security boundary.
- See [Using spider](docs/guide/using-spider.md#execution) for examples, background receipts, exit status, and cleanup cautions.

## Troubleshooting

- Native module or Node ABI mismatch: follow [Requirements](#requirements) and run `npm rebuild better-sqlite3` in your linked clone (the `spider/` directory created above). Then restart pi and run `/doctor`. If an update runs `npm ci` again, that replaces the manual rebuild, so keep the Node version the same.
- `sqlite-vec` failure: check `/doctor` and the [native install diagnostics](docs/architecture/runtime-lifecycle.md#install-time-native-checks) to see how search is affected.
- Stale bundle: do what `/doctor` suggests. A directly loaded bundle needs a restart. Current linked shims support `/reload` once a rebuild has finished.
- Old shim or moved checkout: run `npm run link` or `npm run dev:link` again, then restart pi once.
- Duplicate tool registration: follow the [linked-shim loading precautions](docs/architecture/runtime-lifecycle.md#linked-shims).
- Invalid config: fix the JSON file that `/doctor` names. Reads skip malformed layers, and writes refuse to overwrite them.
- Reviewer or learner model unavailable: follow [model configuration and failure behavior](docs/guide/configuration.md#reviewer-and-learner-models), and check `/doctor` and the local reviewer logs.
- See [Runtime lifecycle](docs/architecture/runtime-lifecycle.md) for cache behavior and reload limits.

## Contributing and documentation

- [Contributing](CONTRIBUTING.md): setup, test isolation, package boundaries, lockfile checks, and PR requirements.
- [Documentation index](docs/README.md): guides, architecture, package references, and UI development.
- [Architecture](docs/architecture/README.md): how the packages interact and how calls flow between them.
- [Feedback and learning loops](docs/architecture/feedback-and-learning-loops.md): diagrams of routing and learning.
- [Release process](docs/release-process.md): tagged builds and publishing.

## License

Spider's own code is licensed under [MIT](LICENSE).
`packages/context`, and the portions of `dist/extension.js` built from it, are licensed under the [Elastic License 2.0](packages/context/LICENSE).
See [NOTICE.md](NOTICE.md) for upstream attribution.
