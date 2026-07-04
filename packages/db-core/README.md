# @spider/db-core

SQLite foundation for the spider monorepo. It opens and migrates the global registry database and the per-project databases, defines their schema, and provides a small event bus and path helpers. Every other spider package that reads or writes data goes through the `Db` handle this package returns.

## Responsibility

This package owns:

- Opening SQLite connections through `better-sqlite3`, in WAL mode, with a busy timeout and a retry helper.
- The two schema definitions (global registry, per-project) as DDL strings, and the migration ladder that brings an existing database up to the current schema version.
- Resolving a project's identity from a working directory and keeping the global `projects` registry table in sync.
- Appending to and reading the `run_events` and `events` tables, plus an in-process pub/sub bus for the same events.
- Path resolution for the global root directory, the per-project `.spider` directory, and their `scratch`/`logs` subdirectories.

This package does not:

- Define what a memory, todo, skill, or run means beyond its table columns. `@spider/memory`, `@spider/todo`, `@spider/organism`, and `@spider/subagents` own that logic.
- Generate embeddings or run vector search queries. It loads the `sqlite-vec` extension and creates the `vectors` virtual table on request; the embedding pipeline lives in `@spider/memory` and `@spider/context`.
- Render output, dispatch actions, or call a model. It has no dependency on any other `@spider/*` package.

## Key modules

| File | What it does |
| --- | --- |
| `db.ts` | Loads `better-sqlite3` and `sqlite-vec` lazily, opens a database file in WAL mode, and returns a `Db` wrapper (`prepare`, `exec`, `transaction`, `pragma`, `loadVec`, `withRetry`, `close`). Implements the busy-retry loop. |
| `schema.ts` | Holds `GLOBAL_SCHEMA` and `PROJECT_SCHEMA`, the DDL strings for the two databases. A comment in the file marks the table and column names as canonical. |
| `migrate.ts` | Applies the full schema to a fresh database (`user_version` 0), or steps an existing one through `PROJECT_MIGRATIONS` up to `SCHEMA_VERSION`, inside one transaction. |
| `registry.ts` | Resolves a project's key and paths from a working directory (using `git rev-parse --git-common-dir` when available), opens and migrates the global and per-project databases, and upserts rows into the `projects` table. |
| `events.ts` | Appends rows to `run_events` and `events`, exposes an in-process `bus` for the same events, and reads them back (`listEvents`, `eventCountsByTool`). |
| `paths.ts` | Computes the global root (`~/.pi/agent/spider`), the per-project root (`<cwd>/.spider`), and their `scratch`/`logs` subdirectories. |
| `index.ts` | Re-exports the public surface listed below. |

## Public surface

All exports come from `src/index.ts`.

| Export | From | Purpose |
| --- | --- | --- |
| `Db` (type) | `db.ts` | The connection interface returned by `openDb`: `prepare`, `exec`, `transaction`, `pragma`, `loadVec`, `withRetry`, `raw`, `close`. |
| `openDb(dbPath)` | `db.ts` | Creates the parent directory if needed, opens the SQLite file, sets WAL mode and pragmas, and returns a `Db`. |
| `withRetry(fn, delays?)` | `db.ts` | Runs `fn`, retrying with backoff (`[100, 500, 2000]` ms by default) when SQLite reports `SQLITE_BUSY` or "database is locked". |
| `paths` | `paths.ts` | Object with `globalRoot`, `models`, `projectRoot(cwd)`, `scratch(scope, cwd?)`, `logs(scope, cwd?)`. |
| `projectRoot(cwd)` | `paths.ts` | Returns `<cwd>/.spider`, the per-project data directory. |
| `Scope` (type) | `paths.ts` | Either `"global"` or `"project"`. |
| `migrate(db, scope)` | `migrate.ts` | Brings a `Db` to `SCHEMA_VERSION`: full schema on a fresh database, incremental steps on an existing one. Updates `user_version`. |
| `SCHEMA_VERSION` | `migrate.ts` | The schema version migrations bring a database to. Currently 3. |
| `GLOBAL_SCHEMA` | `schema.ts` | DDL string for the registry database: `projects`, `global_memory`, `upstream_refs`, `message_mirror`, `insights`, `model_stats`. |
| `PROJECT_SCHEMA` | `schema.ts` | DDL string for a per-project database: `sessions`, `memory`, `content`, `todos`, `runs`, `run_events`, `events`, `vector_map`, `embed_queue`, `skills`, `curator_state`, and their FTS5 virtual tables. |
| `resolveProject(cwd)` | `registry.ts` | Computes a project's key (git common dir if present, else real path) and db path, registers it, and returns a `ProjectInfo`. |
| `registerProject(info)` | `registry.ts` | Inserts or updates a row in the global `projects` table. |
| `openGlobal()` | `registry.ts` | Opens and migrates the global registry database at `~/.pi/agent/spider/spider.db`. |
| `openProject(projectKey)` | `registry.ts` | Looks up a project's db path in the registry, then opens and migrates that database. |
| `openDbAt(absPath, scope?)` | `registry.ts` | Opens and migrates a database at an explicit absolute path. Infers scope from the path if `scope` is not given. |
| `openProjectByPath(realPath)` | `registry.ts` | Opens a project's database directly from its real path, without a registry lookup. |
| `setGlobalDbPathForTests(path)` | `registry.ts` | Test-only override of the global database path. Pass `null` to reset. |
| `ProjectInfo` (type) | `registry.ts` | `{ projectKey, realPath, gitCommonDir?, dbPath, name? }`. |
| `appendRunEvent(db, e)` | `events.ts` | Inserts a row into `run_events` and emits it on `bus`. |
| `bus` | `events.ts` | In-process pub/sub: `on(listener)` subscribes and returns an unsubscribe function, `emit(event)` notifies every listener (one listener's error does not stop the others). |
| `appendEvent(db, e)` | `events.ts` | Inserts a row into the routing/tracking `events` table and emits a `tool_intent`/`tool_result` event on `bus`. |
| `listEvents(db, opts?)` | `events.ts` | Reads rows from `events`, optionally filtered by `tool` and/or `phase`, with an optional `limit`. |
| `eventCountsByTool(db)` | `events.ts` | Returns per-tool row counts from `events`. |
| `RunEvent` (type) | `events.ts` | `{ runId?, sessionId, ts, type, tool?, summary?, payload? }`. |
| `EventRow` (type) | `events.ts` | `{ sessionId, ts, phase, tool, description?, added?, removed?, flagged?, payload? }`. |

## How it fits

`db-core` has no dependency on any other `@spider/*` package. Its only dependencies are `better-sqlite3` and `sqlite-vec`. It sits at the bottom of the dependency graph. Every package that reads or writes storage depends on it directly: `@spider/context`, `@spider/host`, `@spider/memory`, `@spider/models`, `@spider/organism`, `@spider/subagents`, `@spider/superpowers`, and `@spider/todo`. `@spider/ui` does not depend on it; it only renders data handed to it.

In a request, whichever package handles a `spider` action (memory, todo, content search/index, or subagent dispatch) opens or resolves its database with functions from this package (`resolveProject`, `openGlobal`, `openProject`, `openDbAt`) before doing anything else, then reads and writes through the returned `Db`.

## Notes

- **Native module ABI.** `better-sqlite3` and `sqlite-vec` are native addons compiled against a specific Node ABI. They must be built for the same Node version that runs pi. The monorepo pins Node 24 (the root `package.json` `volta` field) for this reason. Running under a different Node major version can fail to load these modules at `require` time.
- `openDb` sets `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`, and a 30 second `busy_timeout`, and passes the same 30 second timeout to the `better-sqlite3` constructor.
- `withRetry` backs off with a synchronous busy-wait loop (`while (Date.now() - start < delay) {}`), not an async sleep. It blocks the calling thread while it waits.
- `Db.loadVec()` is lazy and idempotent per instance. The first call loads the `sqlite-vec` extension and runs `CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING vec0(embedding float[384])`. Later calls on the same `Db` are no-ops.
- The project schema also defines a plain `vector_map` table (a BLOB column holding raw little-endian float32 values, per its comment, for brute-force cosine similarity and re-embedding from source). This is separate from the `vectors` vec0 virtual table that `loadVec()` creates. `db-core` defines both; it does not decide which one a caller uses.
- Migrations only have incremental steps for project-scope databases (`PROJECT_MIGRATIONS`, currently keyed at versions 2 and 3: add a `thinking` column to `runs`, then add `skills` and `curator_state`). An existing global-scope database with `user_version` between 1 and `SCHEMA_VERSION - 1` has its `user_version` pragma advanced without any DDL running, because the per-version step lookup returns an empty list when scope is not `"project"`.
- `close()` tries `wal_checkpoint(TRUNCATE)` before closing the connection and ignores errors from it, since WAL may not be active.
- This package also exports a separate subpath, `@spider/db-core/testutil` (`scratchDbPath`, `cleanupScratch`), for tests. It is not part of `index.ts`. It writes scratch databases under `packages/db-core/.spider/scratch/<pid>/`, one subdirectory per process, never under a system temp directory.

## See also

- [`docs/architecture/data-model.md`](../../docs/architecture/data-model.md), the full entity diagram and table reference.
- [`docs/architecture/README.md`](../../docs/architecture/README.md), the system overview.
- [`../memory/README.md`](../memory/README.md)
- [`../todo/README.md`](../todo/README.md)
- [`../context/README.md`](../context/README.md)
- [`../host/README.md`](../host/README.md)
