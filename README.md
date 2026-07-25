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
  ABI and must match the Node that pi runs. Spider pins Node 26.4.0 (the `volta`
  field in `package.json`); `engines` allows >= 22.19.0, but the checked-in
  native builds match the pinned version. On a different major version the
  native modules fail to load and vector search degrades to full-text search
  only.
- pi coding-agent 0.80 or later (peer dependency).

## Install

Spider is not published to npm. Install it straight from git — pi clones the
repo, runs `npm install`, and the `prepare` script builds the bundle:

```bash
pi install git:github.com/guru-irl/spider
```

Then run `/reload` in an interactive pi, or relaunch it. Verify with `/doctor`.

Pin a ref if you want a fixed version, and update by re-installing at a new one:

```bash
pi install git:github.com/guru-irl/spider@v1.0.0
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

- `npm run link` writes a cached-import shim pointing at this repo's built
  `dist/extension.js`. Remove it with `npm run unlink`.
- `npm run dev:link` writes a cache-busting shim so `/reload` always runs the
  latest `npm run dev` (vite watch) output. Remove it with `npm run dev:unlink`.

After linking, run `/reload` in an interactive pi or relaunch.

The stable shim points at a **fixed path**, so if you move the clone, re-run
`npm run link`. A source-linked checkout updates by pulling and rebuilding in
that directory — `pi update` manages installed packages, not a linked working
tree.

## Quickstart

Actions on the `spider` tool:

```
spider search   query:"where is the retry backoff set"   # FTS + vector search
spider exec      language:shell code:"git log --oneline -20"  # sandboxed; only printed output enters context
spider index     path:"docs/"                             # index files for later search
spider remember  content:"prefer tabs" category:"preference"  # structured memory linked to a file/skill
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

## Subagents and killing them

`spider run` dispatches subagents in the background (single, chain, parallel,
and pipeline modes) and reports back via a `spider.subagent_done` message.

`spider kill` stops them. It accepts a run id, an id prefix, a run name, or
`"all"`. Kill signals the whole **process group**, so a subagent's own children
die with it rather than being reparented and left running. A killed run is
recorded as `cancelled`, and both `cancel()` and `finish()` refuse to overwrite
that status — so a child that dies mid-write cannot rewrite its own death as
`done`.

In the `/agents` overlay, press `Enter` on a run to open its detail view, then
`k` twice to kill it (the second press within a few seconds confirms).

Exiting a session tears down its subagents: `SIGTERM`, then `SIGKILL` after a
short grace period. Runs orphaned by a hard kill (where the host died without
running shutdown) are reaped at the next `session_start` — but only after
checking that the recorded pid still looks like a pi subagent, so pid reuse
cannot make the reaper signal an unrelated process, and only when the owning
host is actually dead, so one session never kills another's agents.

## Escalation and messaging

Subagents escalate to their parent by emitting a structured marker
(`ESCALATION[blocked|question|warning]: ...`). The parent surfaces it as a
themed card **while the run is still going**, not at the end — so a blocked
child is visible immediately.

Session-to-session messages (`spider message`) go through a durable queue rather
than a live broker. A message to a session that is not currently listening is
**queued, not lost**, and delivered when that session next starts. A queued
message reports as queued rather than as an error. Delivery is only marked once
it has actually succeeded, so a failed send stays pending and is retried.

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

> *"Is this still true after I delete this worktree?"* → **repo**.
> *"Is it true in every repo?"* → **global**. Otherwise → **worktree**.

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
- [docs/architecture/data-model.md](docs/architecture/data-model.md): the two
  databases, the tables, migrations, and the `run_events` bus.
- [docs/architecture/feedback-and-learning-loops.md](docs/architecture/feedback-and-learning-loops.md):
  the routing, memory, organism, and subagent loops.
- [docs/guide/using-spider.md](docs/guide/using-spider.md): how to use spider
  day to day.
