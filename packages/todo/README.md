# @spider/todo

Durable todo storage for spider. It owns the `todo` action (list, add, toggle,
clear, sessions, view) and the `/todos` slash command, both scoped to a
session inside a project's SQLite database.

## Responsibility

This package owns:

- The `todos` table and its `todos_fts` full-text shadow table in the
  per-project database (the table definitions live in `@spider/db-core`; this
  package is the only code that writes to them in normal operation).
- The `todo` action handler and its six operations.
- The `/todos` slash command, including its interactive overlay and a
  non-interactive fallback.
- Plain renderers that turn todo state into themed `Component`s for both
  surfaces.

This package deliberately does not own:

- Session identity or lifecycle. Session ids and names come from the
  `sessions` table and from `ctx.sessionId` / `deps.getSessionId()`; this
  package only reads them.
- The SQLite schema and migrations, which live in `@spider/db-core`.
- Search across todos and other content. `@spider/context` queries `todos`
  and `todos_fts` directly as part of unified search; this package has no
  search or ranking logic of its own.
- Terminal rendering primitives. The interactive overlay in `command.ts`
  calls `@earendil-works/pi-tui` helpers (`truncateToWidth`, `visibleWidth`,
  `Key`, `matchesKey`); it does not implement them.

## Key modules

| File | What it does |
| --- | --- |
| `index.ts` | Barrel export for the package. Also defines `TodoPiApi` and `registerTodo()`, a structural wiring helper. |
| `types.ts` | Shared value types: `Todo`, `SessionSummary`, `SessionGroup`. |
| `store.ts` | All SQL for the package: reads and writes `todos`, keeps `todos_fts` in sync, resolves session selectors. |
| `actions.ts` | Builds the `todo` action handler (`makeTodo`), dispatching on `args.op`. |
| `command.ts` | Builds the `/todos` command (`makeTodosCommand`): an interactive overlay when the host UI supports it, a one-shot notify otherwise. |
| `renderers.ts` | Turns `Todo` / `SessionSummary` / `SessionGroup` data into `Panel` / `StatusLine` components from `@spider/ui`. |

## Public surface

From `types.ts`:

| Export | Purpose |
| --- | --- |
| `Todo` | One todo: `seq`, `text`, `done`. |
| `SessionSummary` | A session's todo/done counts, its name, and whether it is the current session. |
| `SessionGroup` | A session's `Todo[]` plus name/current flag, used by the `view` op. |

From `store.ts`:

| Export | Purpose |
| --- | --- |
| `listTodos(db, sessionId)` | All todos for one session, ordered by `seq`. |
| `addTodo(db, sessionId, text)` | Inserts a todo at the next `seq` for the session and inserts the matching row into `todos_fts`. |
| `toggleTodo(db, sessionId, seq)` | Flips `done` for the todo at `seq` in that session; returns `null` if not found. |
| `clearTodos(db, sessionId)` | Deletes every todo for a session and removes the matching rows from `todos_fts`. |
| `sessionSummaries(db, currentSessionId)` | One row per session in the project, with total/done counts and a `current` flag. |
| `resolveSession(db, selector)` | Resolves an exact session id, a unique session name, or a unique session id prefix to a session id. |
| `viewSession(db, selector, currentSessionId)` | `SessionGroup[]` for `"all"` sessions or for one resolved session. |

From `actions.ts`:

| Export | Purpose |
| --- | --- |
| `TodoDeps` | `{ projectDb, getSessionId }`, the fallback dependencies for the action handler. |
| `ActionResult` | `{ display?, details }`, the shape every op returns. |
| `makeTodo(deps?)` | Builds the `todo` action handler for ops `list \| add \| toggle \| clear \| sessions \| view`. |

From `command.ts`:

| Export | Purpose |
| --- | --- |
| `TodosCommandDeps` | `{ getDb(ctx), getSessionId(ctx) }`, resolved per invocation. |
| `makeTodosCommand(deps)` | Builds the `/todos` command definition (`description` plus `handler`). |
| `TodosCommand` | The return type of `makeTodosCommand`. |

From `renderers.ts`:

| Export | Purpose |
| --- | --- |
| `renderTodos(todos)` | A `Panel` listing one session's todos. |
| `renderSessions(summaries)` | A `Panel` listing every session with its done/total count. |
| `renderView(groups)` | A `Panel` listing one or more sessions with their todos, for the `view` op. |
| `renderStatus(left, right)` | A `StatusLine` with the two given sides. |

From `index.ts` directly:

| Export | Purpose |
| --- | --- |
| `TodoPiApi` | A structural interface (`registerAction`, optional `registerCommand`, optional `on`) that lets `registerTodo` run against a fake or a real pi API. |
| `registerTodo(pi, deps)` | Registers the `todo` action and the `/todos` command against a `TodoPiApi`. Used by this package's own tests; the real host wires `makeTodo()` and `makeTodosCommand()` directly instead of calling this. |
| `Db` | Re-exported from `@spider/db-core` for consumers that only need the type. |

## How it fits

- Depends on `@spider/db-core` for the `Db` type and the underlying
  `todos` / `todos_fts` / `sessions` tables, and on `@spider/ui` for `Panel`,
  `StatusLine`, and the `Component` type used by the renderers. The
  interactive overlay in `command.ts` also calls `@earendil-works/pi-tui` for
  width-aware truncation and key matching.
- Depended on by `@spider/host`, which registers the `todo` action
  (`makeTodo()`) and the `/todos` command (`makeTodosCommand()`) in its
  extension entry point, and by `@spider/organism`, which imports `addTodo`
  and the `Todo` type to write reconciled todos during its passes.
- `@spider/context` does not import this package, but its unified search
  reads the `todos` and `todos_fts` tables directly over the shared
  per-project `Db`, since search, memory, and todos all live in one SQLite
  file.
- In a request: a `spider` tool call with `action: "todo"` reaches host
  dispatch, which already has `ctx.db` (the project database) and
  `ctx.sessionId` resolved for every action. It calls the handler returned by
  `makeTodo()`, which runs one `store.ts` function and returns a renderer
  `Component` plus raw `details`. The `/todos` command is a separate path:
  pi calls the handler from `makeTodosCommand()` directly, which resolves
  its own db and session per invocation and opens the overlay.

## Notes

- **Per-session scope.** Every todo belongs to one `session_id`. `seq`
  numbers restart at 1 for each session (`COALESCE(MAX(seq), 0) + 1`, scoped
  by `session_id`), not project-wide. The `toggle` op's `id` argument is
  matched against `seq`, not the underlying database row id; this only
  matters if the action is called directly with a raw id instead of the
  `#seq` value shown by the renderers.
- **Per-project scope.** All sessions in a project share one `todos` table
  in that project's database. `sessionSummaries` and
  `viewSession("all", ...)` return every session's todos in the current
  project. There is no view across projects, since each project has its own
  database file. `resolveSession` accepts an exact session id, a session
  name (only if it identifies exactly one session), or a session id prefix
  (only if it matches exactly one session); anything ambiguous or unmatched
  returns `null`.
- **FTS sync is manual.** `todos_fts` is declared as an external-content
  FTS5 table (`content=todos, content_rowid=id`), and there are no triggers
  on `todos`. `addTodo` inserts the new row into `todos_fts` inside the same
  transaction as the `todos` insert. `clearTodos` issues the FTS5 special
  command (`INSERT INTO todos_fts(todos_fts, rowid, text) VALUES ('delete',
  ?, ?)`) for every row before deleting them from `todos`. `toggleTodo` only
  changes the `done` column and never touches `text`, so it does not touch
  `todos_fts`. There is currently no operation that edits or deletes a
  single todo's text; adding one would also need to update `todos_fts`, or
  `@spider/context` search would return stale or missing text for that row.
- **Interactive vs. non-interactive.** `makeTodosCommand`'s handler opens
  the interactive overlay only when `ctx.ui.custom` is a function.
  Otherwise it falls back to one `ctx.ui.notify` call with the current
  session's todos as plain text. The "all sessions" toggle (`a`) and live
  re-render on keypress exist only in the interactive path.

## See also

- [`@spider/db-core`](../db-core/README.md): schema, migrations, and the
  `Db` connection this package writes through.
- [`@spider/ui`](../ui/README.md): `Panel`, `StatusLine`, and the themed
  component model used by the renderers.
- [`@spider/host`](../host/README.md): wires the `todo` action and `/todos`
  command into the running extension.
- [`@spider/organism`](../organism/README.md): writes reconciled todos back
  through `addTodo` during its passes.
- [`@spider/context`](../context/README.md): reads `todos` / `todos_fts`
  directly as part of unified search.
