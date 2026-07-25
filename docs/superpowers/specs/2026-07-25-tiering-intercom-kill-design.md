# Design: DB tiering, intercom transport, and subagent kill

Date: 2026-07-25
Status: approved (design), pending implementation plan

Three independent defects, fixed together because they share the `ActionCtx` /
`SessionCoordinators` seams.

---

## Problem 1 — DB scope is incoherent

### Evidence

`packages/db-core/src/registry.ts:46-51`:

```ts
const realPath = realpathSync(cwd);              // raw cwd, NOT repo root
const gcd = gitCommonDir(cwd);                   // SHARED across worktrees
const projectKey = gcd ?? realPath;
const dbPath = join(paths.projectRoot(realPath), "project.db");
```

The registry **key** is the git common dir (identical for every worktree of a
repo) while the **path** is the raw cwd. `registerProject` upserts on
`project_key` with `db_path = excluded.db_path`, and `openProject(key)` reads
`db_path` back out. Live state on this machine:

| project_key | real_path |
| --- | --- |
| `/Users/dev/src/webapp/webapp/.git` | `/Users/dev/src/webapp/feature-a/subdir` |
| `/Users/dev/src` | `/Users/dev/src` |
| `/Users/dev` | `/Users/dev` |

Consequences:

1. All 18 webapp worktrees collapse onto one registry row and overwrite each
   other's `db_path`; concurrent sessions can race between `resolveProject` and
   `openProject` and open the wrong DB.
2. Keying on raw cwd means a subdirectory gets its own nested `.spider/`
   (`.../feature-a/subdir/.spider/`, not the worktree root).
3. Non-repo cwds litter the filesystem — `~/.spider` and `~/src/.spider` both
   exist today.
4. **The binding is a pure function of cwd, but the work location moves.** The
   primary workflow is: start a session in `/Users/dev/src/webapp` (a *container*
   of worktrees, not a repo), then have an agent run `git worktree add
   webapp/foo` and work there. Every `remember`/`todo`/`run` still lands in the
   container's DB.

Separately: project-tier `memory` has **0 rows** while `global_memory` has 7.
`scopeOf` defaults to `project`, but a `tool-quirk` memory records that
`scope:global` once failed, so writes have been explicitly forced global ever
since. Nothing in `agentsmd-content.ts` or the tool schema teaches *when* to
pick which scope.

### Decision — three tiers

| Tier | Location | Owns |
| --- | --- | --- |
| **global** | `~/.pi/agent/spider/spider.db` | `projects`, `global_memory`, `upstream_refs`, `message_mirror`, `insights`, `model_stats`, **+ new `session_bindings`** |
| **repo** | `<git-common-dir>/spider/repo.db` | `memory`, `memory_fts`, `skills`, `curator_state` — true regardless of branch |
| **worktree** | `<worktree-root>/.spider/project.db` | `sessions`, `sessions_fts`, `content`, `content_fts`, `todos`, `todos_fts`, `runs`, `run_events`, `events` |

Two details that the table alone hides:

- **`insights` stays global.** It is already in `GLOBAL_SCHEMA`
  (`schema.ts:37`), and the curator produces cross-project learning. It is
  deliberately *not* moved to the repo tier; recorded here so it is not
  "corrected" later.
- **Embedding tables must follow their corpus.** `vector_map` and `embed_queue`
  are project-tier today and serve both `memory` and `content`. Splitting those
  corpora across two DBs means **the repo tier needs its own
  `vector_map` / `embed_queue` / runtime `vectors`** for memory embeddings,
  while the worktree tier keeps its set for `content`. `curator_state` follows
  `skills` to the repo tier, since the curator curates skills.

Rationale for the split: a strict per-worktree DB fragments repo knowledge 18
ways — a fact learned in `feature-b` about shared webapp source is invisible from
`feature-a`. Runs, events, todos and the working-tree content index
genuinely *are* branch-local.

`repo.db` lives **inside `.git/`**, not in the checkout: never needs a
`.gitignore` entry, shared by all worktrees automatically, dies with the repo.

Worktree root comes from `git rev-parse --show-toplevel`, which correctly
returns the *worktree* root (`/Users/dev/src/webapp/feature-a`), not the
main worktree. Non-git cwd → repo tier collapses into the worktree tier, so
loose directories behave exactly as they do today.

### Decision — active worktree binding

The binding is **session state**, not a function of cwd. It must live in the
global DB, because the binding is what *selects* the other two DBs:

```sql
CREATE TABLE IF NOT EXISTS session_bindings (
  session_id    TEXT PRIMARY KEY,
  worktree_path TEXT NOT NULL,
  repo_key      TEXT,                 -- git common dir, NULL for loose dirs
  source        TEXT NOT NULL,        -- 'explicit' | 'auto' | 'cwd'
  bound_at      INTEGER NOT NULL
);
```

Resolution order in `buildActionCtx`:

1. explicit `args.cwd` (per-call override — already supported)
2. session binding from the global DB
3. cwd → worktree root

Subagents inherit it for free: `dbPath` is resolved from `ctx` at spawn time
and threaded via `PI_SPIDER_DB_PATH`.

**Surface:** `spider control bind path:"…"` / `bind` (show) / `unbind`, plus a
`/bind` slash command. `bind` with no args renders all three resolved tiers so
the agent can see where a write would land.

**Auto-bind — promote, never switch.** `registerRouting` already hooks
`tool_call`/`tool_result` for every non-spider tool
(`packages/host/src/routing/index.ts:38`), so it observes `bash`/`exec`.
Detect a successful `git worktree add <path>` and bind to it, but **only when
the session is currently bound to a non-repo container or loose dir**. Once
bound to a real worktree, switching requires an explicit `bind`. Always
notifies; always overridable. This makes the primary workflow correct with zero
agent discipline.

### Decision — migration (option B)

`spider control migrate` gains a registry sweep:

1. For each `projects` row, recompute the correct key (worktree root) and
   tier paths.
2. Re-key rows; where a DB sits at a non-root cwd, move it to the worktree
   root. If both exist, merge (worktree-tier tables union by natural key;
   conflicts resolved newest-wins).
3. Split repo-tier tables (`memory`, `memory_fts`, `skills`, `curator_state`)
   out of existing project DBs into the new `repo.db`, re-queueing their
   embeddings into the repo tier's `embed_queue`. Where several worktrees of one
   repo each hold memory rows, union them into the single `repo.db` (uuid is
   unique, so dedupe is by uuid, newest `updated_at` wins).
4. Report every action as a themed card. Dry-run by default; `apply:true`
   commits.

Explicit sweep, not silent adopt-on-open — with 18 worktrees a one-shot
auditable migration beats per-session magic.

### Decision — teaching `remember`

Three coordinated changes, in priority order (the schema description is what
the model actually reads at decision time):

1. `scope` enum becomes `global | repo | worktree` with the decision rule
   inline in the tool schema description.
2. AGENTS.md memory section rewritten around the test:
   > *Is this still true after I delete this worktree?* → `repo`.
   > *Is it true in every repo?* → `global`. Otherwise → `worktree`.
3. `spider control bind` output shows all three resolved tiers.

---

## Problem 2 — intercom is fire-and-pray

### Evidence

`packages/subagents/src/intercom.ts` (27 lines) emits
`subagent:result-intercom` on `pi.events` and waits ≤10s for a delivery ack.
The only listener is the **separate `pi-intercom` npm package**
(`~/.pi/agent/npm/node_modules/pi-intercom/index.ts:902`), which relays over a
unix-socket broker it spawns via `tsx`. If it is absent or disabled, spider
blocks 10s and returns `delivered:false`. No capability probe, no fallback.
The failure mode is **silence**, the worst possible one for a coordination
channel.

`buildChildSpawnSpec` (`packages/subagents/src/pi-args.ts:268`) passes **no
`systemPrompt` at all**. It threads `PI_SUBAGENT_ORCHESTRATOR_TARGET` into env,
but `run.ts` only ever sets `orchestratorTarget: undefined`
(`pipeline.ts:58`). Children therefore have no target, no instructions, and no
knowledge that intercom exists.

### Decision — two channels, not one

**Channel 1: child → parent escalation.** Needs no new transport. The child
already holds a handle to the worktree DB (`PI_SPIDER_DB_PATH`) and already
writes `run_events` that the parent's `RunEventTailer` polls onto the
in-process bus — the mechanism that keeps the agents footer live. An escalation
is simply `run_events.type = 'escalation'`.

The parent surfaces it as a themed `spider.subagent_escalation` message with
`triggerTurn: true`, waking an idle orchestrator (same call already used by
`makeAsyncNotifier` for `spider.subagent_done`).

**Channel 2: session ↔ session.** Promote `message_mirror` (global DB, today
write-only observability) into the real transport:

```sql
ALTER TABLE message_mirror ADD COLUMN id TEXT;            -- uuid
ALTER TABLE message_mirror ADD COLUMN delivered_at INTEGER;
ALTER TABLE message_mirror ADD COLUMN read_at INTEGER;
```

Each session polls the global DB for undelivered rows addressed to it and
delivers via `pi.sendMessage(..., {triggerTurn:true})`. No broker, no socket,
no `tsx`, no external package. Messages survive peer restarts (the row waits).
Cost: ~1s poll latency, and session-name → session-id resolution in the global
registry.

`pi-intercom` bridging is explicitly **out of scope** (deferred until there is
a real need to reach non-spider sessions).

### Decision — subagent instruction contract

`buildChildSpawnSpec` starts passing `--append-system-prompt` with a spider
subagent contract:

- report progress via normal output;
- **escalate rather than guess** when blocked, when the spec is
  self-contradictory, when a destructive/irreversible action seems required, or
  when scope creep is discovered;
- escalation is `spider message` targeting the orchestrator, which is now
  actually populated;
- do not silently substitute a different approach for the one requested.

`orchestratorTarget` is set to the parent session for **every** mode (single,
chain, parallel, pipeline), not just left `undefined`.

---

## Problem 3 — subagents cannot be killed

### Evidence

- `ChildHandle` exposes `kill()` (`runner.ts:11`), but `runAsync` calls
  `handle.detach()` and **discards the handle** (`runner.ts:120`).
- `runs` has no `pid` column (`schema.ts:83`).
- No `kill`/`cancel` action exists anywhere.
- `AgentDetail.handleInput` handles only `escape`
  (`packages/ui/src/agents/agent-detail.ts:18-21`).
- `RunStatus` has included `"cancelled"` since day one
  (`run-store.ts:7`) and **nothing has ever written it**.
- **`defaultSpawner` does not set `detached: true`**
  (`spawn-default.ts:6`). The child `pi` shares the host's process group, so
  even a working `kill()` would signal only `pi` itself and orphan every tool
  subprocess it spawned. `packages/context/src/executor.ts:436` already does
  this correctly (`detached: !isWin` + `process.kill(-pid)`); the subagent
  spawner never got the same treatment.

### Decision

1. **Killable children.** `detached: !isWin` in `defaultSpawner` so each child
   owns a process group. Kill = `process.kill(-pid, "SIGTERM")` → 3s grace →
   `SIGKILL`, mirroring `killTree`.
2. **Handle registry.** Add `children: Map<runId, ChildHandle>` to
   `SessionCoordinators` (`coordinators.ts:4`) — already the per-session
   registry with a `teardownAll` hook, so shutdown-kill comes free. Register on
   spawn, deregister on exit.
3. **Persist `pid` on `runs`** (new column + migration). After a host reload
   the in-process map is empty but children are still alive; kill falls back to
   the DB pid so orphans from a *previous* host process remain killable. This
   is the case that currently forces manual `ps`/`kill`.
4. **Write `status='cancelled'`.** Killed children report cancelled, not
   `failed`, and the completion notifier stays quiet rather than firing a full
   `triggerTurn` wake for a deliberate stop.
5. **Report what was interrupted.** The kill result includes the run's last
   `run_event`, so a child killed mid-`edit` is visible as having possibly left
   the tree dirty.
6. **Agent surface — first-class verb.** `spider kill id:"…"`, where `id`
   accepts a full run id, an id prefix, a run name, or `"all"` (all active runs
   for the session). Chosen over `run op:"kill"` (buries a destructive op behind
   the creation verb) and `control kill` (needs to be reflexive, not admin).
7. **UI.** In `AgentDetail`: `k` arms (frame footer swaps to a warning line),
   second `k` within 3s kills, any other key disarms. Wired via an `onKill`
   callback from `agents-ui.ts`, same pattern as the existing `onBack`.

### Shutdown guarantee (hard requirement)

**Exiting the main session must kill its subagents.** `detached: true` removes
the accidental protection we get today from children sharing the host's process
group, so this has to be made explicit.

Verified against pi 0.80: `registerSignalHandlers`
(`dist/modes/interactive/interactive-mode.js:2940`) registers only `SIGTERM`
(plus `SIGHUP` off-Windows). **Ctrl+C is not a signal handler** — the TUI
consumes it and routes to `shutdown()` → `runtimeHost.dispose()` →
`session_shutdown`.

| Exit path | fires `session_shutdown` | pi kills its own detached children |
| --- | --- | --- |
| `/quit`, Ctrl+D, Ctrl+C | yes | no |
| SIGTERM / SIGHUP (terminal closed) | yes | yes |
| `uncaughtCrash` | no | yes |
| `emergencyTerminalExit` (dead tty) | no | yes |
| `SIGKILL` on the host | no | no |

Two mechanisms cover the whole matrix:

1. **`session_shutdown` → `teardownAll` → kill every registered child.** The
   hook is already registered (`subagents/index.ts:36`); `teardownCoordinators`
   currently stops the tailer and disposes pipelines but has no children to
   kill. Adding the handle registry closes every user-initiated exit — rows 1
   and 2, which is the case the requirement is actually about.

2. **Startup orphan reaper**, for rows 3–5. Persist `host_pid` alongside `pid`
   on `runs`. On session start, scan runs with `status='running'` whose
   `host_pid` is no longer alive; if the child pid is still alive, kill its
   process group; mark the run `cancelled` either way. This is the only
   mechanism that can work after a `SIGKILL`, and it is nearly free once `pid`
   is persisted for the reload case anyway.

**Rejected: registering with pi's own tracker.** `trackDetachedChildPid` /
`killTrackedDetachedChildren` exist in `dist/utils/shell.js` and would cover
rows 2–4 for free, but the package `exports` map exposes only `.` and
`./rpc-entry`, and `@earendil-works/pi-coding-agent` is `external` in
`vite.config.mjs` — so a deep import resolves against the exports map at
runtime and fails. Revisit only if pi promotes these to its public API.

---

## Cross-cutting

### Components touched

| Package | Change |
| --- | --- |
| `db-core` | `resolveProject` re-keying; `repoDb` tier + `REPO_SCHEMA`; `session_bindings`; `message_mirror` columns; `runs.pid` + `runs.host_pid`; migrations |
| `host` | `ActionCtx` gains `repoDb`; `control bind`/`unbind`; `control migrate` sweep; auto-bind detection in `routing`; `kill` action wiring; message poller |
| `memory` | `stageWrite`/`recall` take a tier rather than a two-way scope; `assembleSnapshot` goes from `{global, project}` to `{global, repo, project}` |
| `context` | unified `search` fans out across three tiers instead of two, and merges/ranks the results |
| `subagents` | `detached` spawn; handle registry; kill logic; `--append-system-prompt` contract; `orchestratorTarget` population; escalation events |
| `ui` | `AgentDetail` kill affordance; bind + kill + escalation renderers |
| `superpowers` | AGENTS.md memory/intercom/kill sections |

### Testing

- **db-core:** worktree-root keying for main worktree, linked worktree,
  subdirectory-of-worktree, loose dir, and bare repo; migration sweep
  idempotence and merge conflict resolution.
- **host:** binding resolution precedence (args.cwd > binding > cwd);
  auto-bind promotes from container but does not switch between worktrees.
- **subagents:** kill via live handle; kill via DB pid fallback with no handle;
  kill of an already-exited run is a no-op; `cancelled` status written; process
  group actually torn down; `session_shutdown` kills all registered children;
  reaper cancels runs whose `host_pid` is dead and spares runs whose host is
  still alive.
- **ui:** `k` arms, second `k` fires, intervening key disarms, timeout disarms.
- **intercom:** message survives peer restart; poller delivers exactly once;
  escalation reaches the parent bus.

### Ordering

The three problems are independently shippable. Recommended sequence:

1. **Kill** — smallest, highest immediate pain relief, no schema fan-out beyond
   `runs.pid`.
2. **Tiering + binding** — largest blast radius; wants the migration sweep
   landed and exercised before intercom writes depend on tier placement.
3. **Intercom** — depends on the global DB being settled by (2).

### Risks

- **Migration data loss.** Mitigated by dry-run default, explicit `apply:true`,
  and a backup into `~/.pi/agent/spider/backups/` before any move.
- **Auto-bind surprise.** Mitigated by promote-never-switch plus a visible
  notification on every bind.
- **Poll latency** on channel 2 (~1s) is acceptable for a coordination channel
  that today frequently delivers *never*.
- **Three open handles per call** instead of two, and a second set of embedding
  tables. Accepted: the DBs are WAL SQLite opened lazily, and the alternative
  (fanning reads across 18 sibling worktrees) is strictly worse.
- **`detached: true` behaviour change** — children no longer die incidentally
  with the host's process group. Covered by the two mechanisms in *Shutdown
  guarantee* above; this is a hard requirement, not a best-effort.
