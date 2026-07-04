# spider

Spider is one pi coding-agent extension. It puts memory, unified search, todos,
subagents, sandboxed execution, web fetch, and a skills library on a single
shared SQLite database. It replaces three older pi extensions: `pi-subagents`,
`context-mode`, and a standalone todo tool.

## The single-tool model

The agent has one tool, named `spider`. Every operation is an `action` on that
tool (`search`, `remember`, `recall`, `exec`, `exec_file`, `batch`, `index`,
`fetch`, `run`, `todo`, `skill`, `import`, `message`, `control`). Admin surfaces
sit behind `spider control <command>` (doctor, config, memory, stats, models,
insights, migrate, upstream-watch). Slash commands are a thin front for the same
actions and render through the same code path, so a slash result and the
matching tool result look identical.

## Requirements

- Node 24. The extension loads two native modules, `better-sqlite3` (SQL) and
  `sqlite-vec` (vector search). These are compiled against a specific Node ABI
  and must match the Node that pi runs. Spider pins Node 24 (see the `volta`
  field in `package.json`). On another major version the native modules fail to
  load and vector search degrades to full-text search only.
- pi coding-agent 0.80 or later (peer dependency).

## Install and build

```bash
npm install       # installs deps; postinstall self-checks the native modules
npm run build     # vite build, then asserts the bundle
```

`npm install` runs `scripts/postinstall.mjs`, which loads `better-sqlite3`,
opens a `vec0` table through `sqlite-vec`, and bootstraps the global registry
database. The check prints diagnostics to stderr and never blocks the install.
If a native module fails, run `npm rebuild better-sqlite3` and rebuild.

## Register the extension with pi

Both scripts write a small shim into pi's global auto-discovery directory
(`~/.pi/agent/extensions/`), which pi loads without a project-trust prompt. Pick
one; they remove each other to avoid a double load.

```bash
npm run link      # stable install: writes ~/.pi/agent/extensions/spider.ts
npm run dev:link  # development shim: writes spider-dev.ts (hot reload)
```

- `npm run link` writes a cached-import shim pointing at this repo's built
  `dist/extension.js`. Use it for a fixed install. Remove it with
  `npm run unlink`.
- `npm run dev:link` writes a cache-busting shim so `/reload` in pi always runs
  the latest `npm run dev` (vite watch) output. Run `npm run dev` alongside it,
  then `/reload` in an interactive pi. Remove it with `npm run dev:unlink`.

After linking, run `/reload` in an interactive pi or relaunch.

## Quickstart

Actions on the `spider` tool:

```
spider search   query:"where is the retry backoff set"   # FTS + vector search
spider exec      language:shell code:"git log --oneline -20"  # sandboxed; only printed output enters context
spider index     path:"docs/"                             # index files for later search
spider remember  content:"prefer tabs" category:"preference"  # structured memory linked to a file/skill
spider run       agent:"reviewer" task:"review the diff on the auth module"  # background subagent
spider todo      op:"add" text:"wire up the migration"    # durable per-session todo
spider control   command:"doctor"                         # health check
```

Slash commands (thin front for the same actions):

```
/todos      live todo overlay          /search    unified search
/agents     live subagent overlay      /memory    recall memory
/doctor     health check               /insights  learning insights
/stats      usage stats                /learn     distill skills from sessions
```

## Package map

Ten packages sit in dependency order, leaves first. Each imports only from
packages below it.

| Package | Role | README |
| --- | --- | --- |
| `@spider/db-core` | Opens and migrates the two databases, defines the schema, resolves a project, runs the `run_events` bus | [packages/db-core/README.md](packages/db-core/README.md) |
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
