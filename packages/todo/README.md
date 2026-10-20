# @spider/todo

This package stores spider's durable todos. It owns the `todo` action (list, add, toggle, remove, clear, sessions, view) and the `/todos` slash command. Both work on one session inside a project's SQLite database.

## Responsibility

This package owns:

- The `todos` table and its `todos_fts` full-text shadow table in the per-project database. The table definitions live in `@spider/db-core`, but in normal operation this package is the only code that writes to them.
- The `todo` action handler and its seven operations.
- The `/todos` slash command, including its interactive overlay and a non-interactive fallback.
- Plain renderers that turn todo state into themed `Component`s for both the action and the command.

This package does not own:

- Session identity or lifecycle. Session ids and names come from the `sessions` table and from `ctx.sessionId` or `deps.getSessionId()`. This package only reads them.
- The SQLite schema and migrations, which live in `@spider/db-core`.
- Search across todos and other content. `@spider/context` queries `todos` and `todos_fts` directly as part of unified search. This package has no search or ranking logic of its own.
- Terminal rendering primitives. The interactive overlay in `command.ts` calls `@earendil-works/pi-tui` helpers (`truncateToWidth`, `visibleWidth`, `Key`, `matchesKey`). It does not implement them.

## Key modules

| File | What it does |
| --- | --- |
| `index.ts` | Barrel export for the package. Also defines `TodoPiApi` and `registerTodo()`, a structural helper that registers the action and command. |
| `types.ts` | Shared value types: `Todo`, `SessionSummary`, `SessionGroup`. |
| `store.ts` | All SQL for the package. It reads and writes `todos`, keeps `todos_fts` in sync, and resolves session selectors. |
| `actions.ts` | Builds the `todo` action handler (`makeTodo`), which branches on `args.op`. |
| `command.ts` | Builds the `/todos` command (`makeTodosCommand`). It opens an interactive overlay when the host UI supports one, and sends a one-shot notification otherwise. |
| `renderers.ts` | Turns `Todo`, `SessionSummary` and `SessionGroup` data into `Panel` and `StatusLine` components from `@spider/ui`. |

## Public surface

From `types.ts`:

| Export | Purpose |
| --- | --- |
| `Todo` | One todo: `seq`, `text`, `done`. |
| `SessionSummary` | A session's todo and done counts, its name, and whether it is the current session. |
| `SessionGroup` | A session's `Todo[]` plus its name and current-session flag. The `view` op uses it. |

From `store.ts`:

| Export | Purpose |
| --- | --- |
| `listTodos(db, sessionId)` | All todos for one session, ordered by `seq`. |
| `addTodo(db, sessionId, text)` | Inserts a todo at the next `seq` for the session and inserts the matching row into `todos_fts`. |
| `toggleTodo(db, sessionId, seq)` | Flips `done` for the todo at `seq` in that session. Returns `null` if there is no such todo. |
| `removeTodo(db, sessionId, seq)` | Deletes one todo and its FTS posting in one transaction. Returns the removed item or `null`. |
| `clearTodos(db, sessionId, force = false)` | Deletes done todos by default, or all todos with `force: true`. Returns `{ removed, kept }` counts and keeps FTS consistent. |
| `sessionSummaries(db, currentSessionId)` | One row per session in the project, with total and done counts and a `current` flag. |
| `resolveSession(db, selector)` | Resolves an exact session id, a unique session name, or a unique session id prefix to a session id. |
| `viewSession(db, selector, currentSessionId)` | `SessionGroup[]` for `"all"` sessions or for one resolved session. |

From `actions.ts`:

| Export | Purpose |
| --- | --- |
| `TodoDeps` | `{ projectDb, getSessionId }`, the fallback dependencies for the action handler. |
| `ActionResult` | `{ display?, details, isError? }`, the shape every op returns. |
| `makeTodo(deps?)` | Builds the `todo` action handler for the ops `list \| add \| toggle \| remove \| clear \| sessions \| view`. |

From `command.ts`:

| Export | Purpose |
| --- | --- |
| `TodosCommandDeps` | `{ getDb(ctx), getSessionId(ctx) }`, resolved on each call. |
| `makeTodosCommand(deps)` | Builds the `/todos` command definition (`description` plus `handler`). |
| `TodosCommand` | The return type of `makeTodosCommand`. |

From `renderers.ts`:

| Export | Purpose |
| --- | --- |
| `renderTodos(todos)` | A `Panel` that lists one session's todos. |
| `renderSessions(summaries)` | A `Panel` that lists every session with its done and total counts. |
| `renderView(groups)` | A `Panel` that lists one or more sessions with their todos, for the `view` op. |
| `renderStatus(left, right)` | A `StatusLine` with the two given sides. |

From `index.ts` directly:

| Export | Purpose |
| --- | --- |
| `TodoPiApi` | A structural interface (`registerAction`, optional `registerCommand`, optional `on`) that lets `registerTodo` run against a fake or a real pi API. |
| `registerTodo(pi, deps)` | Registers the `todo` action and the `/todos` command against a `TodoPiApi`. This package's own tests use it. The real host registers `makeTodo()` and `makeTodosCommand()` directly instead. |
| `Db` | Re-exported from `@spider/db-core` for consumers that only need the type. |

## How it fits

- This package depends on `@spider/db-core` for the `Db` type and the underlying `todos`, `todos_fts` and `sessions` tables. It depends on `@spider/ui` for `Panel`, `StatusLine`, and the `Component` type that the renderers use. The interactive overlay in `command.ts` also calls `@earendil-works/pi-tui` for width-aware truncation and key matching.
- `@spider/host` depends on this package. It registers the `todo` action (`makeTodo()`) and the `/todos` command (`makeTodosCommand()`) in its extension entry point. `@spider/organism` also depends on it, and imports `addTodo` and the `Todo` type to write reconciled todos during its passes.
- `@spider/context` does not import this package. Its unified search reads the `todos` and `todos_fts` tables directly over the shared per-project `Db`, because search, memory, and todos all live in one SQLite file.
- A request runs like this. A `spider` tool call with `action: "todo"` reaches the host's dispatch, which has already resolved `ctx.db` (the project database) and `ctx.sessionId` for every action. The host calls the handler that `makeTodo()` returned. The handler runs one `store.ts` function and returns a renderer `Component` plus the raw `details`. The `/todos` command takes a separate path. Pi calls the handler from `makeTodosCommand()` directly. That handler resolves its own db and session on each call and opens the overlay.

## Notes

To remove an obsolete item, use `op: "remove", id: <seq>`. `clear` only removes done items unless `force: true` is set, and it always works on the current session. It rejects session selectors. Its result reports the removed count and the count of open items it kept.

- **Per-session scope.** Every todo belongs to one `session_id`. `seq` numbers restart at 1 for each session (`COALESCE(MAX(seq), 0) + 1`, scoped by `session_id`). They are not numbered across the project. The `toggle` and `remove` ops match their `id` argument against `seq`, not the underlying database row id. This matters only if someone calls the action directly with a raw row id instead of the `#seq` value the renderers show. The ops accept numeric ids and displayed ids such as `"#2"`, and reject boolean and non-numeric ids. If you remove the highest item, the next add can reuse its seq, so a stale id can refer to a different item. Both ops accept `session` as an exact id, a unique prefix, or a unique name in this project DB. They default to the current session and reject `session: "all"`. A missing or unknown id, or a selector that is unresolved or ambiguous, returns an error instead of silently doing nothing.
- **Per-project scope.** All sessions in a project share one `todos` table in that project's database. `sessionSummaries` and `viewSession("all", ...)` return the todos of every session in the current project. There is no view across projects, because each project has its own database file. `resolveSession` accepts an exact session id, a session name, or a session id prefix. A name or prefix works only if it identifies exactly one session. A blank, ambiguous or unmatched selector returns `null`. A name and an id prefix that match different sessions are ambiguous, and so is a name or prefix that collides with an exact id.
- **FTS sync is manual.** `todos_fts` is declared as an external-content FTS5 table (`content=todos, content_rowid=id`), and `todos` has no triggers. `addTodo` inserts the new row into `todos_fts` in the same transaction as the `todos` insert. Before they delete rows from `todos`, `removeTodo` and `clearTodos` run the FTS5 special
  command (`INSERT INTO todos_fts(todos_fts, rowid, text) VALUES ('delete',
  ?, ?)`) for every row. `toggleTodo` only changes the `done` column and never changes `text`, so it does not touch `todos_fts`. No operation edits the text of a todo.
- **Interactive vs. non-interactive.** The handler from `makeTodosCommand` opens the interactive overlay only when `ctx.ui.custom` is a function. Otherwise it makes one `ctx.ui.notify` call with the current session's todos as plain text. The "all sessions" toggle (`a`) and the live re-render on each keypress exist only in the interactive path.

## See also

- [`@spider/db-core`](../db-core/README.md) covers the schema, the migrations, and the `Db` connection that this package writes through.
- [`@spider/ui`](../ui/README.md) covers `Panel`, `StatusLine`, and the themed component model that the renderers use.
- [`@spider/host`](../host/README.md) registers the `todo` action and the `/todos` command in the running extension.
- [`@spider/organism`](../organism/README.md) writes reconciled todos back through `addTodo` during its passes.
- [`@spider/context`](../context/README.md) reads `todos` and `todos_fts` directly as part of unified search.
