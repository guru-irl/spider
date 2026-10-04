# spider

Spider is a [pi coding-agent](https://github.com/earendil-works/pi) extension for memory, search, todos, subagents, execution, web fetch, and skills.
It exposes one `spider` tool backed by local SQLite databases.
It replaces `pi-subagents`, `context-mode`, and the standalone todo tool.

## Features

- Memory: reviewed notes with global or repository scope, injected as a frozen per-session snapshot.
- Search: full-text and vector search over memory, content, sessions, and todos.
- Todos: persistent session lists with a live overlay.
- Subagents: background children, parallel tasks, chains, and pipelines.
- Execution: run scripts and filter output before it enters model context.
- Reference material: fetch, index, and import content for later searches.
- Skills: bundled procedures, staged proposals, and explicit approval.
- Background learning: propose memory and skills from session activity.

## Requirements

- Use Node 26 for installation and running pi so native modules use the same ABI. Development pins `26.4.0`; all CI workflows use `26.x`. The package declares `>=22.19.0`, but lower versions are not tested by those workflows.
- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` `>=0.87.0`.
- Native dependencies: `better-sqlite3` (Node addon) and `sqlite-vec` (platform library). Build the addon for the Node ABI used by pi.
- If a native prebuild is unavailable, building `better-sqlite3` requires Python and a C/C++ toolchain for `node-gyp`.
- CI runs on Linux. Other operating systems are not covered by the workflows.
- Default reviewers and background learning use `github-copilot/gpt-6-luna`; authenticate GitHub Copilot through pi's `/login`, or [configure another authenticated provider](docs/guide/configuration.md#reviewer-and-learner-models).

## Install, update, and remove

```bash
git clone https://github.com/guru-irl/spider.git
cd spider
npm ci
npm run build
npm run link
```

- `npm ci` installs build dependencies and runs native checks and the `prepare` build. The explicit build verifies the bundle too.
- `npm run link` writes `~/.pi/agent/extensions/spider.ts`, a loader shim pointing at this clone's `dist/extension.js`. It removes the development shim if present.
- In pi, run `/reload` or start a new process, then `/doctor` to check native modules, databases, config, and bundle identity.
- `pi install git:` is not supported yet: pi installs without dev dependencies, and spider's build needs them.
- Keep the clone at its linked path. See [Linked shims](docs/architecture/runtime-lifecycle.md#linked-shims) for loading precautions and fallback behavior.

To update, run in the clone:

```bash
git pull
# If package-lock.json changed, quit pi before running:
npm ci
npm run build
```

- If the update ran `npm ci`, start pi again after the build. `/reload` only refreshes the bundle, not dependencies or native modules.
- For pulls that did not change the lockfile, use `/reload` after the build. If `/doctor` says `RESTART NEEDED`, restart pi instead.
- To uninstall, run `npm run unlink` in the clone. If you used `npm run dev:link`, also run `npm run dev:unlink`. Quit pi and delete the clone.
- Remove the managed block described under [Data and privacy](#data-and-privacy) from `~/.pi/agent/AGENTS.md`, then restart pi if needed. Unlinking does not remove that block or local databases.
- For full removal, also delete `~/.pi/agent/spider/`, `<git-common-dir>/spider/` and `<worktree>/.spider/` in each repo you used; see the [tier table](#data-and-privacy).

## Quickstart

- Run `/doctor` and fix any reported failures.
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

- Save a durable project fact with a reason and a source:

```text
spider remember scope:"repo" category:"convention" content:"Use the test gate in package.json" link:"package.json" justification:"The gate remains useful after this task; other agents need it; it is specific to this repository."
```

- To replace an active note, include `supersedes:["<uuid-or-unique-prefix>"]` in a foreground `remember` call. Targets must be active in the same scope; unknown, ambiguous, inactive or cross-scope targets reject without a write. The cap check credits their current sizes, and archives and insertion happen atomically. The reviewer still checks durability, usefulness and scope; explicit replacement also works when review is unavailable. Staged/auto writes do not support explicit `supersedes`, and staged approval never archives related entries. See [Memory and learning](docs/guide/memory-and-learning.md).
- Use `/memory` to read notes and `/agents` to inspect child runs.
- Load an applicable skill before non-trivial work: `spider skill op:"list"`.
- These examples describe tool calls for the agent, not terminal commands.

## Usage reference

### `spider` actions

| Action | Use |
| --- | --- |
| `search` | Search memory, content, sessions, and todos; filter with `kinds`. |
| `remember` | Propose durable memory with `content`, `category`, and `justification`; optional `supersedes` replaces active same-scope UUIDs or unique prefixes. |
| `recall` | Read active memory; filter by `query`, `category`, or `scope`. |
| `exec` | Execute a script with `language` and `code`. |
| `exec_file` | Load a file into a script for analysis. |
| `batch` | Execute a sequence of commands. |
| `index` | Index a file, directory, or supplied content. |
| `fetch` | Fetch and index URLs; use `force:true` to bypass cache. |
| `run` | Start a child task, `tasks`, `chain`, or `pipeline`. |
| `kill` | Stop a run by ID, prefix, name, or `id:"all"`. |
| `todo` | `add`, `list`, `toggle`, `remove`, `clear`, `sessions`, or `view`. |
| `skill` | `list`, `view`, `distill`, `add`, `approve`, or `reject`. |
| `import` | Import local pi session transcripts. |
| `message` | Send text to a peer session or steer an owned RPC child. |
| `control` | Run the administrative commands below. |

### `spider control` commands

- `doctor`: health checks and loaded-versus-installed bundle status.
- `config`: read, set, or unset configuration keys.
- `memory`: `pending`, `approve`, `reject`, `status`, or `forget`.
- `models`: list the catalog; `op:"set"` sets a global role default; `control models clear` (`op:"clear"`) removes only the local role override.
- `stats`: token savings and row counts.
- `insights`: inspect the learning graph.
- `skill sub:"curate"`: run skill curation; optional `force` and `consolidate`.
- `migrate`: preview legacy data migration; `apply:true` applies it after backups.
- `bind` / `unbind`: set or remove a session's worktree binding.
- `upstream-watch`: inspect vendored upstream changes or mark a reviewed baseline.

### Slash commands and overlays

- `/spider`, `/stats`: statistics dashboard.
- `/search <query>`: unified search; `/memory`: active memory.
- `/doctor`: health check; `/insights`: learning graph.
- `/learn <note>`: queue a skill-distillation prompt; it does not approve a skill.
- `/bind <path>`: bind this session to a worktree.
- `/exec-enforce on|off`: user-controlled bash enforcement in worktree-local config, not other repos; no argument reports the current state.
- `/todos`: live todo overlay.
- `/agents` or `alt+shift+up`: run selector; `Enter` opens details, `k` twice confirms killing a run.
- `ui.footer=false` disables the footer and run selector from the next session.

## Configuration

- Keys are flat JSON properties with dots, for example `"organism.enabled": false`.
- Precedence: built-in defaults, then `~/.pi/agent/spider/config.json`, then `<worktree>/.spider/config.json`, except `subagents.extensions`, which is read from global config only.
- `SPIDER_GLOBAL_ROOT` overrides the global root and must be absolute (drive-qualified or UNC on Windows). A relative value, including a Windows root-relative path, stops spider from loading with `paths: SPIDER_GLOBAL_ROOT must be absolute; received "<value>"`. An empty value is treated as unset.
- For writes, `scope:"global"` selects global config; omitted scope or `scope:"repo"` selects worktree-local config. Other write scopes are rejected.
- `get` reports effective values and their sources; global writes report local shadowing.
- Set/unset accept only known keys; values must follow the [validation rules](docs/guide/configuration.md#validation).

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
- Reviewers: `memory.reviewer.enabled` and `skills.reviewer.enabled` default to `true`.
- `models.defaults` maps roles to model references; local values override global values per role.
- `memory.snapshotCharCap` defaults to unlimited injection of active memory; it does not change the storage cap.
- `exec.enforce` defaults to `true` and cannot be changed through the model-facing config action.
- See [Configuration](docs/guide/configuration.md) for defaults, provenance, validation, and when changes take effect.

## Data and privacy

| Tier | Location | Data |
| --- | --- | --- |
| Global | `~/.pi/agent/spider/spider.db` | Global memory, project registry, bindings, messages, insights, model stats, run routes, upstream baselines. |
| Repository | `<git-common-dir>/spider/repo.db` | Memory, skills, embeddings, curator state, skill review queue. |
| Worktree | `<worktree>/.spider/project.db` | Sessions, runs, todos, content, events, embeddings. |

- Sibling worktrees share repository memory and skills, not runs or todos.
- Scratch and logs live under `<worktree>/.spider/`; global work uses `~/.pi/agent/spider/`.
- On activation, spider writes a managed block between `<!-- spider:start -->` and `<!-- spider:end -->` in `~/.pi/agent/AGENTS.md`. Keep personal notes outside those markers; managed edits are overwritten.
- Databases, local config, logs, and scratch are machine-local state. Never commit them; this repository ignores the worktree artifacts.
- Local storage does not mean offline operation: model calls send prompts to configured providers, fetch downloads URLs, and embedding initialization can download a model.
- Memory and skill reviewers and background learning can send candidate text, active memory, skill guidance, or conversation excerpts to a model provider.
- Treat databases, transcripts, fetched content, and logs as potentially sensitive. Secret scanning is not a guarantee of removal.
- See [Data model](docs/architecture/data-model.md) for path resolution, binding, and legacy migration.

## Subagents

- Runs report asynchronously through `spider.subagent_done`; there is no blocking wait.
- Set an explicit provider-qualified `model` and a suitable `thinking` level.
- For `tasks`, `chain`, and `pipeline`, put `model` and `thinking` on each item, not at the top level.
- Runs stay in the dispatching session's database even when a child has a different `cwd`.
- `/reload` preserves eligible children, but stops chains and does not resume later pipeline stages. Quit and session replacement stop owned children.
- See [Subagents](docs/guide/subagents.md) for dispatch, shutdown, escalation, and delivery guarantees.

## Background learning

- The organism (background learner) runs in parent sessions only at compaction and shutdown; a drain processes accumulated session activity.
- Background memory writes are staged; approve or reject them through `control memory`.
- The first `before_agent_start` freezes the memory block for that session. New writes and approvals persist immediately but enter the prompt next session; use `recall` to read them sooner.
- A different session ID or file, an extension reload, or a changed memory binding target takes a fresh snapshot. Each subagent session freezes its own block.
- Skill proposals are reviewed and staged, never automatically activated.
- Disable automatic work with `organism.enabled:false`; configure foreground reviewers separately.
- See [Memory and learning](docs/guide/memory-and-learning.md) for model defaults, limits, and failure behavior.

## Sandboxed execution

- Use `spider exec`, `exec_file`, or `batch` to print only the output you need.
- Bash enforcement redirects the agent to spider execution; it is not an OS security boundary.
- See [Using spider](docs/guide/using-spider.md#execution) for examples, background receipts, exit status, and cleanup cautions.

## Troubleshooting

- Native module or Node ABI mismatch: follow [Requirements](#requirements), run `npm rebuild better-sqlite3` in your linked clone (the `spider/` directory created above), restart pi, and run `/doctor`. If an update reruns `npm ci`, it replaces that manual rebuild; keep the Node version consistent.
- `sqlite-vec` failure: check `/doctor` and [native install diagnostics](docs/architecture/runtime-lifecycle.md#install-time-native-checks) for the effect on search.
- Stale bundle: follow `/doctor`'s remedy. Direct loads require a restart; current linked shims support `/reload` after a completed rebuild.
- Old shim or moved checkout: rerun `npm run link` or `npm run dev:link`, then restart pi once.
- Duplicate tool registration: follow the [linked-shim loading precautions](docs/architecture/runtime-lifecycle.md#linked-shims).
- Invalid config: repair the JSON file named by `/doctor`; reads skip malformed layers, and writes refuse to overwrite them.
- Reviewer or learner model unavailable: follow [model configuration and failure behavior](docs/guide/configuration.md#reviewer-and-learner-models); inspect `/doctor` and local reviewer logs.
- See [Runtime lifecycle](docs/architecture/runtime-lifecycle.md) for cache behavior and reload limits.

## Contributing and documentation

- [Contributing](CONTRIBUTING.md): setup, test isolation, package boundaries, lockfile checks, and PR requirements.
- [Documentation index](docs/README.md): guides, architecture, package references, and UI development.
- [Architecture](docs/architecture/README.md): package interactions and call flow.
- [Feedback and learning loops](docs/architecture/feedback-and-learning-loops.md): routing and learning diagrams.
- [Release process](docs/release-process.md): tagged builds and publishing.

## License

- [MIT](LICENSE).
