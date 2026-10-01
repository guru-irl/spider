# spider

Spider is one pi coding-agent extension. It puts memory, unified search, todos,
subagents, sandboxed execution, web fetch, and a skills library on a single
shared SQLite database. It replaces three older pi extensions: `pi-subagents`,
`context-mode`, and a standalone todo tool.

## The single-tool model

The agent has one tool, named `spider`. Every operation is an `action` on that
tool (`search`, `remember`, `recall`, `exec`, `exec_file`, `batch`, `index`,
`fetch`, `run`, `kill`, `todo`, `skill`, `import`, `message`, `control`). Admin
surfaces sit behind `spider control <command>` (`doctor`, `config`, `memory`,
`stats`, `models`, `insights`, `migrate`, `bind`, `unbind`, `curate`,
`upstream-watch`). Slash commands are a thin front for the same actions and
render through the same code path, so a slash result and the matching tool
result look identical.

## Requirements

- **Node 26.** The extension loads two native modules, `better-sqlite3` (SQL)
  and `sqlite-vec` (vector search). These are compiled against a specific Node
  ABI **at install time** — `node-gyp` builds `better-sqlite3` from source, and
  nothing native is checked into the repo (`dist/` and `node_modules/` are both
  gitignored) — so the install-time Node must match the Node that pi runs.
  Spider pins Node 26.4.0 (the `volta` field in `package.json`), and that is the
  only version any CI workflow builds or tests against (`ci.yml`, `release.yml`,
  and `publish.yml` all pin `node-version: '26.x'`). `engines` allows
  `>=22.19.0`, but that lower bound is a declared minimum only — nothing in the
  repo builds or tests on anything below 26.x, so it is unverified. On a
  different major version the native modules fail to load and vector search
  degrades to full-text search only.
- pi coding-agent 0.85.1 or later for default RPC children. RPC requires `--exclude-tools`, `--name`, `agent_settled` and `clear_queue`, verified in 0.85.1 and 0.87.0. The legacy peer range still allows 0.80; older child Pi binaries automatically use print mode and record the reason in run details and completion output. Version checks read metadata from the launched binary on PATH or `PI_SUBAGENT_PI_BINARY`. Unknown versions keep RPC mode with a recorded warning.

## Install

Spider is not yet on npm — no version has been tagged or released (`git tag`
lists none as of this writing). A release pipeline
(`.github/workflows/release.yml` and `.github/workflows/publish.yml`) publishes
`@guru-irl/spider` to the npm registry once a maintainer cuts a tagged release;
see [docs/release-process.md](docs/release-process.md) for that flow. Until the
first release ships, install straight from git — pi clones the repo, runs
`npm install`, and the `prepare` script builds the bundle:

```bash
pi install git:github.com/guru-irl/spider
```

Relaunch pi after installing or updating a directly loaded package. Its bundle
can remain in Node's module cache after `/reload`. The linked shims described
below support in-process bundle reloads. Verify with `/doctor`.

### Check the loaded bundle

Run `/doctor` or `spider control command:"doctor"`. The `bundle` line shows
this session's loaded commit, dirty flag, build time, and package version.
`current` means the bundle at the loaded file's location still has the same
build identity. After an update or rebuild, doctor puts the remedy first:
`RELOAD NEEDED, /reload to load it` only when its loaded URL has the regenerated
shim's `?build=` query. Old shims, direct packages, and fallback loads say
`RESTART NEEDED, restart pi to load it`. In a child, it says the next dispatched
subagent will load the new bundle instead. Outside child mode, without the query,
doctor also hints that a linked checkout needs `npm run link`, then a one-time pi restart. This is
informational and does not fail the health check. An unreadable file or missing
marker is reported without claiming it is current.

Updating the file does not update code already loaded in a running session.
With a current linked shim, reload when running subagents have finished, or
restart pi. Direct package loads require a restart. Each built bundle contains
a greppable `SPIDER_BUILD_ID=<sha>[-dirty]@<ISO timestamp> v<version>` header.
Every watch rebuild captures a fresh time. Dirty means tracked changes only;
untracked local state does not affect it. Builds without git, or without their
own checkout root, use `unknown` for the commit. Unbundled source development
reports unknown build metadata.

Each `/reload` of a rebuilt bundle keeps the previous module instance in memory
until pi exits. A fixture measurement recorded about **1.5 MiB heap and 3 MiB RSS
per rebuilt reload** for the 0.56 MiB bundle with no embedder loaded, plus anything
an old instance's module-scope caches still hold. The embedder is process-wide
and loaded once on first use. Session switches (`/new`, `/resume`, `/fork`) and
rebuilt reloads reuse the same model, keyed by a versioned global symbol. An
unavailable result (both providers fail) is cached process-wide for **10 minutes**;
the first call after that cooldown retries initialization. Rejected initialization
promises are cleared immediately, so the next call can retry. Each activation
dispatches through its own action closures, using the global registry only for
externally registered actions that it does not own. On `session_shutdown`, spider
releases that activation's action closures and error marks, agents UI target,
organism/routing runtime references and DB handles without clearing another live
activation's host state. Child teardown is unchanged: any session shutdown stops
all registered subagent coordinators in that module, including those used by
other live activations, with their tailers/listeners. Organism shutdown work is
awaited.
This is not cancellation of every in-flight operation: foreground chains and
pending intercom calls are not tied to shutdown, and some action/UI DB handles
lack an explicit close path. The shared model is intentionally retained until
process exit; Fastembed has no public model disposer. Finish running work before reloading; restart pi after many rebuilt reloads or when
complete process-level cleanup is needed.

Pin a ref if you want a fixed version, and update by re-installing at a new one
(substitute a real release tag for `<tag>` once one exists — none does yet; the
current unreleased version is `0.1.0`):

```bash
pi install git:github.com/guru-irl/spider@<tag>
pi update            # updates installed packages
pi list              # shows what is installed
pi remove git:github.com/guru-irl/spider
```

`npm install` also runs `scripts/postinstall.mjs`, which loads `better-sqlite3`,
opens a `vec0` table through `sqlite-vec`, and bootstraps the global registry
database. It prints diagnostics to stderr and never blocks the install. If a
native module fails, run `npm rebuild better-sqlite3` in the package directory.

## Develop against a working tree

For hacking on spider itself, clone it and link a shim into pi's global
auto-discovery directory (`~/.pi/agent/extensions/`), which pi loads without a
project-trust prompt:

```bash
git clone https://github.com/guru-irl/spider.git
cd spider
npm install       # prepare builds dist/ automatically
npm run link      # stable shim  -> ~/.pi/agent/extensions/spider.ts
# or
npm run dev:link  # hot-reload shim -> spider-dev.ts, alongside `npm run dev`
```

Pick one; the two scripts remove each other to avoid a double load.

- `npm run link` writes the stable shim pointing at this repo's built
  `dist/extension.js`. Remove it with `npm run unlink`.
- `npm run dev:link` writes the dev shim for `npm run dev` (vite watch).
  Remove it with `npm run dev:unlink`.

Both shims use Node's native import in the main context via `runInThisContext` with
`USE_MAIN_CONTEXT_DEFAULT_LOADER`, bypassing jiti's dynamic-import rewrite.
The URL cache key uses the bundle's mtime and size: `/reload` loads a changed
bundle after its build finishes, but an unchanged file reuses its module.
This Node API is experimental; the shim suppresses only its specific loader
ExperimentalWarning during synchronous compilation and native-import calls.
If the VM loader constant is unavailable, compilation throws, or native import
fails with an allowlisted loader/resolution error code, the shim falls back to
plain `import(bundle)`; rebuilt bundles then require a pi restart, not `/reload`.
Errors without an allowlisted loader code are rethrown without retry.
The code allowlist does not identify the load phase: the bundle must link
natively, with no top-level await of optional modules. Keep its top level free
of resource initialization; `npm run build` verifies a native import without
activating the extension. If fallback also fails, the visible message names
both failures and an `AggregateError` retains both original errors. A plain
dynamic import, even with a query string, does not reliably reload through pi's
jiti loader.
Regenerate older shims by running the link command again, then restart pi once. Do not load the package directly alongside a shim.

The fixture probes `node scripts/probe-reload.mjs` and
`node scripts/probe-build-watch.mjs` exercise pi's real loaders and
two Vite watch builds. They use only scratch bundles and a fixture agent
directory under `.spider/scratch/build-id/`, never the real pi extension directory.
Both probes also run in the test suite. The reload probe covers both the SDK
entry's `alias` configuration and `dist/bundle/index.js`'s CLI configuration
(`virtualModules`, `tryNative:false`), using the same worktree-local pi package.

The stable shim points at a **fixed path**, so if you move the clone, re-run
`npm run link`. A source-linked checkout updates by pulling and rebuilding in
that directory — `pi update` manages installed packages, not a linked working
tree.

### Contributor notes

The process-wide embedder slot also retains the adapter object from whichever
bundle initialized it first. A rebuilt reload does not replace that adapter, so
changes to `packages/memory/src/embeddings/embedder.ts` need a pi restart to take
effect once the model is loaded, even with `dev:link`. Bump the versioned global
symbol key when changing the adapter or slot contract incompatibly. A key bump
can retain both models until process exit; restart pi for complete cleanup.

## Quickstart

Actions on the `spider` tool:

```
spider search   query:"where is the retry backoff set"   # FTS + vector search
spider exec      language:shell code:"git log --oneline -20"  # sandboxed; only printed output enters context
spider index     path:"docs/"                             # index files for later search
spider remember  content:"prefer tabs" category:"preference" justification:"A standing preference, useful to future agents in any repo; global scope applies." scope:"global"
spider run       agent:"reviewer" task:"review the diff on the auth module"  # background subagent
spider kill      id:"a1b2c3"                              # kill a subagent (id, prefix, name, or "all")
spider todo      op:"add" text:"wire up the migration"    # durable per-session todo
spider control   command:"doctor"                         # health check
```

Slash commands (thin front for the same actions):

```
/todos      live todo overlay          /search    unified search
/agents     live subagent overlay      /memory    recall memory
/doctor     health check               /insights  learning insights
/stats      usage stats                /learn     distill skills from sessions
/bind       bind session to worktree   /exec-enforce  toggle bash enforcement
```

Todo ops: `add`, `list`, `toggle`, `remove`, `clear`, `sessions`, `view`.
Use `remove id:<seq>` for obsolete items. `clear` removes only done items and
reports removed and kept-open counts; `force:true` removes all items in the
current session. `clear` rejects session selectors. `toggle` and `remove`
accept a session id, unique prefix, or unique name via `session` within this
project DB, defaulting to the current session. They reject `session:"all"`,
unresolved or ambiguous selectors, and missing or unknown ids with an error.

## Config layers

Config precedence is built-in defaults, then global config, then worktree-local
config. Use `scope:"global"` with `control config` `op:"set"` or `op:"unset"`
to edit `~/.pi/agent/spider/config.json` (or the config under `SPIDER_GLOBAL_ROOT`).
Omit scope or use `scope:"repo"` to edit the current worktree's `.spider/config.json`.
Here `repo` selects the local config, not the shared repository database.
Other config write scopes, including `worktree` and `project`, are rejected.

```
spider control command:"config" op:"set" key:"memory.reviewer.model" value:"provider/model" scope:"global"
spider control command:"config" op:"unset" key:"memory.reviewer.model" scope:"repo"
spider control command:"config" op:"get" key:"memory.reviewer.model"
```

Write results report `scope` (`global` or `local`), the destination `file`, and
`shadowedBy:"local"` when a global edit is overridden by a local key. A keyed
`get` reports the effective `value` and its `source` (`default`, `global`, or
`local`). If neither a built-in default nor a layer supplies the key, `value` is
undefined and `source` is `unset`. An unkeyed `get` reports `config` and `sources`.
For `models.defaults`, provenance is a per-role source map, matching `control models`.

Unset normally removes the key from the chosen layer, allowing lower layers to
supply the value. Only `memory.snapshotCharCap` accepts `"unlimited"`: if a
global cap exists, unset writes that sentinel in the chosen layer so the cap
does not reappear. Setting this key to `"unlimited"` or an empty string uses the
same scoped unset path. Other numeric keys and model ids never receive that
sentinel. `exec.enforce` remains protected from both model-facing set and unset.

## Subagents and killing them

`spider run` dispatches subagents in the background (single, chain, parallel,
and pipeline modes) and reports back via a `spider.subagent_done` message.
Run records and child events stay in the dispatching session's worktree database
(or its `/bind` target), which is also the database read by `/agents`. A `cwd`
on `run` changes the child's working directory and supplies that target's model
defaults, but does not move run records. Child scratch files and transcripts
stay in the target project's `.spider/scratch`. Other actions with an explicit
`cwd`, such as `todo`, continue to use that directory's project database.

`spider kill` stops them. It accepts a run id, an id prefix, a run name, or
`"all"`. Kill signals the whole **process group**, so a subagent's own children
die with it rather than being reparented and left running. A killed run is
recorded as `cancelled`, and both `cancel()` and `finish()` refuse to overwrite
that status — so a child that dies mid-write cannot rewrite its own death as
`done`.

Use `/agents` or `alt+shift+up` to select a run from the footer. With `ui.footer=false`, both notify without opening a selector; changes to this setting take effect in the next session. Press `Enter` on a run to open its detail view, then
`k` twice to kill it (the second press within a few seconds confirms).

`control models set <role> <model>` writes a global role default to the spider global `config.json` (`~/.pi/agent/spider/config.json` unless `SPIDER_GLOBAL_ROOT` is set). The current worktree's `.spider/config.json` can override each role independently. Resolution is explicit model, local role override, global role default, then parent model, including pipeline stages. A global set reports the worktree-local value and file if that role is shadowed. `control models clear <role>` removes only that role's local override in the current worktree; it does not change the global value or other local roles.

Children default to `pi --mode rpc`. The dispatching session owns their pipes
and sends exactly one task prompt. Set `subagents.childMode` to `"print"` using
`spider control command:config op:set` to retain legacy `--mode json -p` for
new launches. Runs retain their launch mode; changing the setting does not
upgrade existing children.

Exiting or reloading any session tears down all subagents registered in that
module, not just that activation's children. RPC children receive
`clear_queue`, then `abort`, then stdin EOF; process-group `SIGTERM` and
`SIGKILL` remain the fallback after a short grace period. Runs orphaned by a hard kill (where the host died without
running shutdown) are reaped at the next `session_start` — but only after
checking that the pid's current start time matches the recorded spawn identity
(legacy rows without a start time use the old command check), so pid reuse
cannot make the reaper signal an unrelated process, and only when the owning
host is actually dead, so one session never kills another's agents.

## Background learning

The organism runs only in parent sessions. With `PI_SUBAGENT_CHILD=1`, the
host does not register its compaction or shutdown hooks, and manual organism
actions refuse with `organism is disabled in subagent sessions`. Children can
use `skill list`, `view`, and `add` directly against the repo DB, without an
organism worker or model. `skill distill`, `approve`, and `reject`, plus
`control skill curate` (including consolidation) and `control insights`, refuse.

Background learning and skill consolidation default to
`github-copilot/gpt-6-luna` with `low` thinking, never the session model.
Explicit `auxiliary.background_review.model` and `.provider` settings override
the default. A provider-only override selects `<provider>/gpt-6-luna`. A bare
model id must match exactly one available catalog entry, under the configured
provider if supplied; it never borrows the session provider. An unavailable
model produces a recorded drain error without falling back to another model.

## Escalation and messaging

Subagents escalate to their parent by emitting a structured marker
(`ESCALATION[blocked|question|warning]: ...`). The parent surfaces it as a
themed card **while the run is still going**, not at the end — so a blocked
child is visible immediately.

`spider message` to a running RPC run in its dispatching session sends a `steer`
over the owned pipe. A successful response means the child accepted the message
for delivery at the next turn boundary, after its current tool calls. Acceptance
has no delivery deadline and does not prove model consumption. If a run ends
without delivery, a later `steer_delivery` run event records the cause; acceptance
is not retracted.
Completed, queued, paused and print-mode runs refuse steering.

If an installed, enabled pi-intercom package is available at launch, RPC children
load it and appear as named live peers (`<run name>-<short run id>`). Another
session can message a run by ID through its persisted intercom target. Without
that capability, steering must come from the dispatching session. The child
still cannot call spider `run`, `message` or `kill`, or the outbound `intercom`
and `contact_supervisor` tools. Optional intercom resolution failure does not
prevent the child from running; dispatch details report steering unavailable.

Peer-session messages are stored durably before attempting broker delivery.
Broker acceptance does not prove recipient acknowledgement or model consumption.
An unconfirmed message remains queued and is retried when its target session
starts. This deferred-delivery policy is for peer sessions, not one-shot run
names: an undelivered run steer is an error, not a queued success. Background
children are independent of later parent-turn Escape. Shutdown still cancels
all session-owned children and reports the cause without starting a model turn,
including on reload. A kill from this session reports through its tool result,
not an extra completion notification unless an accepted steer was not delivered.
A cancelled pipeline ends.
Owned handles remain killable even if spawn start-time capture failed; only
pid-only kill and reaper paths require the identity check.
Dialogs requested by child extensions are cancelled with a run-event
warning. RPC and print children use Pi's same non-interactive project-trust
policy; RPC does not grant additional project trust.

## Databases: three tiers

Spider stores state in three SQLite databases, chosen by what the data outlives:

| Tier | Location | Holds |
| --- | --- | --- |
| global | `~/.pi/agent/spider/spider.db` | project registry, session bindings, message queue, insights, model stats |
| repo | `<git-common-dir>/spider/repo.db` | `memory`, skills, curator state — shared by every worktree of one repo |
| worktree | `<worktree-root>/.spider/project.db` | sessions, runs, todos, content, events — private to one worktree |

This split is what makes worktrees behave. A project is keyed by its **worktree
root**, not by the git common directory, so two worktrees of the same repo get
two separate databases instead of overwriting each other's path. Memory written
in one worktree is visible from its siblings; sessions and runs are not.

Which scope to use, when writing memory:

> *"Is this true in every repo?"* → **global**. Otherwise → **repo**.
> Worktree memory was removed; use repo for repository-specific facts.

Every `spider remember` call needs a nonblank `justification`: why the fact
will stay true and useful after this task, how other agents can use it, and why
its scope is correct. The foreground reviewer checks durability first, then
active entries in both scopes for overlap and replacements. It may store as
requested (`new`), return an existing UUID (`already_present`), archive older
entries (`supersedes`), move the write to the correct scope (`wrong_scope`), or
leave task-only information in the conversation (`not_durable`). The result
states the verdict and reason. A reviewer error, unavailable model, timeout,
abort, or disabled reviewer never loses the write: it stores as requested and
states `review skipped: <reason>`. Configure `memory.reviewer.enabled` (default
`true`), `memory.reviewer.model` (default `github-copilot/gpt-6-luna`),
`memory.reviewer.thinking` (default `medium`) and `memory.reviewer.timeoutMs`
(default `45000`, integer from `1000` to `120000`) with `spider control config set`.

Skill proposals from the learner and `spider skill op=add` share deterministic
validation: a lowercase hyphenated name (up to 64 characters), matching YAML
frontmatter with exactly `name` and `description`, a trigger-only description
starting with `Use when` (up to 500 characters), frontmatter up to 1024 characters,
nonempty instructions, and the strict memory threat scan. Learner and curator
origin validation allows 500 instruction words and 8000 UTF-8 bytes. Agent
`op=add`, including `/learn` and distill output, allows 1500 instruction words
and 16 KB (16384 bytes); the reviewer judges concision. Deterministic failures
reject without a model call, even with review disabled. The curator only
archives existing skills; it does not stage candidates.

The reviewer loads the complete bundled `writing-skills` rubric at runtime.
It judges durability, candidate-text quality and existing coverage. Staging is
not deployment, so pressure-test evidence and the deployment checklist are not
required. The catalog has at most 150 entries, prioritizing bundled, active,
pi-loaded, then most recently updated staged skills. Descriptions are truncated
to 300 characters. The total learner system prompt is capped at 180000 UTF-8
bytes, including rubric, catalog and active memory. Unavailable or oversized
skill guidance is omitted without disabling memory learning.

Learner candidates pass deterministic checks and `organism.maxSkillProposals`
(default `1`, a nonnegative integer) before entering the durable repo review
queue. Drains report `skillsQueued`, not reviewed stages. A live top-level
session reviews queued candidates asynchronously at session start and after a
before-compact drain. No queue review starts during shutdown or in children.
A repo DB lease serializes reviews across handles and processes. Only `new`
stages and stores the review reason. `duplicate`, `not_durable` and `low_quality`
are removed with recent verdicts visible in doctor. Errors, timeout, abort and
invalid replies remain queued with attempts and last_error; after three attempts
they are dropped with a recorded reason. Doctor shows the queue length.

Agent `op=add` waits for inline review, including in children, without creating
a learner or organism runtime. It returns verdict/reason plus an existing name
or failed rules when applicable. Review failures stage as requested with
`review skipped: <reason>`. Staging never activates a skill. Child distill,
approve and reject remain unavailable.

Configure `skills.reviewer.enabled` (default `true`), `skills.reviewer.model`
(default `github-copilot/gpt-6-luna`), `skills.reviewer.thinking` (default `xhigh`)
and `skills.reviewer.timeoutMs` (default `180000`, integer from `1000` to `600000`).
Both thinking settings accept `minimal`, `low`, `medium`, `high` or `xhigh`,
independently of the learner/session model. Disabling the skill reviewer omits
the learner skill section and leaves its queued reviews pending; agent adds
still validate and stage as review-skipped. The learner defaults to no skill,
proposes new techniques only and cannot patch existing skills.

Both reviewers persist parse and transport failures in
`.spider/logs/reviewer-errors.jsonl`: redacted error text and at most 2 KiB of
raw reply. At 1 MiB the log rotates to one previous file. Logs stay local and
raw replies never enter model-visible tool output. The v12 migration adds a
review reason and durable queue/results/lease tables; v11 skills remain readable.
Memory review permits information-preserving condensation through `supersedes`.
For user preferences and standing instructions, only pure condensation that
drops no information is allowed without a newer user statement. Corrections
still require a newer statement from the user.

A session normally resolves its project from the working directory. `/bind`
pins a session to a specific worktree when that is wrong (for example, a session
started outside any repo). Binding **promotes, never switches**: it only applies
automatically where there is no git context to contradict it.

Upgrading from a pre-tiering install:

```bash
spider control migrate            # dry run: reports what would move, changes nothing
spider control migrate --apply    # moves it, after backing up to ~/.pi/agent/spider/backups/
```

Rows that collide across worktrees (the same skill name, say) are reported as
`ambiguous` and **left in place** rather than dropped.

## Sandboxed execution

`spider exec` is the shell. The `bash` tool is mechanically blocked by a hook,
not merely discouraged by wording, so the agent cannot fall back to it. Only
what the command prints enters the context window, which is the point: a
thousand-line build log costs you the twenty lines you chose to echo.

The enforcement is user-controlled. The model cannot disable it — the
`exec.enforce` key is rejected through the model-facing config action, and the
block message deliberately does not mention how to turn it off. You can toggle
it:

```
/exec-enforce off
/exec-enforce on
```

This stops reflexive fallback to `bash`; it is not a security boundary against
a determined model, which can still run a shell through `spider exec` itself.

## Package map

Ten packages sit in dependency order, leaves first. Each imports only from
packages below it.

| Package | Role | README |
| --- | --- | --- |
| `@spider/db-core` | Opens and migrates the three database tiers, defines the schema, resolves a project, runs the `run_events` bus | [packages/db-core/README.md](packages/db-core/README.md) |
| `@spider/models` | Model catalog, tiers, selection, and one-shot completion | [packages/models/README.md](packages/models/README.md) |
| `@spider/ui` | Pure themed renderers and TUI components; no database, no pi API | [packages/ui/README.md](packages/ui/README.md) |
| `@spider/memory` | Structured memory: staging, approval, active snapshot, embeddings | [packages/memory/README.md](packages/memory/README.md) |
| `@spider/todo` | Durable per-project and per-session todos, FTS sync, `/todos` surface | [packages/todo/README.md](packages/todo/README.md) |
| `@spider/context` | Unified search, sandboxed exec, content store, fetch, session import | [packages/context/README.md](packages/context/README.md) |
| `@spider/subagents` | Subagent dispatch (single, chain, parallel, pipeline) and intercom | [packages/subagents/README.md](packages/subagents/README.md) |
| `@spider/organism` | Drain, passes, curator, learning graph, and insights | [packages/organism/README.md](packages/organism/README.md) |
| `@spider/superpowers` | Vendored skills library, managed `AGENTS.md` block, upstream-watch | [packages/superpowers/README.md](packages/superpowers/README.md) |
| `@spider/host` | The pi extension entry point: the `spider` tool, dispatch, rendering, slash commands, hooks | [packages/host/README.md](packages/host/README.md) |

## Documentation

- [docs/architecture/README.md](docs/architecture/README.md): the one-tool
  model, the layered packages, the shared database, and how one call flows.
- [docs/architecture/data-model.md](docs/architecture/data-model.md): the three
  database tiers, the tables, migrations, and the `run_events` bus.
- [docs/architecture/feedback-and-learning-loops.md](docs/architecture/feedback-and-learning-loops.md):
  the routing, memory, organism, and subagent loops.
- [docs/guide/using-spider.md](docs/guide/using-spider.md): how to use spider
  day to day.
- [docs/release-process.md](docs/release-process.md): how a tagged commit
  becomes a GitHub Release and an npm publish, and the manual repo setup that
  gates it.
