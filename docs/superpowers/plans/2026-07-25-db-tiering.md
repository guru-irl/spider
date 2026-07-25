# Plan 2 — DB tiering, worktree binding, and migration

**Branch:** `feat/subagent-kill`
**Schema:** this plan takes **v6**. Plan 3 (intercom) took v5. Plan 1 took v4. Do not renumber.

---

## Why — the defect, precisely

`packages/db-core/src/registry.ts`:

```ts
export function resolveProject(cwd: string): ProjectInfo {
  const realPath = realpathSync(cwd);
  const gcd = gitCommonDir(cwd);
  const projectKey = gcd ?? realPath;                              // shared by ALL worktrees
  const dbPath = join(paths.projectRoot(realPath), "project.db");  // per-cwd
  registerProject(info);
}
```
and `registerProject` upserts `ON CONFLICT(project_key) DO UPDATE SET db_path = excluded.db_path`.

Three consequences, all observed live:

1. **Worktrees collide.** Every worktree of a repo shares one `project_key` (the git common
   dir), so opening worktree B rewrites the row's `db_path` to B. `openProject(projectKey)`
   then hands *every* worktree whichever DB was touched last. All 18 `webapp` worktrees collapsed
   onto `project_key=/Users/dev/src/webapp/webapp/.git`.
2. **Data lands nowhere useful.** Project-tier `memory` held **0 rows** while `global_memory`
   held 7 — memory was being written to whichever DB won the race, or falling back to global.
3. **Stray DBs.** `paths.projectRoot(cwd) = join(cwd, ".spider")` uses the raw cwd, not the
   worktree root, so running from a subdirectory creates a `.spider` there. Hence the stray
   `~/.spider` and `~/src/.spider`.

Underneath the mechanics is a real modelling question the current schema cannot express:
**some knowledge belongs to the repo, some to the worktree.** A convention learned in a repo is
still true in every worktree of it; a session or a run is not.

## The model — three tiers

| Tier | Location | Tables |
|---|---|---|
| **global** | `~/.pi/agent/spider/spider.db` | `projects`, `global_memory`, `upstream_refs`, `message_mirror`, `insights`, `model_stats`, **`session_bindings`** (new) |
| **repo** | `<git-common-dir>/spider/repo.db` | `memory`, `memory_fts`, `skills`, `curator_state`, plus its own `vector_map` / `embed_queue` |
| **worktree** | `<worktree-root>/.spider/project.db` | `sessions`, `content`, `todos`, `runs`, `run_events`, `events`, plus its own `vector_map` / `embed_queue` |

`insights` stays **global**. `vector_map`/`embed_queue` exist in both repo and worktree tiers —
memory vectors live with memory, content vectors with content.

**The rule that decides the tier** (this goes in the tool schema description, the managed
AGENTS.md block, and the `bind` output — the schema description matters most, because that is
what the model reads at decision time):

> *"Is this still true after I delete this worktree?"* → **repo**
> *"Is this true in every repo?"* → **global**
> otherwise → **worktree**

---

## Test discipline (binding — carried from Plan 1, which shipped 8 defects of one class)

1. **A regression test must never supply the value whose absence is the bug.**
2. **Every test names the specific mutation it would catch**, in a comment.
3. **Any task adding a user-facing surface needs a test entering through the real entry point**
   (`dispatch()`, the hook, the mount seam) — not the unit beneath it.
4. **Verify the mutation actually applied** (`/*MUT*/` marker + `grep -c`) before believing it.
5. **Test doubles adapt to the production contract, never the reverse.**
6. **Guard symmetry:** any new `UPDATE` must be guarded consistently with its siblings. Plan 1's
   C2 was an unguarded `finish()` silently overwriting a guarded `cancel()`.

## Global constraints

- DAG one-way: `host` → `subagents` → `db-core`, `host` → `ui`. `subagents` must NEVER import
  `@spider/host`; `@spider/ui` must NEVER import `@spider/subagents`.
- No deep imports from `@earendil-works/pi-coding-agent`.
- Scratch under `.spider/scratch/` — never `/tmp`.
- Themed cards only, never raw JSON.
- `export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"`. Never `npm install`.

---

## Task 1 — Worktree-root resolution

**Files:** `packages/db-core/src/paths.ts`, `packages/db-core/src/registry.ts`, tests.

`projectRoot(cwd)` must resolve to the **worktree root**, not the raw cwd — otherwise a
subdirectory gets its own stray `.spider`.

- Add `worktreeRoot(cwd): string` — `git rev-parse --show-toplevel`, falling back to the
  realpath'd cwd when not in a repo.
- `projectRoot(cwd)` becomes `join(worktreeRoot(cwd), ".spider")`.

**Tests:** from a subdirectory of a repo, `projectRoot` returns the ROOT's `.spider`, not the
subdir's (*mutation: revert to `join(cwd, ".spider")` → fails*); outside a repo it falls back to
cwd; a bare/no-git directory does not throw.

Build fixtures with real `git init` under `.spider/scratch/` — never `/tmp`.

---

## Task 2 — Tier-aware paths and schema split

**Files:** `packages/db-core/src/paths.ts`, `schema.ts`, `migrate.ts`, tests.

- `Scope` becomes `"global" | "repo" | "worktree"`. **Keep `"project"` accepted as a
  deprecated alias for `"worktree"`** so existing call sites keep compiling; make the alias
  explicit and tested, not incidental.
- Split `PROJECT_SCHEMA` into `REPO_SCHEMA` and `WORKTREE_SCHEMA` per the table above.
- `repoRoot(cwd)` → `join(gitCommonDir(cwd), "spider")`; repo DB at `repo.db`.
- Bump `SCHEMA_VERSION` to **6**; add `REPO_MIGRATIONS` and select the right migration set per
  scope (Plan 3 added `GLOBAL_MIGRATIONS`; follow that pattern exactly).

**Tests:** each tier's fresh DB contains exactly its own tables and none of the others
(*mutation: move a table between schemas → fails*); the `"project"` alias opens a worktree DB;
fresh-vs-migrated parity per tier, comparing ACTUAL column sets from `PRAGMA table_info` rather
than asserting a hardcoded list twice.

---

## Task 3 — `session_bindings` and resolution order

**Files:** `packages/db-core/src/schema.ts` (global), new
`packages/db-core/src/bindings.ts`, `registry.ts`, tests.

New global table `session_bindings(session_id TEXT PRIMARY KEY, worktree_root TEXT NOT NULL,
bound_at INTEGER NOT NULL)`.

Resolution order for the active worktree:
1. explicit `args.cwd`
2. the session's binding
3. the cwd's worktree root

**Auto-bind promotes, never switches.** A binding is created automatically only when resolution
starts from a non-repo container or loose directory; it must NEVER silently move an existing
binding to a different worktree. Detect the container case via the presence of
`git worktree add`-style layout in `registerRouting` — read that code before implementing and
state in your report what you actually keyed on.

**Tests:** explicit cwd wins over a binding; a binding wins over cwd-derived resolution; an
existing binding is NOT overwritten by opening another worktree (*mutation: make auto-bind
unconditional → this must fail*); binding a session that has none creates one.

---

## Task 4 — Fix the registry collision

**Files:** `packages/db-core/src/registry.ts`, tests.

`projects.project_key` must identify a **worktree**, not a repo. Key on the worktree root;
keep the git common dir as a separate `repo_key` column so repo-tier lookups still work.
`registerProject`'s upsert must no longer let one worktree rewrite another's `db_path`.

**Tests:** registering worktree A then worktree B of the same repo yields TWO rows with
DISTINCT `db_path`s, and `openProject` for A still returns A's DB after B is registered
(*mutation: restore `projectKey = gcd ?? realPath` → this must fail*). This test is the whole
point of the plan — write it first.

---

## Task 5 — `spider control migrate`

**Files:** `packages/host/src/control.ts` (or wherever control sub-commands live),
`packages/ui/src/renderers/`, tests.

Hard cutover plus an explicit sweep — **not** silent adopt-on-open.

- `spider control migrate` — **dry-run by default**, listing what would move where.
- `--apply` (or equivalent per the existing control convention) performs it, after backing up
  every touched DB to `~/.pi/agent/spider/backups/<timestamp>/`.
- Merges data from worktrees that previously collapsed onto one `project_key`: repo-tier rows
  (`memory`, `skills`, `curator_state`) merge into the repo DB; worktree-tier rows go to the
  worktree they belong to. Where provenance is ambiguous, keep the row and report it rather
  than dropping it.
- Idempotent: running twice must not duplicate rows.

**Tests:** dry-run mutates NOTHING (*mutation: make dry-run apply → fails*); apply creates a
backup before writing; a second apply is a no-op; ambiguous rows are reported, not silently
dropped. Renderer output is a themed card.

---

## Task 6 — `bind` / `unbind` surfaces

**Files:** `packages/host/src/extension.ts` (control sub-commands + slash command),
`packages/ui/src/renderers/`, tests.

- `spider control bind [path]` / `unbind`, plus a `/bind` slash command.
- `bind` output states the three-tier rule verbatim — it is a teaching surface.
- Add the rule to the `scope` parameter description in the tool schema, and to the managed
  AGENTS.md block (`packages/superpowers/src/agentsmd-content.ts`).

**Boundary requirement (rule 3):** at least one test must drive the real `dispatch()` path for
`control bind`, not the handler directly. `spider kill` shipped unreachable behind 13 green
tests that all called the handler directly.

---

## Verification for the whole plan

- Full suite green; typecheck; `npm run build` with assert-bundle OK.
- **End-to-end proof (required):** create two worktrees of one repo under `.spider/scratch/`,
  write a memory in each, and assert (a) both see the same repo-tier memory, (b) each sees only
  its own sessions/runs, (c) neither DB path was rewritten by opening the other.
- Re-run the live check that motivated this plan: resolve several worktrees of the same repo and
  confirm they no longer collapse onto one `project_key`.
