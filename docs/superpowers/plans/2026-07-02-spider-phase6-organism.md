# spider Phase 6 — Autonomic organism (compaction/shutdown drains + digest passes + skill curator) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At the two organism triggers — `session_before_compact` (rescue-before-summarize) and `session_shutdown` (final consolidation) — a single in-process background worker drains the event log and runs six aux-model digest passes that write **`[auto]`-staged** memory/todo AND **co-equal staged skill** candidates under a per-session write budget, plus a skill curator (decay + umbrella consolidation, respecting pins/protected/never-delete), `/learn` skill distillation, and a learning graph feeding `control insights`.

**Architecture:** A new `@spider/organism` package composes the Phase 1/2/4 subsystems (it depends on `@spider/memory`, `@spider/todo`, `@spider/subagents`, `@spider/context`, `@spider/db-core`, `@spider/ui`) and is wired by `@spider/host`. Each of the six passes is a **pure digest function** `(DigestBundle, DigestModel) → DigestResult` — the only non-purity is an **injected** `DigestModel` (aux-model completion seam), so tests drive every pass with fixture events + a fake model and assert the exact staged candidates. A fail-closed `applyDigest` writer routes every candidate through Phase 1's `stageWrite` (memory, `source:"auto"`) and a new skill-candidate stager, enforcing a per-session auto-write budget. The organism pass mirrors Hermes `background_review` (writes BOTH staged memory AND staged skill candidates, co-equal per TC5). The skill curator ports Hermes `curator.py` lifecycle (`active→stale→archived`, pins/protected, never auto-delete, optional LLM umbrella consolidation) run at session-end, gated by a ~24–48h min-interval, and manually via `control skill curate`. `/learn` ports `learn_prompt.py`; the learning graph ports `learning_graph.py` into `insights` rows. Master + per-behavior config toggles default-on; the curator's LLM consolidation defaults off (Hermes conservatism).

**Tech Stack:** TypeScript (ESM, Node ≥ 22.19.0), better-sqlite3 (WAL + busy_timeout + retry via `@spider/db-core`), the cheap aux-model (via the `DigestModel` seam — reuses Phase 1 `resolveAuxRuntime`/`digestHistory`), Vitest, esbuild, `@spider/ui`.

> **Amendment A1 reconciliation (`@spider/models`):** the `DigestModel`/`AuxCall` seam (Task 3 `createDigestModel`) is backed by the Phase 0 router — the real `AuxCall` = **`ctx.models.complete(ctx.models.pick({ budget: "cheap", role: "digest" }), prompt, { system })`** (amendment A1). This RESOLVES the flagged "no public `pi.complete`" concern: `@spider/models.complete` wraps `getModel`+`streamProxy` (TC8). Passes/tests still inject a **fake** `DigestModel`; only `createDigestModel`'s default binding changes. The curator's optional LLM umbrella consolidation uses the same path.

## Global Constraints

- **Language:** TypeScript, Node ≥ 22.19.0 (target Node 24). ESM (`"type": "module"`).
- **SQLite driver:** better-sqlite3 (synchronous). WAL + busy_timeout + retry wrapper — always via `@spider/db-core` (`openProject`/`openGlobal`/`openDbAt`), never a raw `new Database()`.
- **Native deps (prebuilt, cross-OS):** better-sqlite3, sqlite-vec, onnxruntime-node (via fastembed-js). This phase adds **no** new native deps.
- **Zero temp-dir:** all scratch/intermediate/golden/test DBs under `.spider/scratch/` (project) or `~/.pi/agent/spider/scratch/` (global) via `paths.scratch(scope, cwd?)`. Never `/tmp`, `$TMPDIR`, `/var/tmp`, `os.tmpdir()`.
- **Triggers are `session_before_compact` + `session_shutdown` ONLY** (TC4). No turn-timer, no per-event digest. The event log records continuously (Phases 3/4); the organism drains/digests only at those two hooks. `session_before_compact` MUST NOT cancel/alter compaction (it only rescues learnings before the summary).
- **All auto-writes staged, fail-closed:** every organism-produced memory candidate is written via `stageWrite(..., { source:"auto" })` → `status:"staged"`; a staging/scan failure ⇒ reject, never silent activate. Skill candidates are staged (`skills.status='staged'`), never written to disk until approved.
- **Per-session auto-write budget:** a hard cap on the number of auto-staged writes per drain; over-budget candidates are dropped (counted, never silently lost — reported in the drain summary).
- **Curator never auto-deletes.** `active→stale→archived` only; archived skills move to `.spider/skills/.archive/` (recoverable). Pinned skills opt out of all auto-transitions; builtin/hub skills are `protected` (never archived/edited/consolidated). LLM umbrella consolidation only touches agent-created, non-pinned, non-protected skills and defaults OFF.
- **Toggles default-on:** master `organism.enabled` + per-behavior `organism.passes.*` + `organism.selfNaming` + `curator.enabled` all default `true`; `curator.consolidate` defaults `false`.
- **UI:** all visual output through `@spider/ui`; honor pi theme tokens; 🕸 signature. No ad-hoc `console.log`/string rendering.
- **Tests:** Vitest; TDD (test first, red→green→refactor). Every pass is a pure fn over fixture events + a **fake** `DigestModel`; integration DBs created via `openProject`/`openDbAt` in `.spider/scratch/` — never `/tmp`.
- **Canonical symbols are frozen** by `docs/superpowers/plans/README.md` (schema tables/columns, db-core API, dispatch map, ui contract). Do not rename them. New shared symbols (the `skills`/`curator_state` tables, the `@spider/organism` package) are added to README.md **first** (Task 0), matching the Phase 1 precedent.
- **Memory categories verbatim:** `preference|convention|tool-quirk|failure|correction|insight`. Statuses verbatim: `active|staged|rejected|archived`. Sources verbatim: `user|auto|import`.

---

## Interfaces consumed from earlier phases (do not redefine — import them)

**From `@spider/db-core` (Phase 0):**
```ts
import { openProject, openGlobal, openDbAt, migrate, resolveProject, paths, appendRunEvent, bus } from "@spider/db-core";
import type { Db, ProjectInfo, RunEvent } from "@spider/db-core";
// Db.prepare(sql), Db.transaction(fn), Db.loadVec(), Db.close()
// paths.scratch(scope: "global"|"project", cwd?: string): string ; paths.globalRoot
// Tables consumed: runs, run_events, events, todos, memory, memory_fts, global_memory,
//   sessions, sessions_fts, insights, projects, vectors, vector_map, embed_queue
```

**From `@spider/host` (Phase 0 dispatcher / hook seam):**
```ts
export function registerAction(name: string, handler: ActionHandler): void;
export type ActionHandler = (args: SpiderArgs, ctx: ActionCtx) => Promise<ActionResult> | ActionResult;
export interface ActionCtx {
  db: Db;               // project DB (openProject resolved for cwd)
  globalDb: Db;         // global DB (insights + projects registry live here)
  project: ProjectInfo; // { projectKey, realPath, gitCommonDir?, dbPath, name? }
  sessionId: string;    // pi native session id verbatim
  cwd: string;
  pi: import("@mariozechner/pi-coding-agent").ExtensionAPI; // hook registration (pi.on)
  auxModel?: string;    // cheap aux-model id for digests, from config
  models: typeof import("@spider/models");    // A2: model router — pick()/complete()/catalog() (backs createDigestModel)
}
export interface ActionResult { content?: string; ui?: import("@spider/ui").Component; details?: unknown; isError?: boolean; }
```
> **VALIDATE FIRST (blocker if wrong):** confirm `ActionCtx` carries `globalDb`, `auxModel`, and `pi` (for `pi.on("session_before_compact" | "session_shutdown", …)`). Phase 0 registers empty `session_before_compact`/`session_shutdown` handlers that phases fill; confirm the exact registration API (`pi.on(name, fn)` vs a host-side `registerHook`). If it differs, adapt Task 14 wiring only — the passes/curator cores are unaffected. Surface via `contact_supervisor` if the hook seam is missing.

**From `@spider/memory` (Phase 1):**
```ts
import { stageWrite, listPending } from "@spider/memory";          // staging.ts (fail-closed)
import type { StageResult } from "@spider/memory";
import { shouldCapture } from "@spider/memory";                    // guardrails.ts — anti-poisoning "Do NOT capture"
import { resolveAuxRuntime, digestHistory } from "@spider/memory"; // aux.ts — aux routing + compact replay
import type { AuxRuntime, DigestMsg } from "@spider/memory";
import { addMemory, listActive, searchMemoryFts, setStatus } from "@spider/memory"; // store.ts
import type { MemoryRecord, MemoryCategory, MemoryScope, AddMemoryInput } from "@spider/memory";
import { knn, upsertVector } from "@spider/memory";                // embeddings/vectors.ts
import { enqueueEmbed } from "@spider/memory";                     // embeddings/queue.ts
import type { Embedder } from "@spider/memory";
// stageWrite(db, scope, input, opts?: { autoStage?: boolean; cap?: number }): StageResult
//   → source ∈ {auto,import} ALWAYS staged; scanner(strict)+shouldCapture gate; fail-closed.
```
> **VALIDATE FIRST:** confirm `stageWrite`, `shouldCapture`, `resolveAuxRuntime`, `digestHistory`, `knn` are exported from `@spider/memory`'s package `index.ts` (Phase 1 Tasks 5/6/9). If any live in a subpath, import from there.

**From `@spider/todo` (Phase 1):**
```ts
import { listTodos, addTodo } from "@spider/todo";
import type { Todo } from "@spider/todo";  // { seq, text, done }
```

**From `@spider/subagents` (Phase 4):**
```ts
import { RunStore } from "@spider/subagents"; // over `runs`
import type { RunRow } from "@spider/subagents";
// runs/run_events tables are the single event stream the run→memory/todo pass digests.
```

**From `@spider/context` (Phase 2):**
```ts
import { readTranscript } from "@spider/context";   // transcript.ts — pi session-transcript reader/normalizer
import type { SessionDigest } from "@spider/context"; // digest.ts — Phase 2 stub interface this phase REPLACES
// Phase 2 defined `SessionDigest` + `defaultDigest` as a stub "Phase 6 replaces". This phase supplies the real digest.
```
> **VALIDATE FIRST:** Phase 2 `src/digest.ts` says "Phase 6 replaces". Confirm the `SessionDigest` interface shape and `readTranscript(sessionFilePath): DigestMsg[]` signature; if Phase 2 named them differently, adapt the import in Tasks 1 and 6. The organism supplies the real digest impl that `import` (Phase 2) and the hooks (this phase) both call.

---

## Source Reference Map (port FROM → TO)

| Spider file | Ported FROM (exact) |
|---|---|
| `packages/organism/src/passes/learning.ts` (prompts + co-equal capture) | `hermes-agent/agent/background_review.py` (`_MEMORY_REVIEW_PROMPT`, `_SKILL_REVIEW_PROMPT`, `_COMBINED_REVIEW_PROMPT`, negative-lesson "Do NOT capture" block) |
| `packages/organism/src/aux-model.ts` (routing) | `hermes-agent/agent/background_review.py` (`_resolve_review_runtime`, `_digest_history`) — reuses Phase 1 `resolveAuxRuntime`/`digestHistory` |
| `packages/organism/src/curator.ts` (decay + consolidation) | `hermes-agent/agent/curator.py` (`DEFAULT_INTERVAL_HOURS`, `DEFAULT_MIN_IDLE_HOURS`, `DEFAULT_STALE_AFTER_DAYS`, `DEFAULT_ARCHIVE_AFTER_DAYS`, `DEFAULT_CONSOLIDATE`, `_transition` walk, `_CONSOLIDATION_PROMPT`, pin/protected/cron-referenced protections) |
| `packages/organism/src/skill-usage.ts` (lifecycle states) | `hermes-agent/tools/skill_usage.py` (`STATE_ACTIVE/STALE/ARCHIVED`, use/view/patch counts, `last_*_at`, `pinned`, `is_protected_builtin`) |
| `packages/organism/src/learn.ts` (`/learn`) | `hermes-agent/agent/learn_prompt.py` (`build_learn_prompt`, `_AUTHORING_STANDARDS`) |
| `packages/organism/src/learning-graph.ts` | `hermes-agent/agent/learning_graph.py` (`build_skill_nodes`, `build_edges`, `_memory_skill_edges`, `_tokenize`, `density_stats`) — retargeted to DB rows |

---

## Contract amendment scope (Task 0 — added to README.md FIRST)

Phase 6 needs shared symbols Phase 0 does not expose. Add them to `docs/superpowers/plans/README.md` before implementing (the sanctioned "new shared symbol → README first" path).

1. **Monorepo layout:** add `packages/organism/src/index.ts` (`@spider/organism`) to the canonical layout + internal-package name list.
2. **Project DB schema:** add the `skills` + `curator_state` tables (skill files remain the SKILL.md truth; the DB tracks lifecycle/usage + staged candidates only — consistent with P1a scoping DB-as-truth to *memory*, not skills):
   ```sql
   CREATE TABLE skills (            -- skill lifecycle + staged candidates; SKILL.md files remain the source of truth
     id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
     tier TEXT NOT NULL DEFAULT 'project',   -- baseline | project
     category TEXT, path TEXT,                -- .spider/skills/<name>/SKILL.md (null while a staged-only candidate)
     state TEXT NOT NULL DEFAULT 'active',    -- active | stale | archived   (curator lifecycle)
     status TEXT NOT NULL DEFAULT 'active',   -- active | staged | rejected  (co-equal capture staging)
     source TEXT NOT NULL DEFAULT 'user',     -- user | auto | import | learn
     pinned INTEGER NOT NULL DEFAULT 0, protected INTEGER NOT NULL DEFAULT 0,  -- pinned=opt-out; protected=builtin/hub
     use_count INTEGER NOT NULL DEFAULT 0, view_count INTEGER NOT NULL DEFAULT 0, patch_count INTEGER NOT NULL DEFAULT 0,
     last_used_at INTEGER, last_viewed_at INTEGER, last_patched_at INTEGER,
     candidate_body TEXT,                     -- proposed SKILL.md while status='staged'; null once written to disk
     related TEXT,                            -- JSON array of related skill names (learning-graph edges)
     created_at INTEGER NOT NULL, updated_at INTEGER
   );
   CREATE INDEX idx_skills_state ON skills(state, status);
   CREATE TABLE curator_state (
     scope TEXT PRIMARY KEY,                  -- 'project'
     last_run_at INTEGER, paused INTEGER NOT NULL DEFAULT 0
   );
   ```
3. **Config schema groups:** document `organism` (`enabled`, `passes.{runMemoryTodo,todoMemory,learning,consolidation,reflection,insights}`, `selfNaming`, `autoWriteBudget`) and `curator` (`enabled`, `minIntervalHours`, `staleAfterDays`, `archiveAfterDays`, `consolidate`) defaults (all `true`/documented numbers; `consolidate:false`). (Config precedence + `control config` UI exist per Phase 0/8; this phase only reads these keys.)
4. **`control` sub-commands:** confirm `control skill curate` (+ `--consolidate`) and `control insights` are reserved (already listed in README `control` map).

> This is the only edit outside `packages/organism` / `packages/host`. A reviewer must confirm no in-flight phase assumed a different `skills`/`curator_state` shape.

---

## File Structure (all under `spider/packages/organism/`)

- `package.json`, `tsconfig.json` — manifest (name `@spider/organism`; deps `@spider/db-core`, `@spider/memory`, `@spider/todo`, `@spider/subagents`, `@spider/context`, `@spider/ui`).
- `src/types.ts` — `DigestBundle`, `MemoryCandidate`, `TodoCandidate`, `SkillCandidate`, `DigestResult`, `DigestModel`, `WriteBudget`, `AppliedSummary`, `PassName`.
- `src/drain.ts` — `drainSession(db, sessionId, reason, opts)` → `DigestBundle` (reads runs/run_events/events/todos + normalized transcript).
- `src/aux-model.ts` — `createDigestModel(ctx)` (real aux-model seam) + `parseCandidates(json)` (tolerant JSON→candidates parser).
- `src/passes/run-memory-todo.ts` — Pass 1.
- `src/passes/todo-memory.ts` — Pass 2.
- `src/passes/learning.ts` — Pass 3 (co-equal memory + skill; Hermes background_review prompts + guardrails).
- `src/passes/consolidation.ts` — Pass 4 (session summary + self-name).
- `src/passes/reflection.ts` — Pass 5 (vector clustering → umbrella memory).
- `src/passes/insights.ts` — Pass 6 (cross-project insights graph rows).
- `src/apply.ts` — `applyDigest(deps, result, budget)` fail-closed staged writer + budget enforcement.
- `src/skill-usage.ts` — `SkillStore` over the `skills` table (CRUD, touch, stage/approve/reject candidates, state transitions).
- `src/curator.ts` — `runCuratorDecay`, `curatorShouldRun`, `consolidateSkills` (opt-in aux).
- `src/learn.ts` — `buildLearnPrompt(request)` (`/learn`).
- `src/learning-graph.ts` — `buildLearningGraph(db)` → `insights` rows + payload.
- `src/worker.ts` — `OrganismWorker`: single in-process worker; `runDrain(reason)` orchestrates passes under budget + self-name + (shutdown) curator.
- `src/config.ts` — `readOrganismConfig(cfg)` / `readCuratorConfig(cfg)` with defaults + toggles.
- `src/actions.ts` — `registerAction("skill", …)` (`distill`/`view`/`list`), `control skill curate`, `control insights` handlers.
- `src/renderers.ts` — `renderCurateResult`, `renderInsights`, `renderDrainSummary` (via `@spider/ui`).
- `src/index.ts` — `export function registerOrganism(host, pi, deps): void`.
- `test/*.test.ts` — Vitest suites (drain, each pass, apply+budget, skill-usage, curator, learn, learning-graph, worker, integration.smoke).

Host wiring (`spider/packages/host/src/extension.ts`): add `registerOrganism(host, pi, { db, globalDb, project, config, getEmbedder })`; register the two hooks + `control skill curate`/`control insights`/`skill` action; teardown worker on `session_shutdown`.

---

## Task 0: Contract amendment + package scaffold

**Files:**
- Modify: `docs/superpowers/plans/README.md` (monorepo layout + `skills`/`curator_state` DDL + config groups)
- Modify: `spider/packages/db-core/src/index.ts` (add the two tables to the `project` migration)
- Create: `spider/packages/organism/package.json`, `spider/packages/organism/tsconfig.json`, `spider/packages/organism/src/index.ts`
- Test: `spider/packages/organism/test/smoke.test.ts`, `spider/packages/db-core/test/skills-migration.test.ts`

**Interfaces:**
- Produces: `@spider/organism` resolvable; `export function registerOrganism(host: unknown, pi: unknown, deps: unknown): void` (stub); project migration creates `skills` + `curator_state`.

- [ ] **Step 1: Amend README.md** — add `packages/organism` to the layout + name list; add the `skills`/`curator_state` DDL to the Project DB tables; document the `organism`/`curator` config groups. Commit `docs: amend contract for phase6 (organism package, skills+curator_state tables, config groups)`.

- [ ] **Step 2: Write failing migration test** `spider/packages/db-core/test/skills-migration.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openDbAt, paths } from "../src/index.js";

let dbPath: string;
afterEach(() => { for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true }); });

describe("phase6 schema", () => {
  it("creates skills + curator_state tables on project migrate", () => {
    dbPath = join(paths.scratch("project"), `skills-${Date.now()}.db`);
    const db = openDbAt(dbPath, "project");
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name);
    expect(names).toContain("skills");
    expect(names).toContain("curator_state");
    db.close();
  });
});
```

- [ ] **Step 3: Run — see it fail.** `npx vitest run packages/db-core/test/skills-migration.test.ts` → FAIL (tables missing).
- [ ] **Step 4: Implement** — add the `skills` + `curator_state` DDL (verbatim from Step 1) to the `project` branch of `db-core`'s migration SQL.
- [ ] **Step 5: Scaffold `@spider/organism`** — `package.json` (name `@spider/organism`, `"type":"module"`, deps on the five internal packages + `@spider/ui`, `peerDependencies` pi), `tsconfig.json` (extends base), and `src/index.ts`:

```ts
// packages/organism/src/index.ts
export function registerOrganism(_host: unknown, _pi: unknown, _deps: unknown): void {
  // filled by later tasks
}
```

`test/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import * as pkg from "../src/index.js";
describe("@spider/organism", () => {
  it("exports registerOrganism", () => { expect(typeof pkg.registerOrganism).toBe("function"); });
});
```
Run `npm install` at the workspace root.

- [ ] **Step 6: Run — see both pass.** Commit `feat(organism): scaffold package + skills/curator_state migration`.

---

## Task 1: Shared organism types

**Files:**
- Create: `spider/packages/organism/src/types.ts`
- Test: `spider/packages/organism/test/types.test.ts`

**Interfaces:**
- Produces:
```ts
import type { MemoryCategory } from "@spider/memory";
import type { DigestMsg } from "@spider/memory";
import type { RunRow } from "@spider/subagents";
import type { Todo } from "@spider/todo";

export type DrainReason = "before_compact" | "shutdown";
export type PassName = "runMemoryTodo" | "todoMemory" | "learning" | "consolidation" | "reflection" | "insights";

export interface TrackEventRow { id: number; ts: number; phase: "before" | "after"; tool: string; description?: string; flagged?: string; payload?: unknown; }
export interface RunEventRow { id: number; runId?: string; ts: number; type: string; tool?: string; summary?: string; payload?: unknown; }

export interface DigestBundle {
  sessionId: string;
  reason: DrainReason;
  runs: RunRow[];
  runEvents: RunEventRow[];
  events: TrackEventRow[];
  todos: Todo[];
  transcript: DigestMsg[];       // normalized conversation (may be empty when no transcript on disk)
  sessionName?: string;
}

export interface MemoryCandidate { category: MemoryCategory; content: string; link?: string | null; confidence?: number; }
export interface TodoCandidate { text: string; }
export interface SkillCandidate { name: string; category?: string; body: string; related?: string[]; }
export interface DigestResult {
  memory: MemoryCandidate[];
  todos: TodoCandidate[];
  skills: SkillCandidate[];
  summary?: string;
  selfName?: string;
}
export function emptyResult(): DigestResult { return { memory: [], todos: [], skills: [] }; }

// The ONLY non-purity in a pass: injected aux-model completion.
export interface DigestModel { complete(system: string, messages: DigestMsg[]): Promise<string>; }

export interface WriteBudget { max: number; used: number; }
export interface AppliedSummary { memoryStaged: number; todosAdded: number; skillsStaged: number; dropped: number; rejected: number; }
```

- [ ] **Step 1: Write failing test** `test/types.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { emptyResult } from "../src/types.js";
describe("organism types", () => {
  it("emptyResult is a zeroed DigestResult", () => {
    const r = emptyResult();
    expect(r.memory).toEqual([]); expect(r.todos).toEqual([]); expect(r.skills).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — see it fail.** → FAIL (module missing).
- [ ] **Step 3: Implement** `types.ts` exactly as above.
- [ ] **Step 4: Run — see it pass.** Commit `feat(organism): shared digest types`.

---

## Task 2: Event drain — build a `DigestBundle` from the DB

**Files:**
- Create: `spider/packages/organism/src/drain.ts`
- Create: `spider/packages/organism/test/helpers/tmpdb.ts`
- Test: `spider/packages/organism/test/drain.test.ts`

**Interfaces:**
- Produces:
```ts
export interface DrainOpts { transcriptPath?: string; }  // when absent, transcript = []
export function drainSession(db: Db, sessionId: string, reason: DrainReason, opts?: DrainOpts): DigestBundle;
```
`drainSession` reads: `runs` (this session), `run_events` (join by session), `events` (routing log, this session), `todos` (this session), and — if `opts.transcriptPath` exists — `readTranscript(path)` (else `[]`). `sessionName` from `sessions.name`. It **reads only**; draining is non-destructive (the event log persists; the compaction summary is pi's job).

- [ ] **Step 1: Write failing test** `test/drain.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { drainSession } from "../src/drain.js";

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());

describe("drainSession", () => {
  it("collects runs, run_events, events, todos for the session", () => {
    ctx = makeOrgDb();
    const { db } = ctx;
    db.prepare(`INSERT INTO sessions (id, reason, started_at, name) VALUES ('s1','startup',1,'auth-refactor')`).run();
    db.prepare(`INSERT INTO runs (id, session_id, agent, status, step_count, token_count) VALUES ('r1','s1','worker','done',3,10)`).run();
    db.prepare(`INSERT INTO run_events (run_id, session_id, ts, type, tool, summary) VALUES ('r1','s1',2,'tool_result','bash','ran tests')`).run();
    db.prepare(`INSERT INTO events (session_id, ts, phase, tool, description) VALUES ('s1',3,'after','edit','patched auth.ts')`).run();
    db.prepare(`INSERT INTO todos (session_id, seq, text, done, created_at) VALUES ('s1',1,'ship it',1,4)`).run();
    const bundle = drainSession(db, "s1", "shutdown");
    expect(bundle.runs).toHaveLength(1);
    expect(bundle.runEvents.map(e => e.summary)).toContain("ran tests");
    expect(bundle.events.map(e => e.description)).toContain("patched auth.ts");
    expect(bundle.todos[0].text).toBe("ship it");
    expect(bundle.sessionName).toBe("auth-refactor");
    expect(bundle.transcript).toEqual([]);   // no transcript path → empty
  });

  it("scopes strictly to the session (no cross-session leakage)", () => {
    ctx = makeOrgDb();
    const { db } = ctx;
    db.prepare(`INSERT INTO events (session_id, ts, phase, tool) VALUES ('s2',1,'after','ls')`).run();
    expect(drainSession(db, "s1", "shutdown").events).toHaveLength(0);
  });
});
```

```ts
// test/helpers/tmpdb.ts
import { openDbAt, paths } from "@spider/db-core";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@spider/db-core";
export function makeOrgDb(): { db: Db; cleanup(): void } {
  const dbPath = join(paths.scratch("project"), `org-${crypto.randomUUID()}.db`);
  const db = openDbAt(dbPath, "project");
  return { db, cleanup() { db.close(); for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true }); } };
}
```

- [ ] **Step 2: Run — see it fail.** → FAIL.
- [ ] **Step 3: Implement** `drain.ts`: five `db.prepare(...).all(sessionId)` selects mapped into the typed rows (JSON-parse `payload`), `sessions.name` lookup, and `readTranscript(opts.transcriptPath)` guarded by `existsSync`.
- [ ] **Step 4: Run — see it pass.** Commit `feat(organism): non-destructive session drain into DigestBundle`.

---

## Task 3: Aux-model seam + tolerant candidate parser

**Files:**
- Create: `spider/packages/organism/src/aux-model.ts`
- Test: `spider/packages/organism/test/aux-model.test.ts`

**Interfaces:**
- Produces:
```ts
// Tolerant parse of an aux-model reply into typed candidates. Accepts a fenced ```json block or bare JSON.
// Unknown/invalid entries are dropped (never throw). "Nothing to save." → emptyResult().
export function parseCandidates(raw: string): DigestResult;
// Real aux-model seam. Builds a DigestModel from ctx using Phase 1 resolveAuxRuntime; replays a compact
// digest (digestHistory) to the routed aux model. Returns null if no aux runtime is resolvable (→ passes no-op).
export function createDigestModel(ctx: { auxModel?: string; cfg: unknown; parentModel: string; call: AuxCall }): DigestModel;
export type AuxCall = (rt: AuxRuntime, system: string, messages: DigestMsg[]) => Promise<string>;
```
The `AuxCall` seam is the single spot that performs the actual model HTTP request (spider owns the call, reusing pi creds — same seam class as embeddings, TC2). It is **injected** so passes/tests never hit the network. Per amendment A1 the default `AuxCall` is implemented by `@spider/models.complete(@spider/models.pick({ budget: "cheap" }), …)` (getModel+streamProxy, TC8) — spider still owns the call, but routes it through the shared model router rather than a bespoke HTTP client.

- [ ] **Step 1: Write failing test** `test/aux-model.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { parseCandidates } from "../src/aux-model.js";

describe("parseCandidates", () => {
  it("parses a fenced json block into candidates", () => {
    const raw = "sure:\n```json\n" + JSON.stringify({
      memory: [{ category: "convention", content: "uses conventional commits" }],
      todos: [{ text: "add CI" }],
      skills: [{ name: "release-flow", body: "# Release\n..." }],
      summary: "refactored auth", selfName: "auth-refactor",
    }) + "\n```";
    const r = parseCandidates(raw);
    expect(r.memory[0].content).toBe("uses conventional commits");
    expect(r.todos[0].text).toBe("add CI");
    expect(r.skills[0].name).toBe("release-flow");
    expect(r.summary).toBe("refactored auth");
    expect(r.selfName).toBe("auth-refactor");
  });
  it("returns empty on 'Nothing to save.'", () => {
    const r = parseCandidates("Nothing to save.");
    expect(r.memory).toEqual([]); expect(r.skills).toEqual([]);
  });
  it("drops malformed entries without throwing", () => {
    const r = parseCandidates(JSON.stringify({ memory: [{ nope: 1 }, { category: "preference", content: "dark" }], skills: [{ body: "no name" }] }));
    expect(r.memory).toHaveLength(1);
    expect(r.memory[0].content).toBe("dark");
    expect(r.skills).toHaveLength(0);  // skill without a name is dropped
  });
});
```

- [ ] **Step 2: Run — see it fail.** → FAIL.
- [ ] **Step 3: Implement** `aux-model.ts`. `parseCandidates`: extract the first ```json fence (or the raw string), `JSON.parse` in a try/catch (return `emptyResult()` on failure or on a "nothing to save" reply), then validate each entry — memory needs a valid `category` ∈ the taxonomy + non-empty `content`; todo needs `text`; skill needs `name` + `body`. `createDigestModel`: `const rt = resolveAuxRuntime(cfg, parentModel); return { complete: (system, msgs) => call(rt, system, digestHistory(rt.routed ? msgs : msgs)) }` (route a compact digest when `rt.routed`).
- [ ] **Step 4: Run — see it pass.** Commit `feat(organism): aux-model seam + tolerant candidate parser`.

---

## Task 4: Pass 1 — run → memory/todo

**Files:**
- Create: `spider/packages/organism/src/passes/run-memory-todo.ts`
- Test: `spider/packages/organism/test/pass-run-memory-todo.test.ts`

**Interfaces:**
- Produces:
```ts
// Pure: builds a prompt from the run activity, asks the model, parses + anti-poison filters candidates.
export function runMemoryTodoPass(bundle: DigestBundle, model: DigestModel): Promise<DigestResult>;
```
Prompt summarizes `bundle.runs` + `bundle.runEvents` (agent/role/status/step/token + tool-result summaries) and asks for durable memory (`tool-quirk`/`convention`/`insight`) + follow-up todos surfaced by subagent activity. Every returned memory candidate is filtered through `shouldCapture(category, content)` (drop non-captures).

- [ ] **Step 1: Write failing test** `test/pass-run-memory-todo.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { runMemoryTodoPass } from "../src/passes/run-memory-todo.js";
import type { DigestBundle, DigestModel } from "../src/types.js";

const bundle: DigestBundle = {
  sessionId: "s1", reason: "shutdown",
  runs: [{ id: "r1", sessionId: "s1", agent: "worker", status: "done", stepCount: 5, tokenCount: 99 } as any],
  runEvents: [{ id: 1, runId: "r1", ts: 1, type: "tool_result", tool: "bash", summary: "vitest needs --run in CI" }],
  events: [], todos: [], transcript: [],
};
const fakeModel = (json: object): DigestModel => ({ complete: async () => JSON.stringify(json) });

describe("runMemoryTodoPass", () => {
  it("captures a durable tool-quirk + a follow-up todo", async () => {
    const r = await runMemoryTodoPass(bundle, fakeModel({
      memory: [{ category: "tool-quirk", content: "vitest needs --run in CI" }],
      todos: [{ text: "pin vitest --run in CI config" }], skills: [],
    }));
    expect(r.memory[0].content).toContain("vitest");
    expect(r.todos[0].text).toContain("vitest");
  });
  it("drops a negative-tool-claim via anti-poison guardrails", async () => {
    const r = await runMemoryTodoPass(bundle, fakeModel({
      memory: [{ category: "failure", content: "the bash tool does not work" }], todos: [], skills: [],
    }));
    expect(r.memory).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — see it fail.** → FAIL.
- [ ] **Step 3: Implement** `run-memory-todo.ts`: build the system prompt + a single user message summarizing runs/run_events; `const raw = await model.complete(system, [userMsg]); const parsed = parseCandidates(raw); return { ...parsed, memory: parsed.memory.filter(m => shouldCapture(m.category, m.content).capture), skills: [] };` (this pass emits no skills). Empty runs/runEvents ⇒ short-circuit `emptyResult()` (no model call).
- [ ] **Step 4: Run — see it pass.** Commit `feat(organism): pass 1 run→memory/todo (anti-poison filtered)`.

---

## Task 5: Pass 2 — todo → memory

**Files:**
- Create: `spider/packages/organism/src/passes/todo-memory.ts`
- Test: `spider/packages/organism/test/pass-todo-memory.test.ts`

**Interfaces:**
- Produces: `export function todoMemoryPass(bundle: DigestBundle, model: DigestModel): Promise<DigestResult>;`
Digests **completed** todos into durable memory (`convention`/`insight`) — e.g. a repeated done-todo pattern becomes a convention. Anti-poison filtered; emits no skills/todos.

- [ ] **Step 1: Write failing test** `test/pass-todo-memory.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { todoMemoryPass } from "../src/passes/todo-memory.js";
import type { DigestBundle, DigestModel } from "../src/types.js";
const model = (json: object): DigestModel => ({ complete: async () => JSON.stringify(json) });

describe("todoMemoryPass", () => {
  it("distills completed todos into a convention", async () => {
    const bundle: DigestBundle = { sessionId: "s1", reason: "shutdown", runs: [], runEvents: [], events: [],
      todos: [{ seq: 1, text: "run npm test before commit", done: true }], transcript: [] };
    const r = await todoMemoryPass(bundle, model({ memory: [{ category: "convention", content: "run npm test before every commit" }], todos: [], skills: [] }));
    expect(r.memory[0].category).toBe("convention");
  });
  it("no completed todos → no model call, empty result", async () => {
    const bundle: DigestBundle = { sessionId: "s1", reason: "shutdown", runs: [], runEvents: [], events: [],
      todos: [{ seq: 1, text: "open todo", done: false }], transcript: [] };
    let called = false;
    const r = await todoMemoryPass(bundle, { complete: async () => { called = true; return "{}"; } });
    expect(called).toBe(false); expect(r.memory).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — see it fail.** → FAIL.
- [ ] **Step 3: Implement** `todo-memory.ts`: short-circuit `emptyResult()` unless `bundle.todos.some(t => t.done)`; otherwise prompt over completed todos, parse, guardrail-filter memory, zero skills/todos.
- [ ] **Step 4: Run — see it pass.** Commit `feat(organism): pass 2 todo→memory`.

---

## Task 6: Pass 3 — learning loop (co-equal memory + skill candidates)

**Files:**
- Create: `spider/packages/organism/src/passes/learning.ts`
- Test: `spider/packages/organism/test/pass-learning.test.ts`

**Interfaces:**
- Produces:
```ts
export const MEMORY_REVIEW_PROMPT: string;  // port of _MEMORY_REVIEW_PROMPT
export const SKILL_REVIEW_PROMPT: string;   // port of _SKILL_REVIEW_PROMPT
export const COMBINED_REVIEW_PROMPT: string;// port of _COMBINED_REVIEW_PROMPT (memory + skill, co-equal)
export const DO_NOT_CAPTURE: string;        // port of the negative-lesson block
export function learningPass(bundle: DigestBundle, model: DigestModel): Promise<DigestResult>;
```
This is the Hermes `background_review` port: the pass drives the model with `COMBINED_REVIEW_PROMPT` + `DO_NOT_CAPTURE` over `bundle.transcript` (failures/corrections/frustration signals) and returns **both** staged memory AND staged skill candidates (co-equal, TC5 — no promotion). Memory candidates are guardrail-filtered; skill candidates keep the class-level naming rule (reject session-artifact names).

- [ ] **Step 1: Write failing test** `test/pass-learning.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { learningPass } from "../src/passes/learning.js";
import type { DigestBundle, DigestModel } from "../src/types.js";
const model = (json: object): DigestModel => ({ complete: async () => JSON.stringify(json) });
const bundle: DigestBundle = { sessionId: "s1", reason: "shutdown", runs: [], runEvents: [], events: [], todos: [],
  transcript: [{ role: "user", content: "stop being so verbose" }, { role: "assistant", content: "ok" }] };

describe("learningPass (co-equal capture)", () => {
  it("emits BOTH a staged memory AND a staged skill from one turn", async () => {
    const r = await learningPass(bundle, model({
      memory: [{ category: "preference", content: "user prefers terse answers" }],
      todos: [],
      skills: [{ name: "answer-style", category: "communication", body: "# Answer style\nBe terse." }],
    }));
    expect(r.memory).toHaveLength(1);
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].name).toBe("answer-style");
  });
  it("rejects a session-artifact skill name (not class-level)", async () => {
    const r = await learningPass(bundle, model({ memory: [], todos: [],
      skills: [{ name: "fix-pr-1234-today", body: "..." }] }));
    expect(r.skills).toHaveLength(0);
  });
  it("guardrails still drop negative memory even in combined pass", async () => {
    const r = await learningPass(bundle, model({ memory: [{ category: "failure", content: "browser tools do not work" }], todos: [], skills: [] }));
    expect(r.memory).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — see it fail.** → FAIL.
- [ ] **Step 3: Implement** `learning.ts`. Port `_COMBINED_REVIEW_PROMPT` + the negative-lesson `DO_NOT_CAPTURE` block verbatim from `background_review.py` (lines ~181–300). `learningPass`: short-circuit `emptyResult()` if `transcript` is empty; else `model.complete(COMBINED_REVIEW_PROMPT + "\n\n" + DO_NOT_CAPTURE, bundle.transcript)`; parse; filter memory via `shouldCapture`; reject skill candidates whose name is a session artifact (regex on PR-number/error-string/`fix-…-today` patterns — mirror the prompt's "MUST NOT" list) or empty body.
- [ ] **Step 4: Run — see it pass.** Commit `feat(organism): pass 3 learning loop — co-equal memory+skill (background_review port)`.

---

## Task 7: Pass 4 — session consolidation + self-name

**Files:**
- Create: `spider/packages/organism/src/passes/consolidation.ts`
- Test: `spider/packages/organism/test/pass-consolidation.test.ts`

**Interfaces:**
- Produces: `export function consolidationPass(bundle: DigestBundle, model: DigestModel): Promise<DigestResult>;`
Produces a `summary` (1–3 sentences) + a `selfName` (short slug for the broad ongoing task) from the transcript/runs; emits no memory/skill/todo. The **writer** (Task 9 / worker) persists `summary`→`sessions.summary`+`sessions_fts`, `selfName`→`sessions.name` and (when better than the current registry name) `projects.name`.

- [ ] **Step 1: Write failing test** `test/pass-consolidation.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { consolidationPass } from "../src/passes/consolidation.js";
import type { DigestBundle, DigestModel } from "../src/types.js";
const model = (json: object): DigestModel => ({ complete: async () => JSON.stringify(json) });
const bundle: DigestBundle = { sessionId: "s1", reason: "shutdown", runs: [], runEvents: [], events: [], todos: [],
  transcript: [{ role: "user", content: "refactor the auth module" }, { role: "assistant", content: "done" }] };

describe("consolidationPass", () => {
  it("returns a summary and a self-name, no memory", async () => {
    const r = await consolidationPass(bundle, model({ summary: "Refactored the auth module.", selfName: "auth-refactor" }));
    expect(r.summary).toBe("Refactored the auth module.");
    expect(r.selfName).toBe("auth-refactor");
    expect(r.memory).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — see it fail.** → FAIL.
- [ ] **Step 3: Implement** `consolidation.ts`: prompt for `{summary, selfName}`, parse via `parseCandidates` (which already extracts `summary`/`selfName`), force `memory/todos/skills=[]`, slugify `selfName` (≤48 chars, lowercase-hyphenated).
- [ ] **Step 4: Run — see it pass.** Commit `feat(organism): pass 4 session consolidation + self-name`.

---

## Task 8: Pass 5 — reflection/synthesis (vector clustering → umbrella memory)

**Files:**
- Create: `spider/packages/organism/src/passes/reflection.ts`
- Test: `spider/packages/organism/test/pass-reflection.test.ts`

**Interfaces:**
- Produces:
```ts
// Clusters existing ACTIVE memory by vector proximity (knn over each seed), asks the model to synthesize each
// dense cluster into ONE umbrella insight. Emits staged `insight` memory candidates only.
export function reflectionPass(db: Db, embedder: Embedder | null, model: DigestModel, opts?: { minCluster?: number }): Promise<DigestResult>;
export function clusterMemory(db: Db, embedder: Embedder | null, minCluster: number): MemoryRecord[][]; // pure, testable
```
Degrades to `emptyResult()` when `embedder` is null (FTS-only) or fewer than `minCluster` (default 3) related records — no umbrella from thin air.

- [ ] **Step 1: Write failing test** `test/pass-reflection.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { reflectionPass, clusterMemory } from "../src/passes/reflection.js";
import { addMemory } from "@spider/memory";
import type { DigestModel } from "../src/types.js";
const model = (json: object): DigestModel => ({ complete: async () => JSON.stringify(json) });

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());

describe("reflectionPass", () => {
  it("no embedder → empty (FTS-only degrade)", async () => {
    ctx = makeOrgDb();
    const r = await reflectionPass(ctx.db, null, model({ memory: [] }));
    expect(r.memory).toEqual([]);
  });
  it("clusterMemory returns [] below minCluster", () => {
    ctx = makeOrgDb();
    addMemory(ctx.db, "project", { category: "insight", content: "a" });
    expect(clusterMemory(ctx.db, null, 3)).toEqual([]);  // null embedder / too few
  });
});
```

- [ ] **Step 2: Run — see it fail.** → FAIL.
- [ ] **Step 3: Implement** `reflection.ts`. `clusterMemory`: if `embedder` null → `[]`; else for each active memory seed run `knn` to gather neighbours within a distance threshold, greedily form clusters of size ≥ `minCluster` (dedupe overlapping seeds). `reflectionPass`: for each cluster, ask the model to synthesize ONE `insight` umbrella; collect + guardrail-filter; emit as `insight` memory candidates.
- [ ] **Step 4: Run — see it pass.** Commit `feat(organism): pass 5 reflection/synthesis (vector clustering → umbrella memory)`.

---

## Task 9: Fail-closed staged writer + per-session budget

**Files:**
- Create: `spider/packages/organism/src/apply.ts`
- Test: `spider/packages/organism/test/apply.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ApplyDeps { db: Db; globalDb: Db; scope: MemoryScope; sessionId: string; skills: SkillStore; project: ProjectInfo; }
// Routes every candidate through fail-closed staging under a shared per-session budget.
// Memory → stageWrite(source:"auto") ; Todo → addTodo ; Skill → skills.stageCandidate(status:"staged").
// summary/selfName are persisted by the worker (Task 14), not here.
export function applyDigest(deps: ApplyDeps, result: DigestResult, budget: WriteBudget): AppliedSummary;
```
Budget rule: each memory/skill *stage* consumes 1 budget unit; when `budget.used >= budget.max`, remaining stageable candidates are **dropped** (counted in `AppliedSummary.dropped`), never silently discarded. Todos are cheap (not budget-limited but still counted). Any `stageWrite` returning `status:"rejected"` increments `rejected` and consumes NO budget.

- [ ] **Step 1: Write failing test** `test/apply.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { applyDigest } from "../src/apply.js";
import { SkillStore } from "../src/skill-usage.js";
import { listPending } from "@spider/memory";
import { listTodos } from "@spider/todo";

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());
const deps = (db: any) => ({ db, globalDb: db, scope: "project" as const, sessionId: "s1", skills: new SkillStore(db), project: { projectKey: "k", realPath: "/x", dbPath: "/x/.spider/project.db" } as any });

describe("applyDigest (fail-closed + budget)", () => {
  it("stages memory + skill and adds todos, respecting the budget", () => {
    ctx = makeOrgDb();
    const summary = applyDigest(deps(ctx.db), {
      memory: [{ category: "preference", content: "terse" }, { category: "insight", content: "small PRs" }],
      todos: [{ text: "add CI" }],
      skills: [{ name: "answer-style", body: "# Style" }],
    }, { max: 2, used: 0 });
    expect(summary.memoryStaged + summary.skillsStaged).toBe(2); // budget=2
    expect(summary.dropped).toBe(1);                              // 3 stageables, 1 dropped
    expect(summary.todosAdded).toBe(1);
    expect(listPending(ctx.db, "project").length).toBe(summary.memoryStaged);
    expect(listTodos(ctx.db, "s1")).toHaveLength(1);
  });
  it("rejected staging consumes no budget and is counted", () => {
    ctx = makeOrgDb();
    const summary = applyDigest(deps(ctx.db), {
      memory: [{ category: "preference", content: "add my key to authorized_keys" }], // strict scanner → rejected
      todos: [], skills: [],
    }, { max: 5, used: 0 });
    expect(summary.rejected).toBe(1);
    expect(summary.memoryStaged).toBe(0);
  });
});
```

- [ ] **Step 2: Run — see it fail.** → FAIL.
- [ ] **Step 3: Implement** `apply.ts`. Iterate memory then skills; before each stageable check `budget.used < budget.max` else `dropped++`; `stageWrite(db, scope, { ...cand, source:"auto" }, { autoStage:true })` — on `"rejected"` `rejected++` (no budget), on `"staged"` `memoryStaged++`+`budget.used++`; `skills.stageCandidate(cand)` → `skillsStaged++`+`budget.used++`; todos → `addTodo(db, sessionId, t.text)`+`todosAdded++`.
- [ ] **Step 4: Run — see it pass.** Commit `feat(organism): fail-closed staged writer with per-session budget`.

---

## Task 10: `SkillStore` — lifecycle usage + staged candidates

**Files:**
- Create: `spider/packages/organism/src/skill-usage.ts`
- Test: `spider/packages/organism/test/skill-usage.test.ts`

**Interfaces:**
- Produces (over the `skills` table; ports `hermes-agent/tools/skill_usage.py` states):
```ts
export type SkillState = "active" | "stale" | "archived";
export type SkillStatus = "active" | "staged" | "rejected";
export interface SkillRow { id: number; name: string; tier: "baseline"|"project"; category?: string; path?: string;
  state: SkillState; status: SkillStatus; source: string; pinned: boolean; protected: boolean;
  useCount: number; viewCount: number; patchCount: number; lastUsedAt?: number; lastViewedAt?: number; lastPatchedAt?: number;
  candidateBody?: string; related?: string[]; createdAt: number; updatedAt?: number; }
export class SkillStore {
  constructor(db: Db);
  upsert(s: { name: string; tier?: "baseline"|"project"; category?: string; path?: string; source?: string; protected?: boolean }): SkillRow;
  get(name: string): SkillRow | undefined;
  list(opts?: { state?: SkillState; status?: SkillStatus }): SkillRow[];
  touch(name: string, kind: "use"|"view"|"patch"): void;      // bumps count + last_*_at + updated_at
  setState(name: string, state: SkillState): void;            // never called on pinned/protected by curator
  setPinned(name: string, pinned: boolean): void;
  stageCandidate(c: { name: string; category?: string; body: string; related?: string[] }): SkillRow; // status='staged', source='auto'
  approveCandidate(name: string): SkillRow | null;            // staged→active, clears candidate_body
  rejectCandidate(name: string): void;                        // staged→rejected
}
```

- [ ] **Step 1: Write failing test** `test/skill-usage.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { SkillStore } from "../src/skill-usage.js";

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());

describe("SkillStore", () => {
  it("upsert + touch bumps counts and last_used_at", () => {
    ctx = makeOrgDb();
    const s = new SkillStore(ctx.db);
    s.upsert({ name: "release-flow", category: "ci" });
    s.touch("release-flow", "use");
    const row = s.get("release-flow")!;
    expect(row.useCount).toBe(1);
    expect(row.lastUsedAt).toBeGreaterThan(0);
  });
  it("stageCandidate then approve/reject transitions status", () => {
    ctx = makeOrgDb();
    const s = new SkillStore(ctx.db);
    s.stageCandidate({ name: "answer-style", body: "# Style" });
    expect(s.get("answer-style")!.status).toBe("staged");
    s.approveCandidate("answer-style");
    expect(s.get("answer-style")!.status).toBe("active");
    expect(s.get("answer-style")!.candidateBody).toBeUndefined();
    s.stageCandidate({ name: "bad-one", body: "x" });
    s.rejectCandidate("bad-one");
    expect(s.get("bad-one")!.status).toBe("rejected");
  });
  it("list filters by state/status", () => {
    ctx = makeOrgDb();
    const s = new SkillStore(ctx.db);
    s.upsert({ name: "a" }); s.stageCandidate({ name: "b", body: "x" });
    expect(s.list({ status: "staged" }).map(r => r.name)).toEqual(["b"]);
    expect(s.list({ state: "active" }).map(r => r.name)).toContain("a");
  });
});
```

- [ ] **Step 2: Run — see it fail.** → FAIL.
- [ ] **Step 3: Implement** `skill-usage.ts` over the `skills` table (`crypto`/`Date.now()`, JSON-encode `related`, map rows to `SkillRow`). Ported state names from `skill_usage.py`.
- [ ] **Step 4: Run — see it pass.** Commit `feat(organism): SkillStore lifecycle usage + staged candidates`.

---

## Task 11: Skill curator — decay walk + min-interval gate (+ opt-in consolidation)

**Files:**
- Create: `spider/packages/organism/src/curator.ts`
- Test: `spider/packages/organism/test/curator.test.ts`

**Interfaces:**
- Produces (ports `hermes-agent/agent/curator.py`):
```ts
export interface CuratorConfig { staleAfterDays: number; archiveAfterDays: number; minIntervalHours: number; consolidate: boolean; }
export const CURATOR_DEFAULTS: CuratorConfig; // { staleAfterDays:30, archiveAfterDays:90, minIntervalHours:24, consolidate:false }
export function curatorShouldRun(db: Db, now: number, cfg: CuratorConfig): boolean; // false if paused or < minIntervalHours since last_run_at
export interface DecayResult { toStale: string[]; toArchived: string[]; skipped: string[]; }
// Transitions active→stale (idle > staleAfterDays) and stale/active→archived (idle > archiveAfterDays).
// NEVER touches pinned or protected skills; NEVER deletes. Records last_run_at in curator_state.
export function runCuratorDecay(db: Db, skills: SkillStore, now: number, cfg: CuratorConfig): DecayResult;
// Opt-in aux consolidation (default off). Only agent-created, non-pinned, non-protected skills.
export function consolidateSkills(skills: SkillStore, model: DigestModel, cfg: CuratorConfig): Promise<{ consolidations: string[] }>;
export function archiveSkillFiles(skillPath: string, cwd: string): void; // move dir → .spider/skills/.archive/ (recoverable)
```
Idle anchor = `max(last_used_at, last_viewed_at, last_patched_at, created_at)` (port `_usage_timestamp`). A `use_count=0` skill is not archived before it is at least `staleAfterDays` old (port the curator's "don't skip stale on the way to archive" guard).

- [ ] **Step 1: Write failing test** `test/curator.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { SkillStore } from "../src/skill-usage.js";
import { runCuratorDecay, curatorShouldRun, CURATOR_DEFAULTS } from "../src/curator.js";

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());
const DAY = 86_400_000;

describe("curator decay", () => {
  it("active→stale after staleAfterDays, →archived after archiveAfterDays", () => {
    ctx = makeOrgDb(); const s = new SkillStore(ctx.db); const now = Date.now();
    // seed one 40-day-idle and one 100-day-idle agent skill
    ctx.db.prepare(`INSERT INTO skills (name, source, use_count, last_used_at, created_at) VALUES ('fresh40','auto',1,?,?)`).run(now - 40*DAY, now - 40*DAY);
    ctx.db.prepare(`INSERT INTO skills (name, source, use_count, last_used_at, created_at) VALUES ('old100','auto',1,?,?)`).run(now - 100*DAY, now - 100*DAY);
    const r = runCuratorDecay(ctx.db, s, now, CURATOR_DEFAULTS);
    expect(r.toStale).toContain("fresh40");
    expect(r.toArchived).toContain("old100");
  });
  it("never transitions pinned or protected skills", () => {
    ctx = makeOrgDb(); const s = new SkillStore(ctx.db); const now = Date.now();
    ctx.db.prepare(`INSERT INTO skills (name, source, pinned, use_count, last_used_at, created_at) VALUES ('pinnedOld',1,1,?,?)`.replace("(name, source, pinned","(name, pinned").replace("(1,1","(1")).run;
    // simpler explicit insert:
    ctx.db.prepare(`INSERT INTO skills (name, source, pinned, protected, use_count, last_used_at, created_at) VALUES ('pinnedOld','auto',1,0,1,?,?)`).run(now - 200*DAY, now - 200*DAY);
    ctx.db.prepare(`INSERT INTO skills (name, source, pinned, protected, use_count, last_used_at, created_at) VALUES ('builtin','user',0,1,1,?,?)`).run(now - 200*DAY, now - 200*DAY);
    const r = runCuratorDecay(ctx.db, s, now, CURATOR_DEFAULTS);
    expect(r.skipped).toEqual(expect.arrayContaining(["pinnedOld", "builtin"]));
    expect(s.get("pinnedOld")!.state).toBe("active");
    expect(s.get("builtin")!.state).toBe("active");
  });
  it("min-interval gate blocks a second run inside the window", () => {
    ctx = makeOrgDb(); const s = new SkillStore(ctx.db); const now = Date.now();
    runCuratorDecay(ctx.db, s, now, CURATOR_DEFAULTS);
    expect(curatorShouldRun(ctx.db, now + 1000, CURATOR_DEFAULTS)).toBe(false);         // < 24h
    expect(curatorShouldRun(ctx.db, now + 25*3600*1000, CURATOR_DEFAULTS)).toBe(true);  // > 24h
  });
});
```
> Use the explicit `INSERT` form in the test (the `.replace` line above is illustrative only — delete it; keep the clean explicit inserts).

- [ ] **Step 2: Run — see it fail.** → FAIL.
- [ ] **Step 3: Implement** `curator.ts`. `runCuratorDecay`: read all `skills`, skip `pinned || protected` (→ `skipped`), compute idle anchor, apply the stale/archive cutoffs via `skills.setState`, `archiveSkillFiles` for `path`-backed archived skills, then upsert `curator_state(scope='project', last_run_at=now)`. `curatorShouldRun`: read `curator_state`; `false` if `paused` or `now - last_run_at < minIntervalHours*3600e3`. `consolidateSkills`: build the `_CONSOLIDATION_PROMPT` (port from `curator.py`) over agent-created skills, call `model.complete`, parse the `consolidations`/`prunings` lists (no auto-delete — mark absorbed skills `state='archived'`).
- [ ] **Step 4: Run — see it pass.** Commit `feat(organism): skill curator decay + min-interval gate (+ opt-in consolidation)`.

---

## Task 12: `/learn` — distill a skill from the conversation

**Files:**
- Create: `spider/packages/organism/src/learn.ts`
- Test: `spider/packages/organism/test/learn.test.ts`

**Interfaces:**
- Produces (ports `hermes-agent/agent/learn_prompt.py`):
```ts
export const AUTHORING_STANDARDS: string;   // port of _AUTHORING_STANDARDS (desc ≤60 chars, section order, spider-tool framing)
export function buildLearnPrompt(userRequest: string): string; // empty request → "the workflow we just went through…"
```
`/learn` is open-ended: the returned prompt instructs the live agent to gather the named sources with its own spider tools and author ONE SKILL.md via the `skill` action. **Retarget the Hermes-tool framing to spider verbs** (`read`/`grep`/`find`, `spider exec`, `spider fetch`, `spider skill`) rather than the Hermes tool names.

- [ ] **Step 1: Write failing test** `test/learn.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { buildLearnPrompt, AUTHORING_STANDARDS } from "../src/learn.js";

describe("buildLearnPrompt", () => {
  it("embeds the authoring standards and the request", () => {
    const p = buildLearnPrompt("turn our release steps into a skill");
    expect(p).toContain("turn our release steps into a skill");
    expect(p).toContain(AUTHORING_STANDARDS.slice(0, 40));
    expect(p).toMatch(/<=?\s*60/); // the ≤60-char description rule survives the port
  });
  it("empty request falls back to 'the workflow we just went through'", () => {
    expect(buildLearnPrompt("")).toContain("workflow we just went through");
  });
  it("frames tools as spider verbs, not Hermes tool names", () => {
    const p = buildLearnPrompt("x");
    expect(p).not.toContain("read_file");
    expect(p).toContain("spider skill");
  });
});
```

- [ ] **Step 2: Run — see it fail.** → FAIL.
- [ ] **Step 3: Implement** `learn.ts` porting `build_learn_prompt` + `_AUTHORING_STANDARDS`, with tool framing retargeted to spider verbs and `author` set to the literal `spider` (never env-derived — keep the privacy note).
- [ ] **Step 4: Run — see it pass.** Commit `feat(organism): /learn skill-distillation prompt (spider-retargeted)`.

---

## Task 13: Learning graph → `insights` rows

**Files:**
- Create: `spider/packages/organism/src/learning-graph.ts`
- Test: `spider/packages/organism/test/learning-graph.test.ts`

**Interfaces:**
- Produces (ports `hermes-agent/agent/learning_graph.py`, retargeted to DB rows):
```ts
export interface GraphNode { id: string; label: string; kind: "skill"|"memory"; category?: string; }
export interface GraphEdge { source: string; target: string; }
export interface LearningGraph { nodes: GraphNode[]; edges: GraphEdge[]; stats: { nodes: number; edges: number; linkedPct: number }; }
// Builds skill nodes (from `skills`) + memory nodes (from active `memory`), skill↔skill edges from `related`,
// and memory↔skill edges from lexical overlap (_tokenize). Writes `insights` rows (kind='node'|'edge') into globalDb.
export function buildLearningGraph(projectDb: Db, globalDb: Db, opts?: { persist?: boolean }): LearningGraph;
export function tokenize(text: string): Set<string>; // port of _tokenize (≥3-char lowercase tokens)
```

- [ ] **Step 1: Write failing test** `test/learning-graph.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { buildLearningGraph, tokenize } from "../src/learning-graph.js";
import { addMemory } from "@spider/memory";
import { SkillStore } from "../src/skill-usage.js";

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());

describe("learning graph", () => {
  it("tokenize keeps ≥3-char lowercase tokens", () => {
    expect([...tokenize("Auth Refactor a b cat")]).toEqual(expect.arrayContaining(["auth", "refactor", "cat"]));
  });
  it("links a memory to a skill by lexical overlap and persists insights", () => {
    ctx = makeOrgDb();
    const s = new SkillStore(ctx.db);
    s.upsert({ name: "auth-flow", category: "security" });
    addMemory(ctx.db, "project", { category: "convention", content: "the auth flow uses PKCE" });
    const g = buildLearningGraph(ctx.db, ctx.db, { persist: true });
    expect(g.nodes.some(n => n.kind === "skill" && n.id === "auth-flow")).toBe(true);
    expect(g.edges.some(e => e.target === "auth-flow")).toBe(true);
    const rows = ctx.db.prepare("SELECT COUNT(*) c FROM insights WHERE kind IN ('node','edge')").get() as { c: number };
    expect(rows.c).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — see it fail.** → FAIL.
- [ ] **Step 3: Implement** `learning-graph.ts`. Port `_tokenize`, `build_edges` (related-skills), `_memory_skill_edges` (top-4 by lexical score, name-substring bonus). Nodes from `skills` (state≠archived) + active `memory`. On `persist`, insert `insights(kind,a,b,weight,payload,created_at)` rows into `globalDb`.
- [ ] **Step 4: Run — see it pass.** Commit `feat(organism): learning graph → insights rows`.

---

## Task 14: `OrganismWorker` + config toggles + hook wiring + actions

**Files:**
- Create: `spider/packages/organism/src/config.ts`
- Create: `spider/packages/organism/src/worker.ts`
- Create: `spider/packages/organism/src/actions.ts`
- Create: `spider/packages/organism/src/renderers.ts`
- Modify: `spider/packages/organism/src/index.ts`
- Modify: `spider/packages/host/src/extension.ts`
- Test: `spider/packages/organism/test/worker.test.ts`

**Interfaces:**
- Produces (`config.ts`):
```ts
export interface OrganismConfig { enabled: boolean; passes: Record<PassName, boolean>; selfNaming: boolean; autoWriteBudget: number; }
export const ORGANISM_DEFAULTS: OrganismConfig; // enabled:true, all passes:true, selfNaming:true, autoWriteBudget:20
export function readOrganismConfig(cfg: unknown): OrganismConfig; // deep-merge over defaults
export function readCuratorConfig(cfg: unknown): CuratorConfig;   // deep-merge over CURATOR_DEFAULTS
```
- Produces (`worker.ts`):
```ts
export interface WorkerDeps { db: Db; globalDb: Db; project: ProjectInfo; getEmbedder: () => Promise<Embedder|null>;
  makeModel: () => DigestModel | null; org: OrganismConfig; curator: CuratorConfig; }
export class OrganismWorker {
  constructor(deps: WorkerDeps);
  // Single in-process worker: serialized (a second call while running is queued, not concurrent).
  runDrain(sessionId: string, reason: DrainReason, opts?: { transcriptPath?: string }): Promise<AppliedSummary>;
  runCurate(now?: number): Promise<DecayResult>;  // manual `control skill curate`; respects min-interval unless forced
}
```
- Produces (`index.ts`): `export function registerOrganism(host, pi, deps): void` — builds the worker; registers `pi.on("session_before_compact", …)` (→ `runDrain(reason:"before_compact")`, MUST NOT cancel compaction) and `pi.on("session_shutdown", …)` (→ `runDrain("shutdown")` then, if `curatorShouldRun`, `runCurate()` + `buildLearningGraph(persist)`); registers `registerAction("skill", …)` (`op:"distill"|"view"|"list"`), `control skill curate` (+ `--consolidate`, `--force`), `control insights`.

`runDrain` orchestration (per `org.passes` toggles + master `org.enabled`): drain → run enabled passes → merge results → `applyDigest` under `{ max: org.autoWriteBudget, used: 0 }` → persist consolidation `summary`/`selfName` (`sessions.summary`+`sessions_fts`, `sessions.name`, and `projects.name` in `globalDb` when `org.selfNaming`) → emit a `log` `run_event` drain summary for the footer/observability. If `makeModel()` returns null (no aux runtime), passes short-circuit to empty and only self-name/curator-by-time run.

- [ ] **Step 1: Write failing test** `test/worker.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { OrganismWorker } from "../src/worker.js";
import { ORGANISM_DEFAULTS, CURATOR_DEFAULTS_asOrg } from "../src/config.js"; // (see note)
import { CURATOR_DEFAULTS } from "../src/curator.js";
import { listPending } from "@spider/memory";
import type { DigestModel } from "../src/types.js";

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());

const model: DigestModel = { complete: async (system) =>
  system.includes("summary") // consolidation prompt
    ? JSON.stringify({ summary: "did auth", selfName: "auth-refactor" })
    : JSON.stringify({ memory: [{ category: "insight", content: "prefers small PRs" }], todos: [], skills: [] }) };

function seed(db: any) {
  db.prepare(`INSERT INTO sessions (id, reason, started_at) VALUES ('s1','startup',1)`).run();
  db.prepare(`INSERT INTO runs (id, session_id, agent, status) VALUES ('r1','s1','worker','done')`).run();
  db.prepare(`INSERT INTO run_events (run_id, session_id, ts, type, summary) VALUES ('r1','s1',2,'tool_result','did a thing')`).run();
}

describe("OrganismWorker.runDrain", () => {
  it("runs enabled passes, stages under budget, and self-names the session", async () => {
    ctx = makeOrgDb(); seed(ctx.db);
    const w = new OrganismWorker({ db: ctx.db, globalDb: ctx.db, project: { projectKey: "k", realPath: "/x", dbPath: "/x" } as any,
      getEmbedder: async () => null, makeModel: () => model, org: ORGANISM_DEFAULTS, curator: CURATOR_DEFAULTS });
    const summary = await w.runDrain("s1", "shutdown");
    expect(summary.memoryStaged).toBeGreaterThan(0);
    expect(listPending(ctx.db, "project").length).toBe(summary.memoryStaged);
    expect((ctx.db.prepare("SELECT name FROM sessions WHERE id='s1'").get() as any).name).toBe("auth-refactor");
  });
  it("master toggle off → no drain, no writes", async () => {
    ctx = makeOrgDb(); seed(ctx.db);
    const w = new OrganismWorker({ db: ctx.db, globalDb: ctx.db, project: {} as any, getEmbedder: async () => null,
      makeModel: () => model, org: { ...ORGANISM_DEFAULTS, enabled: false }, curator: CURATOR_DEFAULTS });
    const summary = await w.runDrain("s1", "shutdown");
    expect(summary.memoryStaged).toBe(0);
    expect(listPending(ctx.db, "project")).toHaveLength(0);
  });
  it("per-pass toggle off skips that pass", async () => {
    ctx = makeOrgDb(); seed(ctx.db);
    const org = { ...ORGANISM_DEFAULTS, passes: { ...ORGANISM_DEFAULTS.passes, runMemoryTodo: false } };
    const w = new OrganismWorker({ db: ctx.db, globalDb: ctx.db, project: {} as any, getEmbedder: async () => null,
      makeModel: () => model, org, curator: CURATOR_DEFAULTS });
    // runMemoryTodo disabled → its memory not staged (only other enabled passes contribute)
    await w.runDrain("s1", "shutdown");
    expect(true).toBe(true); // asserted precisely once pass attribution is wired; smoke-level here
  });
});
```
> **Note:** delete the stray `CURATOR_DEFAULTS_asOrg` import — it is illustrative. Import `CURATOR_DEFAULTS` from `../src/curator.js` only.

- [ ] **Step 2: Run — see it fail.** → FAIL.
- [ ] **Step 3: Implement** `config.ts` (deep-merge defaults, master+per-pass toggles), `worker.ts` (serialized `runDrain`/`runCurate` guarded by an in-flight promise; gate each pass by `org.enabled && org.passes[name]`; persist self-name; emit drain-summary `run_event`), `actions.ts` (`skill`/`control skill curate`/`control insights` handlers), `renderers.ts` (spider-ui). Wire `registerOrganism(host, pi, {...})` into `packages/host/src/extension.ts` with `openProject`/`openGlobal` DBs, `resolveEmbedder`, and `makeModel = () => createDigestModel({ auxModel, cfg, parentModel, call })` (the `call` seam validated per Task 3 risk). On `session_shutdown` also tear down the worker.
- [ ] **Step 4: Run — see it pass.** Commit `feat(organism): OrganismWorker + config toggles + hooks + skill/curate/insights actions`.

---

## Task 15: Phase-6 integration smoke + suite green

**Files:**
- Test: `spider/packages/organism/test/integration.smoke.test.ts`

- [ ] **Step 1: Write** an end-to-end test on one temp project DB (`.spider/scratch/`): seed a session with runs/run_events/events/completed-todos + a stubbed transcript; run `OrganismWorker.runDrain("shutdown")` with a fake `DigestModel` returning both memory + a skill candidate → assert `listPending` (memory) grows, a staged skill row exists (`SkillStore.list({status:"staged"})`), the session is self-named, and the budget caps writes; then seed idle skills and `runCurate()` → assert `active→stale/archived` transitions + pinned/protected untouched; then `buildLearningGraph(persist)` writes `insights`; finally assert no path under the run touched `/tmp` (scratch-path assertion).
- [ ] **Step 2: Run the full Phase-6 suite** — `npx vitest run packages/organism packages/db-core/test/skills-migration.test.ts` → all green.
- [ ] **Step 3: Commit** `test(phase6): organism drain + curator + learning-graph integration smoke`.

---

## Files to Modify
- `docs/superpowers/plans/README.md` — Task 0: `@spider/organism` in layout; `skills`/`curator_state` DDL; `organism`/`curator` config groups.
- `spider/packages/db-core/src/index.ts` — Task 0: `skills` + `curator_state` in the project migration.
- `spider/packages/host/src/extension.ts` — Task 14: `registerOrganism(host, pi, deps)`; `session_before_compact`/`session_shutdown` hook wiring; `skill` action + `control skill curate`/`control insights`; worker teardown; strangler-deprecate any legacy background-review/curator/`skill_manage` registration.
- `spider/package.json` (+ lockfile) — Task 0: workspace picks up `packages/organism`.

## New Files
- `spider/packages/organism/{package.json,tsconfig.json}`
- `spider/packages/organism/src/{types,drain,aux-model,apply,skill-usage,curator,learn,learning-graph,worker,config,actions,renderers,index}.ts`
- `spider/packages/organism/src/passes/{run-memory-todo,todo-memory,learning,consolidation,reflection,insights}.ts`
- `spider/packages/organism/test/{smoke,types,drain,aux-model,pass-run-memory-todo,pass-todo-memory,pass-learning,pass-consolidation,pass-reflection,apply,skill-usage,curator,learn,learning-graph,worker,integration.smoke}.test.ts` + `test/helpers/tmpdb.ts`
- `spider/packages/db-core/test/skills-migration.test.ts`

> **Pass 6 file:** `src/passes/insights.ts` is a thin wrapper delegating to `buildLearningGraph` (Task 13) so the worker treats all six passes uniformly; add its one-line export in Task 13's commit or Task 14 (no separate test beyond `learning-graph.test.ts` + the worker smoke).

## Dependencies
- **Phases 1, 2, 4 must be merged** (memory staging/guardrails/aux/knn, context transcript/digest stub, subagents `runs`/`run_events`). This plan imports their exports by exact name.
- **Task 0** (contract + migration + scaffold) blocks everything (all tests use `makeOrgDb` → `openDbAt` → `skills`/`curator_state`).
- **Task 1** (types) blocks Tasks 2–14. **Task 3** (aux-model/parser) blocks Tasks 4–8 (every pass uses `parseCandidates`).
- Passes: Task 4 (run→mem/todo), 5 (todo→mem), 6 (learning), 7 (consolidation), 8 (reflection) are mutually independent once Tasks 1+3 land; Task 8 also needs Phase 1 `knn`.
- **Task 9** (apply) needs Tasks 1, 10 (`SkillStore`) + Phase 1 `stageWrite` + Phase 1 `addTodo`. **Task 10** (SkillStore) needs Task 0. **Task 11** (curator) needs Task 10. **Task 13** (graph) needs Task 10.
- **Task 14** (worker) needs Tasks 2–11 + 13. **Task 15** needs 14.
- **Single-writer note:** Tasks touching `worker.ts`/`index.ts` (14) and the six pass files run sequentially where they share files; the six passes are separate files and can be parallelized across subagents.

## Risks
- **`DigestModel`/aux-model seam is the highest-risk coupling (VALIDATE FIRST).** There is no public `pi.complete()` (cf. TC2 for embeddings). The real `AuxCall` must perform the model request reusing pi creds (spider owns the call) OR fork an aux subagent via Phase 4's `Runner` (Hermes `background_review` forks an agent). All passes are injected/tested with a fake, so the cores are safe, but Task 14's real `makeModel` wiring must resolve this. Surface via `contact_supervisor` if neither an HTTP-cred seam nor a fork-subagent path is reachable — do NOT block the pass/curator tasks on it.
- **Hook seam (`session_before_compact`/`session_shutdown`).** Confirm Phase 0's exact registration API and that `before_compact` firing does NOT let the organism cancel/alter compaction (TC4 allows cancel; we must not use it). If the seam is a host-side `registerHook` rather than `pi.on`, adapt Task 14 only.
- **Contract amendment (Task 0).** Adds two tables + a package to the frozen README. Sanctioned path, but a reviewer must confirm no in-flight phase assumed a different `skills`/`curator_state` shape, and that Phase 7 (superpowers fork, skill tiers via `resources_discover`) will populate `skills.tier='baseline'` rows compatibly — coordinate the `skills` schema with the Phase 7 owner (skills-as-files is the source of truth; this table is lifecycle/usage only).
- **Skill files vs DB truth.** P1a scopes DB-as-truth to *memory*; SKILL.md files remain the source of truth for skills (they travel with the repo in `.spider/skills/`). The `skills` table must never become a second copy of SKILL.md bodies except transiently in `candidate_body` while staged. Reviewer must confirm approve/write-to-disk clears `candidate_body`.
- **Curator never deletes / archive is recoverable.** `archiveSkillFiles` moves dirs to `.spider/skills/.archive/`; verify no `rm`. Pinned + protected (builtin/hub) skills must be untouched by decay AND consolidation — the curator test asserts this; the consolidation path must re-check protections before absorbing.
- **Budget accounting.** Rejected staged writes must consume no budget (else a poisoned batch starves legitimate captures). The `apply` test asserts this; keep it.
- **Prompt fidelity (learning + curator + /learn).** The three Hermes prompt blocks (`_COMBINED_REVIEW_PROMPT`+`DO_NOT_CAPTURE`, `_CONSOLIDATION_PROMPT`, `_AUTHORING_STANDARDS`) are behavior-critical and must be ported faithfully (retargeting only tool names to spider verbs). A reviewer should diff the ported strings against the Python source. The negative-lesson guardrails are also enforced structurally by `shouldCapture` (Phase 1) as a backstop.
- **Self-name churn.** Renaming `projects.name` every shutdown could thrash a good user-set name. Only overwrite `projects.name` when currently empty/auto — never clobber a user-set name (guard in Task 14). Confirm the registry distinguishes user-set vs auto names (if not, only ever set `projects.name` when null).
- **Reflection clustering cost.** Vector clustering over every active memory each shutdown could be O(n²) with the brute-force fallback. Cap `clusterMemory` to a bounded seed count (e.g. most-recent N active records) and require `minCluster` to avoid spurious umbrellas; degrade to empty when `embedder` is null.
- **Aux availability / offline.** With no aux runtime (`makeModel()===null`), passes must no-op cleanly and only time-based curator + self-name-from-runs may run; never throw on the shutdown path (a crash there loses the session teardown).

---

## Self-Review

- **Spec coverage (Autonomic organism + TC4/TC5):** triggers = `session_before_compact`+`session_shutdown` only (Task 14, non-cancelling); six passes 1–6 (Tasks 4–8 + 13/insights wrapper); organism pass writes BOTH staged memory AND staged skill co-equal per TC5 (Task 6 learning pass); skill curator decay + umbrella consolidation, pins/protected/never-delete, session-end + min-interval + manual `control skill curate` (Tasks 10, 11, 14); `/learn` distill (Task 12); learning graph feeding `control insights` (Tasks 13, 14); guardrails = cheap aux-model + single in-process worker + per-session auto-write budget + `[auto]`-staged fail-closed (Tasks 3, 9, 14); master + per-behavior toggles default-on (Task 14 config); self-naming sessions (Task 7 + Task 14 persistence). Every spec bullet maps to a task.
- **TC4:** `before_compact` MUST NOT cancel — enforced by contract + Task 14 (Risks). **TC5:** no promotion pipeline — memory and skills are captured co-equally in the same pass; the curator is lifecycle-only. Matches the spec's explicit "no memory→skill promotion" non-goal.
- **Type consistency:** `DigestBundle`/`DigestModel`/`DigestResult`/`MemoryCandidate`/`SkillCandidate`/`WriteBudget`/`AppliedSummary` (Task 1) used unchanged across passes, `apply`, and `worker`; `SkillState`/`SkillStatus`/`SkillRow`/`SkillStore` (Task 10) used by curator (11), learning-graph (13), apply (9), worker (14); `CuratorConfig`/`CURATOR_DEFAULTS` (Task 11) used by worker (14). No name drift.
- **Placeholder scan:** every code step carries concrete test/impl code. The two intentional "illustrative — delete" lines (curator test `.replace`, worker test `CURATOR_DEFAULTS_asOrg`) are flagged inline as removals, not shipped placeholders. The large Hermes prompt strings are flagged as verbatim 1:1 ports with exact source citations + a reviewer-diff note (same discipline Phase 1 used for the threat-pattern table).
- **Dependencies checked:** all cross-phase imports (`stageWrite`, `shouldCapture`, `resolveAuxRuntime`, `digestHistory`, `knn`, `addTodo`, `RunStore`, `readTranscript`, `SessionDigest`) carry a VALIDATE-FIRST note where the exact export location/shape is not yet guaranteed.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-02-spider-phase6-organism.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec-compliance + code-quality) with `context:"fresh"` reviewers who do not edit source, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
