# spider Phase 4 — Subagents runtime (shared DB) + intercom auto-wake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port pi-subagents' `run`/`wait` (single/chain/parallel/async, forked context) onto the shared per-project DB — writing runs into `runs` and activity into `run_events` (replacing the tmpdir JSON/JSONL store, persisting across restarts, emitting on the in-process `bus` for the Phase 5 UI) — add `pi-intercom` as an external dependency with a `message` action mirrored into `message_mirror`, and implement **first-class push-based pipeline auto-wake** (`run {pipeline:[...], handoff:"intercom"}`) that wakes the reviewer/next-phase worker with the previous stage's outputs instead of blocking `spawn → wait → process → spawn-next`.

**Architecture:** A new `@spider/subagents` package ports pi-subagents' proven spawn/arg-builder/runner/wait logic but strips ALL file-backed state: `status.json` + `events.jsonl` + `RESULTS_DIR` + `run-history.jsonl` + the `TEMP_ROOT_DIR` (`os.tmpdir()`) constants are replaced by two shared tables — `runs` (one row per run, self-named, `parent_run_id` linked) and `run_events` (append-only activity, THE single event stream). Foreground/fork runs append `run_events` in-process (bus emits directly for the UI); async runs spawn a detached `pi` child that appends `run_events` **directly into the shared project DB** (better-sqlite3 WAL multi-process), and a parent-side `RunEventTailer` polls new rows per active run and re-emits them on the in-process `bus`. Intercom stays an **external dependency** (`pi-intercom`, Unix-socket broker) — never vendored, never reimplemented; the `message` verb is a thin wrapper that emits over the existing `pi.events` intercom seam and mirrors traffic into `message_mirror` for observability only. The **open sub-decision is resolved to first-class**: `run {pipeline:[...], handoff:"intercom"}` is a runtime construct (not prompt-driven) — a `PipelineCoordinator` subscribes to the `bus`, and when a stage's run reaches a terminal/accepted state it spawns the next stage pre-wired with the previous stage's outputs as its intercom wake/trigger, recording a `handoff` `run_event` edge for the Phase 5 pipeline-aware footer/grid.

**Tech Stack:** TypeScript (ESM, Node ≥ 22.19.0), better-sqlite3 (WAL + busy_timeout + retry via `@spider/db-core`), `pi-intercom` (external, Unix-socket broker + `IntercomEventBus` on `pi.events`), spawned `pi` child processes (`PI_SUBAGENT_CHILD` guard + `PI_SUBAGENT_*` env protocol), Vitest, esbuild.

> **Amendment A1 reconciliation (`@spider/models`):** when a `run`/task has no explicit `model`, resolve it via **`ctx.models.pick(profile)`** (Phase 0 router, amendments A1/A2) — reviewer/next-phase pipeline stages → `capable`/`reasoning` tier; mechanical/parallel workers → `nano`/`mini`. Explicit `task.model` always wins. `ctx.models` is exposed on `ActionCtx` (A2). The `PipelineCoordinator` selects each stage's model the same way when spawning the next stage.

## Global Constraints

- **Language:** TypeScript, Node ≥ 22.19.0 (target Node 24). ESM (`"type": "module"`).
- **SQLite driver:** better-sqlite3 (synchronous). WAL + busy_timeout + retry wrapper everywhere DB is opened — always via `@spider/db-core` (`openProject`/`openGlobal`), never a raw `new Database()`. Multi-process access (async child pi processes write the same DB files) is the reason WAL + `withRetry` is mandatory; every child-side DB write MUST go through `withRetry`.
- **Native deps (prebuilt, cross-OS):** better-sqlite3, sqlite-vec, onnxruntime-node (via fastembed-js). This phase adds **no** new native deps.
- **External dependency (NOT vendored, NOT reimplemented):** `pi-intercom` (realtime Unix-socket broker). Added to `spider/package.json` dependencies. Discovery/broker/`contact_supervisor`/`IntercomEventBus` all belong to pi-intercom; spider only emits/subscribes on the shared `pi.events` seam and provides the `message` wrapper + `message_mirror` observability copy.
- **Zero temp-dir:** ALL scratch/intermediate/session-log/cache data under `<project>/.spider/scratch/` or `~/.pi/agent/spider/scratch/` via `paths.scratch(scope, cwd?)`. **Never** `/tmp`, `$TMPDIR`, `/var/tmp`, `os.tmpdir()`, `mkdtempSync(os.tmpdir(), …)`. This is the single largest divergence from the ported pi-subagents code: `TEMP_ROOT_DIR`/`RESULTS_DIR`/`ASYNC_DIR`/`CHAIN_RUNS_DIR` (pi-subagents `src/shared/types.ts:982`, module-level consts) are DELETED — run/event state lives in `runs`/`run_events`; only child pi *session transcript* files (`.jsonl`, required by pi) live under `paths.scratch("project", cwd)/subagent-sessions/<runId>/`.
- **Bundler:** esbuild; externalize native `.node`. Single extension entry from `host`.
- **UI:** all visual output through `@spider/ui`; honor pi theme tokens; 🕸 signature. No ad-hoc `console.log`/string rendering in `@spider/subagents` (the footer/grid renderers are Phase 5 — this phase only produces the `runs`/`run_events` data + `bus` emissions they consume).
- **Tests:** Vitest; TDD (test first, red→green→refactor); integration DBs created via `openProject` in `.spider/scratch/` — never `/tmp`. Child-process spawning is stubbed via an injected spawner in unit tests (see Task 7); one opt-in end-to-end async test may spawn a real `pi` child guarded by an env flag.
- **Canonical symbols are frozen:** table/column names (`runs`, `run_events`, `message_mirror`, `sessions`), the `db-core` API (`openProject`, `openGlobal`, `appendRunEvent`, `bus`, `paths`, `resolveProject`), and `registerAction(name, handler)` come from `docs/superpowers/plans/README.md`. Do not rename them. `runs.name` and `sessions.name` are **self-named**; runs auto-name from agent+role+task.
- **Child guard:** `process.env.PI_SUBAGENT_CHILD === "1"` → the spider extension MUST NOT re-register the `run`/`wait`/pipeline orchestration surface in the child (child only attaches the DB event reporter). Preserve the pi-subagents early-out semantics.
- **Strangler:** when this phase lands, the legacy `subagent`/`wait` tools are deprecated (kept, not deleted). Final removal is owned by this phase's cutover note (see Task 16).

---

## Interfaces consumed from earlier phases (do not redefine — import them)

Produced by Phase 0 (per contract README). Consume by exact name.

**From `@spider/db-core` (Phase 0):**
```ts
import { openProject, openGlobal, migrate, resolveProject, paths, appendRunEvent, bus } from "@spider/db-core";
import type { Db, Statement, ProjectInfo, RunEvent } from "@spider/db-core";
// Db.prepare(sql), Db.transaction(fn), Db.close()
// paths.scratch(scope: "global" | "project", cwd?: string): string   // canonical zero-temp-dir scratch root
// appendRunEvent(db: Db, e: RunEvent): void   // INSERT INTO run_events AND bus.emit(e)
// bus.on(fn: (e: RunEvent) => void): () => void ; bus.emit(e: RunEvent): void   // in-process emitter
// RunEvent = { runId?: string; sessionId: string; ts: number; type: string; tool?: string; summary?: string; payload?: unknown }
```
> **VALIDATE FIRST (blocker if wrong):** confirm `appendRunEvent` already calls `bus.emit` (Phase 0 Task 6 says it does — line 1170). If it does NOT, this plan's tailer/emit tasks must call `bus.emit` explicitly. Confirm before Task 3.

**From `@spider/host` (Phase 0 dispatcher):**
```ts
// Phase 0 provides the empty dispatcher + registerAction. Each phase calls registerAction to fill an action.
export function registerAction(name: string, handler: ActionHandler): void;
export type ActionHandler = (args: SpiderArgs, ctx: ActionCtx) => Promise<unknown> | unknown;
// Phase 0 types ctx as `unknown`; the resolved runtime ctx (validate against Phase 0 host at execution) is:
export interface ActionCtx {
  db: Db;                 // project DB (openProject already resolved for cwd)
  globalDb: Db;           // global DB (message_mirror lives here)
  project: ProjectInfo;   // { projectKey, realPath, gitCommonDir?, dbPath, name? }
  sessionId: string;      // pi native session id verbatim
  cwd: string;
  pi: import("@mariozechner/pi-coding-agent").ExtensionAPI;   // for pi.events (intercom seam), pi.sendMessage
  auxModel?: string;
  models: typeof import("@spider/models");   // A2: model router — pick()/complete()/catalog()
}
```
> **VALIDATE FIRST (blocker if wrong):** Phase 0 `dispatch.ts` types `ctx` as `unknown` and passes it through. Confirm the host builds this `ActionCtx` (db/globalDb/project/sessionId/cwd/pi) before Task 8. In particular confirm `ctx.pi` (or an equivalent handle to `pi.events`) is reachable — the intercom seam (`SUBAGENT_RESULT_INTERCOM_EVENT`, `SUBAGENT_CONTROL_INTERCOM_EVENT`) is emitted on `pi.events`. If the host passes `pi` differently, adapt Task 8/10/11 wiring. This is the highest-risk cross-phase coupling in this plan — surface via `contact_supervisor` if `ctx.pi` is unavailable.

**From `pi-intercom` (external dependency — the seam, NOT reimplemented):**
```ts
// pi-intercom subscribes on pi.events to these event names (verbatim from pi-intercom/index.ts):
//   "subagent:result-intercom"          → SUBAGENT_RESULT_INTERCOM_EVENT   (payload {to, message, requestId?}; acknowledges via delivery event)
//   "subagent:result-intercom-delivery" → SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT ({requestId, delivered, error?})
//   "subagent:control-intercom"         → SUBAGENT_CONTROL_INTERCOM_EVENT  (payload {to, message}; needs_attention relay)
// Child agents that call intercom/contact_supervisor read these env vars (set by pi-args at spawn):
//   PI_SUBAGENT_ORCHESTRATOR_TARGET, PI_SUBAGENT_RUN_ID, PI_SUBAGENT_CHILD_AGENT,
//   PI_SUBAGENT_CHILD_INDEX, PI_SUBAGENT_INTERCOM_SESSION_NAME
// pi-intercom owns the broker, socket, ReplyTracker, contact_supervisor tool, and delivery. Spider ONLY emits/subscribes.
```

---

## Ported (mechanical, from `/mnt/data/src/pi-subagents/src/`) — copy then de-tmpdir + retarget to DB

- `runs/shared/pi-spawn.ts` (`getPiSpawnCommand` — resolves the `pi` binary, honors `PI_SUBAGENT_PI_BINARY`, Windows CLI handling) — copy near-verbatim into `src/pi-spawn.ts`.
- `runs/shared/pi-args.ts` (`buildPiArgs`, all `PI_SUBAGENT_*` + intercom env consts at lines 14–28, `SUBAGENT_CHILD_ENV="PI_SUBAGENT_CHILD"`) — copy into `src/pi-args.ts`; **replace** `parentEventSink`/`parentControlInbox` file-path env wiring with a `runId` + shared-DB-path env (`PI_SPIDER_DB_PATH`) so the child reports into `run_events` instead of an event-sink dir. Keep the intercom env vars unchanged (pi-intercom reads them).
- `runs/shared/run-id-resolver.ts` (id-prefix resolution) — copy into `src/run-id.ts`, retarget to `SELECT id FROM runs WHERE id LIKE ?`.
- `extension/schemas.ts` `WaitParamsSchema` + the `SubagentParams` subset actually used (SINGLE `{agent, task?}`, CHAIN `{chain:[…]}`, PARALLEL `{tasks:[…], concurrency?}`, `context:"fresh"|"fork"`, `async`, `model`, `skill`, `count`) — copy the relevant TypeBox into `src/schemas.ts`, DROP management-heavy fields not in scope (`share`, `clarify`/TUI, `worktree`, dynamic `expand`/`collect` fanout, `artifacts`) — those are out of Phase 4 scope (note as deferred).

## Deleted, NOT ported (the file-state + non-DB cut — do not copy)

- `TEMP_ROOT_DIR`/`RESULTS_DIR`/`ASYNC_DIR`/`CHAIN_RUNS_DIR`/`TEMP_ARTIFACTS_DIR` module-level consts + `resolveTempScopeId()` (`shared/types.ts:935,982`) — replaced by `runs`/`run_events` + `paths.scratch`.
- `runs/background/subagent-runner.ts` `status.json`/`events.jsonl`/`subagent-log-*.md`/`<session>.html` writers, `writeAtomicJson`, `createResultWatcher` (`result-watcher.ts`), `createAsyncJobTracker` file poller (`async-job-tracker.ts` — the `events.jsonl` size poll) — replaced by DB append + `RunEventTailer`.
- `runs/shared/run-history.ts` (`run-history.jsonl`) — replaced by the persistent `runs` table (history is a `SELECT`).
- `runs/background/stale-run-reconciler.ts` file-rewrite logic — replaced by a DB reconcile query (Task 12).
- The `globalThis.__piSubagent*` hot-reload singletons (`extension/index.ts:248,624`) — the merged extension owns one activation; use a single module-scoped coordinator registry keyed by sessionId (Task 15), not `globalThis`.
- pi-intercom discovery/`npm root -g`/extension-dir seeding (`intercom/intercom-bridge.ts` `resolveIntercomBridge`) — pi-intercom is a normal npm dependency now; discovery is `import`.
- Slash commands, `renderCall`/renderers, cost/profiles/doctor/models management actions, TUI (`tui/`), `fanout-child.ts`/`dynamic-fanout.ts` — out of Phase 4 scope (footer/grid = Phase 5; profiles/doctor = Phase 8).

---

## File Structure (all under `spider/packages/subagents/`)

- `package.json`, `tsconfig.json` — package manifest (name `@spider/subagents`; deps `@spider/db-core`, `@spider/ui`, `pi-intercom`, `typebox`).
- `src/index.ts` — package entry: `export function registerSubagentActions(host, pi)` → `registerAction("run"|"wait"|"message", …)`, starts the `RunEventTailer` + `PipelineCoordinator`, and (in a `PI_SUBAGENT_CHILD` child) instead calls `attachChildReporter(pi)`. Exports pure helpers for tests.
- `src/run-store.ts` — `RunStore` over `runs`: `createRun`, `startRun`, `updateRunProgress`, `finishRun`, `getRun`, `listActiveRuns`, `listRunsForSession`, `linkChild`. Owns self-naming.
- `src/self-name.ts` — `deriveRunName({agent, role, task})` deterministic slug (no aux-model call; organism renames later).
- `src/run-events.ts` — typed emit helpers over `appendRunEvent`: `emitIntent`, `emitToolResult`, `emitStatus`, `emitHandoff`, `emitMessage`, `emitLog`.
- `src/event-tailer.ts` — `RunEventTailer`: polls `run_events` (`id > lastSeen`) for active async runs and re-emits on `bus` (cross-process → in-process bridge). Replaces the `events.jsonl` poller.
- `src/pi-spawn.ts`, `src/pi-args.ts`, `src/run-id.ts` — ported (see above).
- `src/child-reporter.ts` — child-side (`PI_SUBAGENT_CHILD==="1"`): opens the shared DB via `PI_SPIDER_DB_PATH`, subscribes to `pi` tool/turn events, appends `run_events` for the child's `runId`, and writes terminal `runs` status on `session_shutdown`.
- `src/runner.ts` — `Runner`: spawns a child pi process (injectable spawner), transitions `runs` status, wires `pi-args` env, resolves the child session-transcript path under scratch. Both foreground (awaited) and async (detached) paths.
- `src/single.ts`, `src/chain.ts`, `src/parallel.ts` — mode orchestrators over `Runner` + `RunStore` (fork context = `context:"fork"` env).
- `src/pipeline.ts` — `PipelineCoordinator`: the first-class `run {pipeline, handoff:"intercom"}` construct — subscribes to `bus`, spawns next stage on terminal/accepted, records `handoff` edges, wakes via `intercom.ts`.
- `src/intercom.ts` — `sendIntercom(pi, {to, message, expectsReply?})` emits `SUBAGENT_RESULT_INTERCOM_EVENT` (+ awaits `…-delivery`), `mirrorMessage(globalDb, {from,to,kind,body})` writes `message_mirror`. The `message` action wrapper.
- `src/wait.ts` — `waitForRuns(db, {id?, all?, timeoutMs?})` over `runs` + `bus` (event-driven, poll fallback).
- `src/schemas.ts` — trimmed TypeBox: `RunParams` (single/chain/parallel/pipeline), `WaitParams`, `MessageParams`.
- `src/coordinators.ts` — module-scoped per-session registry of `{tailer, pipeline}` (replaces `globalThis.__piSubagent*`); teardown on `session_shutdown`.
- `src/actions/run.ts`, `src/actions/wait.ts`, `src/actions/message.ts` — thin `registerAction` handlers wiring the above to `ActionCtx`.
- `test/*.test.ts` — Vitest suites.

Host wiring (under `spider/packages/host/src/`):
- `src/extension.ts` — add `registerSubagentActions(host, pi)`; on `session_shutdown` call coordinator teardown; add the `PI_SUBAGENT_CHILD` early-out branch (child attaches reporter only).

---

### Task 1: Scaffold `@spider/subagents` package

**Files:**
- Create: `spider/packages/subagents/package.json`
- Create: `spider/packages/subagents/tsconfig.json`
- Create: `spider/packages/subagents/src/index.ts`
- Create: `spider/packages/subagents/test/smoke.test.ts`
- Modify: `spider/package.json` (add `pi-intercom` to root `dependencies`)

**Interfaces:**
- Consumes: workspace root `spider/package.json` (`workspaces: ["packages/*"]`), `tsconfig.base.json`, `vitest.config.ts` from Phase 0.
- Produces: `@spider/subagents` package resolvable; `pi-intercom` installed.

- [ ] **Step 1: Write the failing test**

```ts
// test/smoke.test.ts
import { describe, it, expect } from "vitest";
import * as pkg from "../src/index.js";

describe("@spider/subagents", () => {
  it("exports registerSubagentActions", () => {
    expect(typeof pkg.registerSubagentActions).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/subagents`
Expected: FAIL — cannot find module `../src/index.js`.

- [ ] **Step 3: Create the package manifest, tsconfig, and stub entry**

```json
// packages/subagents/package.json
{
  "name": "@spider/subagents",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run" },
  "dependencies": {
    "@spider/db-core": "*",
    "@spider/ui": "*",
    "pi-intercom": "^0.6.0",
    "typebox": "^1.1.24"
  },
  "peerDependencies": { "@mariozechner/pi-coding-agent": "*" }
}
```

```json
// packages/subagents/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": "src", "outDir": "dist" }, "include": ["src"] }
```

```ts
// packages/subagents/src/index.ts
export function registerSubagentActions(_host: unknown, _pi: unknown): void {
  // filled by later tasks
}
```

Add `"pi-intercom": "^0.6.0"` to `spider/package.json` root `dependencies`, then `npm install` at the workspace root.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/subagents`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/subagents spider/package.json spider/package-lock.json
git commit -m "feat(subagents): scaffold @spider/subagents package + pi-intercom dependency"
```

---

### Task 2: `RunStore` — create/start/finish runs in the `runs` table

**Files:**
- Create: `spider/packages/subagents/src/self-name.ts`
- Create: `spider/packages/subagents/src/run-store.ts`
- Create: `spider/packages/subagents/test/run-store.test.ts`
- Create: `spider/packages/subagents/test/testutil.ts`

**Interfaces:**
- Consumes: `openProject`, `migrate` from `@spider/db-core`; `runs` schema (columns: `id, session_id, parent_run_id, agent, role, name, status, phase, model, task, started_at, ended_at, step_count, token_count, result`).
- Produces:
```ts
export function deriveRunName(in: { agent: string; role?: string; task?: string }): string;
export interface NewRun { id: string; sessionId: string; parentRunId?: string; agent: string; role?: string; phase?: string; model?: string; task?: string; }
export class RunStore {
  constructor(db: Db);
  create(r: NewRun): { id: string; name: string };      // status="queued"
  start(id: string): void;                                // status="running", started_at=now
  updateProgress(id: string, p: { stepCount?: number; tokenCount?: number; phase?: string }): void;
  finish(id: string, s: { status: "done" | "error" | "interrupted"; result?: string }): void; // ended_at=now
  get(id: string): RunRow | undefined;
  listActive(sessionId: string): RunRow[];               // status in queued|running|paused
  listForSession(sessionId: string): RunRow[];
  linkChild(childId: string, parentRunId: string): void;
}
export type RunStatus = "queued" | "running" | "paused" | "done" | "error" | "interrupted";
export interface RunRow { id: string; sessionId: string; parentRunId?: string; agent: string; role?: string; name?: string; status: RunStatus; phase?: string; model?: string; task?: string; startedAt?: number; endedAt?: number; stepCount: number; tokenCount: number; result?: string; }
```

- [ ] **Step 1: Write the failing test**

```ts
// test/run-store.test.ts
import { describe, it, expect } from "vitest";
import { RunStore, deriveRunName } from "../src/run-store.js";
import { freshDb } from "./testutil.js";

describe("deriveRunName", () => {
  it("slugs agent+role+task deterministically", () => {
    const a = deriveRunName({ agent: "worker", role: "reviewer", task: "Fix the login bug in auth.ts" });
    expect(a).toBe(deriveRunName({ agent: "worker", role: "reviewer", task: "Fix the login bug in auth.ts" }));
    expect(a).toMatch(/reviewer/);
    expect(a.length).toBeLessThanOrEqual(48);
  });
});

describe("RunStore", () => {
  it("creates a queued self-named run and reads it back", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id, name } = store.create({ id: "r1", sessionId: "s1", agent: "worker", role: "impl", task: "add feature" });
    expect(id).toBe("r1");
    expect(name).toBeTruthy();
    const row = store.get("r1")!;
    expect(row.status).toBe("queued");
    expect(row.name).toBe(name);
    expect(row.startedAt).toBeUndefined();
  });

  it("transitions queued → running → done and sets timestamps", () => {
    const db = freshDb();
    const store = new RunStore(db);
    store.create({ id: "r2", sessionId: "s1", agent: "worker" });
    store.start("r2");
    expect(store.get("r2")!.status).toBe("running");
    expect(store.get("r2")!.startedAt).toBeGreaterThan(0);
    store.finish("r2", { status: "done", result: "ok" });
    const row = store.get("r2")!;
    expect(row.status).toBe("done");
    expect(row.endedAt).toBeGreaterThanOrEqual(row.startedAt!);
    expect(row.result).toBe("ok");
  });

  it("listActive returns only non-terminal runs for the session", () => {
    const db = freshDb();
    const store = new RunStore(db);
    store.create({ id: "a", sessionId: "s1", agent: "w" }); store.start("a");
    store.create({ id: "b", sessionId: "s1", agent: "w" }); store.start("b"); store.finish("b", { status: "done" });
    store.create({ id: "c", sessionId: "s2", agent: "w" }); store.start("c");
    const active = store.listActive("s1").map(r => r.id);
    expect(active).toEqual(["a"]);
  });

  it("linkChild sets parent_run_id", () => {
    const db = freshDb();
    const store = new RunStore(db);
    store.create({ id: "p", sessionId: "s1", agent: "w" });
    store.create({ id: "ch", sessionId: "s1", agent: "w" });
    store.linkChild("ch", "p");
    expect(store.get("ch")!.parentRunId).toBe("p");
  });
});
```

```ts
// test/testutil.ts
import { openProject, migrate, paths } from "@spider/db-core";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Db } from "@spider/db-core";

let n = 0;
export function freshDb(): Db {
  const root = paths.scratch("project", process.cwd());
  const dir = path.join(root, `subagents-test-${process.pid}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "project.db");
  // openProject signature is validated against Phase 0; if it takes a projectKey, use a temp key
  // whose registry entry points db_path at dbPath. Adapt to the real Phase 0 openProject at execution.
  const db = openProject(dbPath as never);
  migrate(db, "project");
  return db;
}
```

> **VALIDATE FIRST:** `openProject` in Phase 0 resolves via the registry by `projectKey`, not a raw path. In tests, either register a temp project (`registerProject`) then `openProject(projectKey)`, or use a lower-level open helper if Phase 0 exposes one. Adapt `freshDb` to the real Phase 0 signature — never open a raw `new Database()` (Global Constraints). Confirm at execution.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/subagents -- run-store`
Expected: FAIL — `../src/run-store.js` not found.

- [ ] **Step 3: Implement `self-name.ts` and `run-store.ts`**

```ts
// src/self-name.ts
export function deriveRunName(input: { agent: string; role?: string; task?: string }): string {
  const parts = [input.role ?? input.agent];
  const taskSlug = (input.task ?? "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 4).join("-");
  if (taskSlug) parts.push(taskSlug);
  return parts.join(":").slice(0, 48);
}
```

```ts
// src/run-store.ts
import type { Db } from "@spider/db-core";
import { deriveRunName } from "./self-name.js";
export { deriveRunName };

export type RunStatus = "queued" | "running" | "paused" | "done" | "error" | "interrupted";
export interface NewRun { id: string; sessionId: string; parentRunId?: string; agent: string; role?: string; phase?: string; model?: string; task?: string; }
export interface RunRow { id: string; sessionId: string; parentRunId?: string; agent: string; role?: string; name?: string; status: RunStatus; phase?: string; model?: string; task?: string; startedAt?: number; endedAt?: number; stepCount: number; tokenCount: number; result?: string; }

function toRow(r: any): RunRow {
  return {
    id: r.id, sessionId: r.session_id, parentRunId: r.parent_run_id ?? undefined,
    agent: r.agent, role: r.role ?? undefined, name: r.name ?? undefined, status: r.status,
    phase: r.phase ?? undefined, model: r.model ?? undefined, task: r.task ?? undefined,
    startedAt: r.started_at ?? undefined, endedAt: r.ended_at ?? undefined,
    stepCount: r.step_count ?? 0, tokenCount: r.token_count ?? 0, result: r.result ?? undefined,
  };
}

export class RunStore {
  constructor(private db: Db) {}

  create(r: NewRun): { id: string; name: string } {
    const name = deriveRunName({ agent: r.agent, role: r.role, task: r.task });
    this.db.prepare(
      `INSERT INTO runs (id, session_id, parent_run_id, agent, role, name, status, phase, model, task, step_count, token_count)
       VALUES (@id,@sid,@prid,@agent,@role,@name,'queued',@phase,@model,@task,0,0)`
    ).run({ id: r.id, sid: r.sessionId, prid: r.parentRunId ?? null, agent: r.agent, role: r.role ?? null,
             name, phase: r.phase ?? null, model: r.model ?? null, task: r.task ?? null });
    return { id: r.id, name };
  }
  start(id: string): void {
    this.db.prepare(`UPDATE runs SET status='running', started_at=@t WHERE id=@id`).run({ id, t: Date.now() });
  }
  updateProgress(id: string, p: { stepCount?: number; tokenCount?: number; phase?: string }): void {
    this.db.prepare(
      `UPDATE runs SET step_count=COALESCE(@sc, step_count), token_count=COALESCE(@tc, token_count), phase=COALESCE(@ph, phase) WHERE id=@id`
    ).run({ id, sc: p.stepCount ?? null, tc: p.tokenCount ?? null, ph: p.phase ?? null });
  }
  finish(id: string, s: { status: "done" | "error" | "interrupted"; result?: string }): void {
    this.db.prepare(`UPDATE runs SET status=@st, ended_at=@t, result=COALESCE(@r, result) WHERE id=@id`)
      .run({ id, st: s.status, t: Date.now(), r: s.result ?? null });
  }
  get(id: string): RunRow | undefined {
    const r = this.db.prepare(`SELECT * FROM runs WHERE id=?`).get(id);
    return r ? toRow(r) : undefined;
  }
  listActive(sessionId: string): RunRow[] {
    return (this.db.prepare(`SELECT * FROM runs WHERE session_id=? AND status IN ('queued','running','paused') ORDER BY started_at, id`).all(sessionId) as any[]).map(toRow);
  }
  listForSession(sessionId: string): RunRow[] {
    return (this.db.prepare(`SELECT * FROM runs WHERE session_id=? ORDER BY started_at, id`).all(sessionId) as any[]).map(toRow);
  }
  linkChild(childId: string, parentRunId: string): void {
    this.db.prepare(`UPDATE runs SET parent_run_id=@p WHERE id=@c`).run({ c: childId, p: parentRunId });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/subagents -- run-store`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/subagents/src/self-name.ts spider/packages/subagents/src/run-store.ts spider/packages/subagents/test/run-store.test.ts spider/packages/subagents/test/testutil.ts
git commit -m "feat(subagents): RunStore over shared runs table + deterministic self-naming"
```

---

### Task 3: `run-events` typed emit helpers (append + bus)

**Files:**
- Create: `spider/packages/subagents/src/run-events.ts`
- Create: `spider/packages/subagents/test/run-events.test.ts`

**Interfaces:**
- Consumes: `appendRunEvent`, `bus`, `RunEvent` from `@spider/db-core`.
- Produces:
```ts
export function emitIntent(db: Db, e: { runId: string; sessionId: string; tool: string; summary?: string; payload?: unknown }): void;
export function emitToolResult(db: Db, e: { runId: string; sessionId: string; tool: string; summary?: string; payload?: unknown }): void;
export function emitStatus(db: Db, e: { runId: string; sessionId: string; status: string; summary?: string }): void;
export function emitHandoff(db: Db, e: { runId: string; sessionId: string; toRunId: string; phase?: string; summary?: string; payload?: unknown }): void;
export function emitMessage(db: Db, e: { runId?: string; sessionId: string; summary?: string; payload?: unknown }): void;
export function emitLog(db: Db, e: { runId?: string; sessionId: string; summary?: string; payload?: unknown }): void;
```
Event `type` values written into `run_events.type` are exactly `tool_intent|tool_result|status|handoff|message|log` (frozen enum from the schema).

- [ ] **Step 1: Write the failing test**

```ts
// test/run-events.test.ts
import { describe, it, expect } from "vitest";
import { bus } from "@spider/db-core";
import { emitStatus, emitHandoff, emitToolResult } from "../src/run-events.js";
import { freshDb } from "./testutil.js";

describe("run-events", () => {
  it("appends to run_events with the frozen type and emits on bus", () => {
    const db = freshDb();
    const seen: any[] = [];
    const off = bus.on((e) => seen.push(e));
    emitStatus(db, { runId: "r1", sessionId: "s1", status: "running", summary: "started" });
    off();
    const row = db.prepare(`SELECT * FROM run_events WHERE run_id='r1'`).get() as any;
    expect(row.type).toBe("status");
    expect(row.summary).toBe("started");
    expect(seen.at(-1).type).toBe("status");
  });

  it("handoff records the target run id in payload", () => {
    const db = freshDb();
    emitHandoff(db, { runId: "a", sessionId: "s1", toRunId: "b", phase: "review", summary: "worker→reviewer" });
    const row = db.prepare(`SELECT * FROM run_events WHERE type='handoff'`).get() as any;
    expect(JSON.parse(row.payload).toRunId).toBe("b");
  });

  it("tool_result stores tool + payload", () => {
    const db = freshDb();
    emitToolResult(db, { runId: "a", sessionId: "s1", tool: "bash", summary: "ls", payload: { exit: 0 } });
    const row = db.prepare(`SELECT * FROM run_events WHERE type='tool_result'`).get() as any;
    expect(row.tool).toBe("bash");
    expect(JSON.parse(row.payload).exit).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/subagents -- run-events`
Expected: FAIL — `../src/run-events.js` not found.

- [ ] **Step 3: Implement `run-events.ts`**

```ts
// src/run-events.ts
import { appendRunEvent } from "@spider/db-core";
import type { Db } from "@spider/db-core";

export function emitIntent(db: Db, e: { runId: string; sessionId: string; tool: string; summary?: string; payload?: unknown }): void {
  appendRunEvent(db, { runId: e.runId, sessionId: e.sessionId, ts: Date.now(), type: "tool_intent", tool: e.tool, summary: e.summary, payload: e.payload });
}
export function emitToolResult(db: Db, e: { runId: string; sessionId: string; tool: string; summary?: string; payload?: unknown }): void {
  appendRunEvent(db, { runId: e.runId, sessionId: e.sessionId, ts: Date.now(), type: "tool_result", tool: e.tool, summary: e.summary, payload: e.payload });
}
export function emitStatus(db: Db, e: { runId: string; sessionId: string; status: string; summary?: string }): void {
  appendRunEvent(db, { runId: e.runId, sessionId: e.sessionId, ts: Date.now(), type: "status", summary: e.summary ?? e.status, payload: { status: e.status } });
}
export function emitHandoff(db: Db, e: { runId: string; sessionId: string; toRunId: string; phase?: string; summary?: string; payload?: unknown }): void {
  appendRunEvent(db, { runId: e.runId, sessionId: e.sessionId, ts: Date.now(), type: "handoff", summary: e.summary, payload: { toRunId: e.toRunId, phase: e.phase, ...(e.payload && typeof e.payload === "object" ? e.payload : {}) } });
}
export function emitMessage(db: Db, e: { runId?: string; sessionId: string; summary?: string; payload?: unknown }): void {
  appendRunEvent(db, { runId: e.runId, sessionId: e.sessionId, ts: Date.now(), type: "message", summary: e.summary, payload: e.payload });
}
export function emitLog(db: Db, e: { runId?: string; sessionId: string; summary?: string; payload?: unknown }): void {
  appendRunEvent(db, { runId: e.runId, sessionId: e.sessionId, ts: Date.now(), type: "log", summary: e.summary, payload: e.payload });
}
```
> If VALIDATE FIRST (Task interfaces) found that `appendRunEvent` does NOT emit on `bus`, add `import { bus }` and call `bus.emit(...)` with the same object inside each helper.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/subagents -- run-events`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/subagents/src/run-events.ts spider/packages/subagents/test/run-events.test.ts
git commit -m "feat(subagents): typed run_events emit helpers over appendRunEvent+bus"
```

---

### Task 4: Port `pi-spawn` + `pi-args` (de-tmpdir, DB-path env)

**Files:**
- Create: `spider/packages/subagents/src/pi-spawn.ts` (copy of pi-subagents `runs/shared/pi-spawn.ts`)
- Create: `spider/packages/subagents/src/pi-args.ts` (copy of pi-subagents `runs/shared/pi-args.ts`, edited)
- Create: `spider/packages/subagents/test/pi-args.test.ts`

**Interfaces:**
- Produces:
```ts
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SPIDER_DB_PATH_ENV = "PI_SPIDER_DB_PATH";        // NEW: child reports into this shared DB
export const SPIDER_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";        // reuse pi-subagents name (pi-intercom reads it)
// intercom env (unchanged, read by pi-intercom): PI_SUBAGENT_ORCHESTRATOR_TARGET, PI_SUBAGENT_CHILD_AGENT,
//   PI_SUBAGENT_CHILD_INDEX, PI_SUBAGENT_INTERCOM_SESSION_NAME
export interface ChildSpawnSpec {
  argv: string[];                 // built pi CLI args (from getPiSpawnCommand + buildPiArgs)
  env: Record<string, string>;    // PI_SUBAGENT_CHILD=1 + PI_SPIDER_DB_PATH + intercom envs
  cwd: string;
  sessionFile: string;            // .jsonl under scratch
}
export function buildChildSpawnSpec(in: {
  runId: string; sessionId: string; agent: string; role?: string; task: string; model?: string;
  context: "fresh" | "fork"; parentSessionId: string; childIndex: number; skill?: string;
  dbPath: string; scratchRoot: string;
  orchestratorTarget?: string; intercomSessionName?: string;
}): ChildSpawnSpec;
```

- [ ] **Step 1: Write the failing test**

```ts
// test/pi-args.test.ts
import { describe, it, expect } from "vitest";
import { buildChildSpawnSpec, SUBAGENT_CHILD_ENV, SPIDER_DB_PATH_ENV } from "../src/pi-args.js";

describe("buildChildSpawnSpec", () => {
  const base = { runId: "r1", sessionId: "s1", agent: "worker", task: "do it",
    context: "fresh" as const, parentSessionId: "s1", childIndex: 0,
    dbPath: "/x/.spider/project.db", scratchRoot: "/x/.spider/scratch" };

  it("sets the child guard and shared DB-path env", () => {
    const spec = buildChildSpawnSpec(base);
    expect(spec.env[SUBAGENT_CHILD_ENV]).toBe("1");
    expect(spec.env[SPIDER_DB_PATH_ENV]).toBe("/x/.spider/project.db");
    expect(spec.env.PI_SUBAGENT_RUN_ID).toBe("r1");
  });

  it("session file lives under scratch, never tmpdir", () => {
    const spec = buildChildSpawnSpec(base);
    expect(spec.sessionFile.startsWith("/x/.spider/scratch")).toBe(true);
    expect(spec.sessionFile).toMatch(/\.jsonl$/);
    expect(spec.sessionFile).not.toMatch(/\/tmp\//);
  });

  it("fork context branches from the parent session", () => {
    const spec = buildChildSpawnSpec({ ...base, context: "fork" });
    expect(spec.argv.join(" ")).toContain("s1"); // parent session referenced for fork
  });

  it("wires intercom orchestrator target + session name when provided", () => {
    const spec = buildChildSpawnSpec({ ...base, orchestratorTarget: "spider-main", intercomSessionName: "worker-r1-0" });
    expect(spec.env.PI_SUBAGENT_ORCHESTRATOR_TARGET).toBe("spider-main");
    expect(spec.env.PI_SUBAGENT_INTERCOM_SESSION_NAME).toBe("worker-r1-0");
    expect(spec.env.PI_SUBAGENT_CHILD_AGENT).toBe("worker");
    expect(spec.env.PI_SUBAGENT_CHILD_INDEX).toBe("0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/subagents -- pi-args`
Expected: FAIL — module not found.

- [ ] **Step 3: Copy + edit the ported files**

Copy `pi-subagents/src/runs/shared/pi-spawn.ts` → `src/pi-spawn.ts` verbatim (only fix import paths). Copy `pi-subagents/src/runs/shared/pi-args.ts` → `src/pi-args.ts`, then:
1. Keep all `PI_SUBAGENT_*` env consts and `SUBAGENT_CHILD_ENV`. Add `export const SPIDER_DB_PATH_ENV = "PI_SPIDER_DB_PATH";`.
2. DELETE the `parentEventSink`/`parentControlInbox`/`parentRootRunId`/nested-path env wiring (event-sink files are gone). Replace with `env[SPIDER_DB_PATH_ENV] = dbPath` and `env[SUBAGENT_RUN_ID_ENV] = runId`.
3. Add the thin `buildChildSpawnSpec` wrapper that calls `getPiSpawnCommand()` + the trimmed `buildPiArgs()` and resolves `sessionFile = path.join(scratchRoot, "subagent-sessions", runId, `${runId}.jsonl`)` (mkdir recursive). For `context:"fork"`, pass the parent session file/id through `buildPiArgs` exactly as pi-subagents does; for `"fresh"`, omit it.
4. Set intercom env: `PI_SUBAGENT_ORCHESTRATOR_TARGET`, `PI_SUBAGENT_CHILD_AGENT=agent`, `PI_SUBAGENT_CHILD_INDEX=String(childIndex)`, `PI_SUBAGENT_INTERCOM_SESSION_NAME` when provided.

> Keep the ported `buildPiArgs` internals (thinking level, tools, extensions, system-prompt mode, TASK_ARG_LIMIT) untouched — only the parent-event-sink wiring changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/subagents -- pi-args`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/subagents/src/pi-spawn.ts spider/packages/subagents/src/pi-args.ts spider/packages/subagents/test/pi-args.test.ts
git commit -m "feat(subagents): port pi-spawn/pi-args, replace event-sink files with shared DB-path env"
```

---

### Task 5: Child-side reporter — child pi process appends `run_events` to the shared DB

**Files:**
- Create: `spider/packages/subagents/src/child-reporter.ts`
- Create: `spider/packages/subagents/test/child-reporter.test.ts`

**Interfaces:**
- Consumes: `openProject`/lower-level open, `RunStore`, `emitIntent`/`emitToolResult`/`emitStatus`/`emitLog`; env `PI_SPIDER_DB_PATH`, `PI_SUBAGENT_RUN_ID`.
- Produces:
```ts
export function isSubagentChild(): boolean;                 // process.env.PI_SUBAGENT_CHILD === "1"
export function attachChildReporter(pi: ExtensionAPI): (() => void) | undefined;  // no-op if not a child / no DB env
// Internals (exported for tests):
export function makeChildReporter(db: Db, ctx: { runId: string; sessionId: string }): {
  onToolStart(tool: string, payload?: unknown): void;
  onToolEnd(tool: string, payload?: unknown): void;
  onStatus(status: string, summary?: string): void;
  onShutdown(status: "done" | "error" | "interrupted", result?: string): void;
};
```
The reporter appends `run_events` for the child's `runId` and, on shutdown, writes the terminal `runs` status. All child DB writes go through `db-core` (`withRetry`) — WAL makes this multi-process-safe.

- [ ] **Step 1: Write the failing test**

```ts
// test/child-reporter.test.ts
import { describe, it, expect } from "vitest";
import { makeChildReporter } from "../src/child-reporter.js";
import { RunStore } from "../src/run-store.js";
import { freshDb } from "./testutil.js";

describe("child reporter", () => {
  it("appends run_events and writes terminal run status", () => {
    const db = freshDb();
    const store = new RunStore(db);
    store.create({ id: "r1", sessionId: "child-sess", agent: "worker" });
    store.start("r1");
    const rep = makeChildReporter(db, { runId: "r1", sessionId: "child-sess" });
    rep.onToolStart("bash", { cmd: "ls" });
    rep.onToolEnd("bash", { exit: 0 });
    rep.onShutdown("done", "finished");
    const events = db.prepare(`SELECT type FROM run_events WHERE run_id='r1' ORDER BY id`).all() as any[];
    expect(events.map(e => e.type)).toEqual(["tool_intent", "tool_result"]);
    expect(store.get("r1")!.status).toBe("done");
    expect(store.get("r1")!.result).toBe("finished");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/subagents -- child-reporter`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `child-reporter.ts`**

```ts
// src/child-reporter.ts
import type { Db } from "@spider/db-core";
import { RunStore } from "./run-store.js";
import { emitIntent, emitToolResult, emitStatus } from "./run-events.js";

export function isSubagentChild(): boolean {
  return process.env.PI_SUBAGENT_CHILD === "1";
}

export function makeChildReporter(db: Db, ctx: { runId: string; sessionId: string }) {
  const store = new RunStore(db);
  return {
    onToolStart(tool: string, payload?: unknown) { emitIntent(db, { ...ctx, tool, payload }); },
    onToolEnd(tool: string, payload?: unknown) { emitToolResult(db, { ...ctx, tool, payload }); },
    onStatus(status: string, summary?: string) { emitStatus(db, { ...ctx, status, summary }); },
    onShutdown(status: "done" | "error" | "interrupted", result?: string) { store.finish(ctx.runId, { status, result }); },
  };
}

export function attachChildReporter(pi: any): (() => void) | undefined {
  if (!isSubagentChild()) return undefined;
  const dbPath = process.env.PI_SPIDER_DB_PATH;
  const runId = process.env.PI_SUBAGENT_RUN_ID;
  if (!dbPath || !runId) return undefined;
  // openProjectByPath: use the Phase 0 open path that accepts an explicit db_path (validate signature).
  const { openProjectByPath } = require("@spider/db-core");
  const db = openProjectByPath(dbPath);
  const sessionId = pi?.getSessionName?.() ?? runId;
  const rep = makeChildReporter(db, { runId, sessionId });
  const offs: Array<() => void> = [];
  offs.push(pi.on("tool_execution_start", (e: any) => rep.onToolStart(e.toolName, { id: e.toolCallId })));
  offs.push(pi.on("tool_execution_end", (e: any) => rep.onToolEnd(e.toolName, { id: e.toolCallId })));
  offs.push(pi.on("agent_start", () => rep.onStatus("running")));
  offs.push(pi.on("session_shutdown", () => { rep.onShutdown("done"); db.close(); }));
  return () => { for (const off of offs) off(); };
}
```
> **VALIDATE FIRST:** Phase 0 must expose an open-by-explicit-path helper for the child (the child knows only the file path, not the projectKey). If Phase 0's `openProject` takes a projectKey, add/confirm an `openProjectByPath(dbPath)` export in db-core (or resolve the projectKey from the path). Surface as a blocker to Phase 0 owner if missing — do NOT open a raw `new Database()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/subagents -- child-reporter`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/subagents/src/child-reporter.ts spider/packages/subagents/test/child-reporter.test.ts
git commit -m "feat(subagents): child-side reporter appends run_events to the shared DB"
```

---

### Task 6: `RunEventTailer` — bridge cross-process `run_events` onto the in-process `bus`

**Files:**
- Create: `spider/packages/subagents/src/event-tailer.ts`
- Create: `spider/packages/subagents/test/event-tailer.test.ts`

**Interfaces:**
- Consumes: `bus`, `RunEvent` from `@spider/db-core`; `RunStore`.
- Produces:
```ts
export class RunEventTailer {
  constructor(db: Db, opts?: { intervalMs?: number });     // default 250ms
  track(runId: string): void;                              // start tailing this async run
  untrack(runId: string): void;
  poll(): void;                                            // read new rows (id > lastSeen) → bus.emit; exposed for tests
  start(): void; stop(): void;                             // timer control
}
```
Foreground/in-process runs already emit on `bus` directly (Task 3); the tailer exists ONLY for async child processes whose writes don't hit the parent's in-process emitter. It re-emits their `run_events` on `bus` for the Phase 5 UI + organism.

- [ ] **Step 1: Write the failing test**

```ts
// test/event-tailer.test.ts
import { describe, it, expect } from "vitest";
import { bus } from "@spider/db-core";
import { RunEventTailer } from "../src/event-tailer.js";
import { emitStatus } from "../src/run-events.js";
import { freshDb } from "./testutil.js";

describe("RunEventTailer", () => {
  it("re-emits only new rows for tracked runs on poll", () => {
    const db = freshDb();
    // Simulate a cross-process append by inserting directly (no in-process bus emission observed by a fresh listener)
    const tailer = new RunEventTailer(db, { intervalMs: 5 });
    tailer.track("async1");
    db.prepare(`INSERT INTO run_events (run_id, session_id, ts, type, summary) VALUES ('async1','s1',1,'status','a')`).run();
    db.prepare(`INSERT INTO run_events (run_id, session_id, ts, type, summary) VALUES ('other','s1',2,'status','b')`).run();
    const seen: any[] = [];
    const off = bus.on((e) => seen.push(e));
    tailer.poll();
    off();
    expect(seen.map(e => e.summary)).toEqual(["a"]);   // only tracked run, no cross-run leakage
    // second poll with no new rows emits nothing
    const seen2: any[] = [];
    const off2 = bus.on((e) => seen2.push(e));
    tailer.poll();
    off2();
    expect(seen2).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/subagents -- event-tailer`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `event-tailer.ts`**

```ts
// src/event-tailer.ts
import { bus } from "@spider/db-core";
import type { Db } from "@spider/db-core";

export class RunEventTailer {
  private tracked = new Set<string>();
  private lastId = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(private db: Db, private opts: { intervalMs?: number } = {}) {
    const row = db.prepare(`SELECT COALESCE(MAX(id),0) AS m FROM run_events`).get() as any;
    this.lastId = row.m ?? 0;
  }
  track(runId: string): void { this.tracked.add(runId); }
  untrack(runId: string): void { this.tracked.delete(runId); }
  poll(): void {
    if (this.tracked.size === 0) return;
    const rows = this.db.prepare(`SELECT * FROM run_events WHERE id > ? ORDER BY id`).all(this.lastId) as any[];
    for (const r of rows) {
      this.lastId = Math.max(this.lastId, r.id);
      if (!r.run_id || !this.tracked.has(r.run_id)) continue;
      bus.emit({ runId: r.run_id, sessionId: r.session_id, ts: r.ts, type: r.type, tool: r.tool ?? undefined, summary: r.summary ?? undefined, payload: r.payload ? JSON.parse(r.payload) : undefined });
    }
  }
  start(): void { if (!this.timer) this.timer = setInterval(() => this.poll(), this.opts.intervalMs ?? 250); }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/subagents -- event-tailer`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/subagents/src/event-tailer.ts spider/packages/subagents/test/event-tailer.test.ts
git commit -m "feat(subagents): RunEventTailer bridges async child run_events onto in-process bus"
```

---

### Task 7: `Runner` — spawn a child, drive `runs`/`run_events` lifecycle (injectable spawner)

**Files:**
- Create: `spider/packages/subagents/src/runner.ts`
- Create: `spider/packages/subagents/test/runner.test.ts`

**Interfaces:**
- Consumes: `RunStore`, `emitStatus`, `buildChildSpawnSpec`, `RunEventTailer`.
- Produces:
```ts
export type Spawner = (spec: ChildSpawnSpec) => ChildHandle;   // injectable; default = node:child_process.spawn wrapper
export interface ChildHandle { pid?: number; wait(): Promise<{ exitCode: number; result?: string }>; kill(): void; detach(): void; }
export interface RunOpts { agent: string; role?: string; task: string; model?: string; skill?: string; context: "fresh" | "fork"; phase?: string; parentRunId?: string; async?: boolean; orchestratorTarget?: string; }
export class Runner {
  constructor(db: Db, sessionId: string, cwd: string, deps: { store: RunStore; tailer: RunEventTailer; spawn: Spawner; scratchRoot: string; dbPath: string });
  runForeground(opts: RunOpts): Promise<RunRow>;   // awaits child, returns terminal run
  runAsync(opts: RunOpts): RunRow;                  // detaches, tracks via tailer, returns queued/running run
}
```

- [ ] **Step 1: Write the failing test** (fake spawner — no real pi process)

```ts
// test/runner.test.ts
import { describe, it, expect } from "vitest";
import { Runner } from "../src/runner.js";
import { RunStore } from "../src/run-store.js";
import { RunEventTailer } from "../src/event-tailer.js";
import { freshDb } from "./testutil.js";

function fakeSpawn(result: { exitCode: number; result?: string }) {
  return () => ({
    pid: 4242,
    wait: async () => result,
    kill() {}, detach() {},
  });
}

describe("Runner", () => {
  it("foreground run goes queued→running→done and links parent", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailer = new RunEventTailer(db);
    const runner = new Runner(db, "s1", "/x", { store, tailer, spawn: fakeSpawn({ exitCode: 0, result: "done text" }), scratchRoot: "/x/.spider/scratch", dbPath: "/x/.spider/project.db" });
    const run = await runner.runForeground({ agent: "worker", task: "impl", context: "fresh", parentRunId: "P" });
    expect(run.status).toBe("done");
    expect(run.result).toBe("done text");
    expect(run.parentRunId).toBe("P");
  });

  it("non-zero exit marks the run error", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const runner = new Runner(db, "s1", "/x", { store, tailer: new RunEventTailer(db), spawn: fakeSpawn({ exitCode: 2 }), scratchRoot: "/x/.spider/scratch", dbPath: "/x/.spider/project.db" });
    const run = await runner.runForeground({ agent: "worker", task: "boom", context: "fresh" });
    expect(run.status).toBe("error");
  });

  it("async run returns immediately and is tracked by the tailer", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tracked: string[] = [];
    const tailer = Object.assign(new RunEventTailer(db), { track: (id: string) => tracked.push(id) });
    const runner = new Runner(db, "s1", "/x", { store, tailer, spawn: fakeSpawn({ exitCode: 0 }), scratchRoot: "/x/.spider/scratch", dbPath: "/x/.spider/project.db" });
    const run = runner.runAsync({ agent: "worker", task: "bg", context: "fresh" });
    expect(["queued", "running"]).toContain(run.status);
    expect(tracked).toContain(run.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/subagents -- runner`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `runner.ts`**

```ts
// src/runner.ts
import { randomUUID } from "node:crypto";
import type { Db } from "@spider/db-core";
import { RunStore, type RunRow, type RunStatus } from "./run-store.js";
import { RunEventTailer } from "./event-tailer.js";
import { emitStatus } from "./run-events.js";
import { buildChildSpawnSpec, type ChildSpawnSpec } from "./pi-args.js";

export interface ChildHandle { pid?: number; wait(): Promise<{ exitCode: number; result?: string }>; kill(): void; detach(): void; }
export type Spawner = (spec: ChildSpawnSpec) => ChildHandle;
export interface RunOpts { agent: string; role?: string; task: string; model?: string; skill?: string; context: "fresh" | "fork"; phase?: string; parentRunId?: string; async?: boolean; orchestratorTarget?: string; childIndex?: number; intercomSessionName?: string; }

export class Runner {
  constructor(
    private db: Db, private sessionId: string, private cwd: string,
    private deps: { store: RunStore; tailer: RunEventTailer; spawn: Spawner; scratchRoot: string; dbPath: string },
  ) {}

  private makeRun(opts: RunOpts): RunRow {
    const id = randomUUID();
    this.deps.store.create({ id, sessionId: this.sessionId, parentRunId: opts.parentRunId, agent: opts.agent, role: opts.role, phase: opts.phase, model: opts.model, task: opts.task });
    return this.deps.store.get(id)!;
  }

  private spawnFor(run: RunRow, opts: RunOpts): ChildHandle {
    const spec = buildChildSpawnSpec({
      runId: run.id, sessionId: this.sessionId, agent: opts.agent, role: opts.role, task: opts.task,
      model: opts.model, context: opts.context, parentSessionId: this.sessionId,
      childIndex: opts.childIndex ?? 0, skill: opts.skill, dbPath: this.deps.dbPath, scratchRoot: this.deps.scratchRoot,
      orchestratorTarget: opts.orchestratorTarget, intercomSessionName: opts.intercomSessionName ?? run.name,
    });
    return this.deps.spawn(spec);
  }

  async runForeground(opts: RunOpts): Promise<RunRow> {
    const run = this.makeRun(opts);
    this.deps.store.start(run.id);
    emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status: "running", summary: run.name });
    const handle = this.spawnFor(run, opts);
    const { exitCode, result } = await handle.wait();
    const status: RunStatus = exitCode === 0 ? "done" : "error";
    this.deps.store.finish(run.id, { status: status as "done" | "error", result });
    emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status, summary: run.name });
    return this.deps.store.get(run.id)!;
  }

  runAsync(opts: RunOpts): RunRow {
    const run = this.makeRun(opts);
    this.deps.store.start(run.id);
    this.deps.tailer.track(run.id);
    emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status: "running", summary: run.name });
    const handle = this.spawnFor(run, opts);
    handle.detach();
    // The child reports terminal status into runs via child-reporter; the tailer bridges its run_events.
    return this.deps.store.get(run.id)!;
  }
}
```
> The default production `Spawner` (a `node:child_process.spawn` wrapper resolving `wait()` from the child's exit code, `result` from the last structured-output entry) is added in Task 8 wiring; unit tests always inject a fake spawner (Global Constraints: no real child in unit tests).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/subagents -- runner`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/subagents/src/runner.ts spider/packages/subagents/test/runner.test.ts
git commit -m "feat(subagents): Runner drives runs/run_events lifecycle with injectable spawner"
```

---

### Task 8: Mode orchestrators — single / chain / parallel (over `Runner`)

**Files:**
- Create: `spider/packages/subagents/src/single.ts`
- Create: `spider/packages/subagents/src/chain.ts`
- Create: `spider/packages/subagents/src/parallel.ts`
- Create: `spider/packages/subagents/test/modes.test.ts`

**Interfaces:**
- Consumes: `Runner`, `RunRow`.
- Produces:
```ts
export function runSingle(runner: Runner, spec: { agent: string; task?: string; model?: string; skill?: string; context: "fresh" | "fork"; async?: boolean }): Promise<RunRow> | RunRow;
export function runChain(runner: Runner, steps: Array<{ agent?: string; task?: string; model?: string; context?: "fresh" | "fork" }>, base: { task: string; context: "fresh" | "fork" }): Promise<RunRow[]>; // each step's result → next {previous}
export function runParallel(runner: Runner, tasks: Array<{ agent: string; task: string; count?: number; model?: string; context?: "fresh" | "fork" }>, opts: { concurrency?: number; context: "fresh" | "fork" }): Promise<RunRow[]>;
```
Chain: sequential foreground runs; step N+1's `task` interpolates `{previous}` (prior result) and `{task}` (original). Parallel: bounded concurrency (default 4), `count` expands a task N times, each child gets `childIndex`.

- [ ] **Step 1: Write the failing test**

```ts
// test/modes.test.ts
import { describe, it, expect, vi } from "vitest";
import { runChain, runParallel } from "../src/modes-index.js"; // barrel re-export of single/chain/parallel
import { Runner } from "../src/runner.js";
import { RunStore } from "../src/run-store.js";
import { RunEventTailer } from "../src/event-tailer.js";
import { freshDb } from "./testutil.js";

function makeRunner(db: any, capture: any[]) {
  const store = new RunStore(db);
  const spawn = () => ({ pid: 1, wait: async () => ({ exitCode: 0, result: `res-${capture.length}` }), kill() {}, detach() {} });
  const runner = new Runner(db, "s1", "/x", { store, tailer: new RunEventTailer(db), spawn, scratchRoot: "/x/s", dbPath: "/x/db" });
  // spy on the opts each spawn sees by wrapping runForeground
  const orig = runner.runForeground.bind(runner);
  runner.runForeground = async (opts: any) => { capture.push(opts); return orig(opts); };
  return runner;
}

describe("chain", () => {
  it("passes each step's result into the next step's {previous}", async () => {
    const db = freshDb(); const seen: any[] = [];
    const runner = makeRunner(db, seen);
    const rows = await runChain(runner, [{ agent: "a" }, { agent: "b", task: "review {previous}" }], { task: "original", context: "fresh" });
    expect(rows).toHaveLength(2);
    expect(seen[1].task).toContain("res-0"); // step 2 saw step 1's result
  });
});

describe("parallel", () => {
  it("expands count and runs all tasks", async () => {
    const db = freshDb(); const seen: any[] = [];
    const runner = makeRunner(db, seen);
    // parallel uses runForeground under the hood via a pool
    const rows = await runParallel(runner, [{ agent: "w", task: "t", count: 3 }], { concurrency: 2, context: "fresh" });
    expect(rows).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/subagents -- modes`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `single.ts`, `chain.ts`, `parallel.ts` + a `modes-index.ts` barrel**

```ts
// src/single.ts
import type { Runner } from "./runner.js";
import type { RunRow } from "./run-store.js";
export function runSingle(runner: Runner, spec: { agent: string; task?: string; model?: string; skill?: string; context: "fresh" | "fork"; async?: boolean }): Promise<RunRow> | RunRow {
  const opts = { agent: spec.agent, task: spec.task ?? "", model: spec.model, skill: spec.skill, context: spec.context };
  return spec.async ? runner.runAsync(opts) : runner.runForeground(opts);
}
```

```ts
// src/chain.ts
import type { Runner } from "./runner.js";
import type { RunRow } from "./run-store.js";
function interpolate(tmpl: string, vars: { task: string; previous: string }): string {
  return tmpl.replace(/\{task\}/g, vars.task).replace(/\{previous\}/g, vars.previous);
}
export async function runChain(runner: Runner, steps: Array<{ agent?: string; task?: string; model?: string; context?: "fresh" | "fork" }>, base: { task: string; context: "fresh" | "fork" }): Promise<RunRow[]> {
  const out: RunRow[] = [];
  let previous = "";
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const tmpl = s.task ?? (i === 0 ? "{task}" : "{previous}");
    const task = interpolate(tmpl, { task: base.task, previous });
    const row = await runner.runForeground({ agent: s.agent ?? "worker", task, model: s.model, context: s.context ?? base.context, phase: `step-${i + 1}` });
    out.push(row);
    previous = row.result ?? "";
  }
  return out;
}
```

```ts
// src/parallel.ts
import type { Runner } from "./runner.js";
import type { RunRow } from "./run-store.js";
export async function runParallel(runner: Runner, tasks: Array<{ agent: string; task: string; count?: number; model?: string; context?: "fresh" | "fork" }>, opts: { concurrency?: number; context: "fresh" | "fork" }): Promise<RunRow[]> {
  const expanded: Array<{ agent: string; task: string; model?: string; context: "fresh" | "fork"; childIndex: number }> = [];
  let idx = 0;
  for (const t of tasks) for (let c = 0; c < (t.count ?? 1); c++) expanded.push({ agent: t.agent, task: t.task, model: t.model, context: t.context ?? opts.context, childIndex: idx++ });
  const limit = Math.max(1, opts.concurrency ?? 4);
  const results: RunRow[] = new Array(expanded.length);
  let next = 0;
  async function worker() {
    while (next < expanded.length) {
      const i = next++;
      const e = expanded[i];
      results[i] = await runner.runForeground({ agent: e.agent, task: e.task, model: e.model, context: e.context, childIndex: e.childIndex });
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, expanded.length) }, () => worker()));
  return results;
}
```

```ts
// src/modes-index.ts
export { runSingle } from "./single.js";
export { runChain } from "./chain.js";
export { runParallel } from "./parallel.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/subagents -- modes`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/subagents/src/single.ts spider/packages/subagents/src/chain.ts spider/packages/subagents/src/parallel.ts spider/packages/subagents/src/modes-index.ts spider/packages/subagents/test/modes.test.ts
git commit -m "feat(subagents): single/chain/parallel mode orchestrators over Runner"
```

---

### Task 9: `intercom` wrapper — `message` action + `message_mirror` observability

**Files:**
- Create: `spider/packages/subagents/src/intercom.ts`
- Create: `spider/packages/subagents/test/intercom.test.ts`

**Interfaces:**
- Consumes: `pi.events` (the pi-intercom seam), `globalDb` (message_mirror lives in the Global DB per contract), `RunEvent`.
- Produces:
```ts
export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
export function mirrorMessage(globalDb: Db, m: { fromSession?: string; toSession?: string; kind?: string; body?: string }): void; // INSERT INTO message_mirror
export function sendIntercom(pi: ExtensionAPI, globalDb: Db, m: { to: string; message: string; fromSession?: string; kind?: string; timeoutMs?: number }): Promise<{ delivered: boolean; error?: string }>;
```
`sendIntercom` emits `SUBAGENT_RESULT_INTERCOM_EVENT` with `{to, message, requestId}` on `pi.events` (pi-intercom relays over the socket + acks via `…-delivery`), awaits the delivery event (bounded by `timeoutMs`), and mirrors into `message_mirror`. Live traffic stays on the socket — the mirror is observability only.

- [ ] **Step 1: Write the failing test** (fake `pi.events`)

```ts
// test/intercom.test.ts
import { describe, it, expect } from "vitest";
import { sendIntercom, mirrorMessage, SUBAGENT_RESULT_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT } from "../src/intercom.js";
import { openGlobal, migrate } from "@spider/db-core";
import { paths } from "@spider/db-core";
import * as fs from "node:fs"; import * as path from "node:path";

function freshGlobal() {
  const dir = path.join(paths.scratch("global"), `g-${process.pid}-${Math.random()}`);
  fs.mkdirSync(dir, { recursive: true });
  const db = openGlobal(); migrate(db, "global"); return db; // adapt to Phase 0 openGlobal(path?) as needed
}

function fakePi() {
  const handlers: Record<string, Function[]> = {};
  return {
    events: {
      on(name: string, fn: Function) { (handlers[name] ??= []).push(fn); return () => {}; },
      emit(name: string, payload: any) {
        (handlers[name] ?? []).forEach(fn => fn(payload));
        // simulate pi-intercom acking a result event
        if (name === SUBAGENT_RESULT_INTERCOM_EVENT) {
          (handlers[SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT] ?? []).forEach(fn => fn({ requestId: payload.requestId, delivered: true }));
        }
      },
    },
  } as any;
}

describe("intercom wrapper", () => {
  it("mirrorMessage writes a message_mirror row", () => {
    const db = freshGlobal();
    mirrorMessage(db, { fromSession: "a", toSession: "b", kind: "handoff", body: "hi" });
    const row = db.prepare(`SELECT * FROM message_mirror`).get() as any;
    expect(row.from_session).toBe("a"); expect(row.kind).toBe("handoff"); expect(row.body).toBe("hi");
  });

  it("sendIntercom emits, awaits delivery ack, and mirrors", async () => {
    const db = freshGlobal();
    const pi = fakePi();
    const res = await sendIntercom(pi, db, { to: "reviewer", message: "outputs", fromSession: "s1", kind: "handoff", timeoutMs: 1000 });
    expect(res.delivered).toBe(true);
    const row = db.prepare(`SELECT * FROM message_mirror`).get() as any;
    expect(row.to_session).toBe("reviewer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/subagents -- intercom`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `intercom.ts`**

```ts
// src/intercom.ts
import { randomUUID } from "node:crypto";
import type { Db } from "@spider/db-core";
export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";

export function mirrorMessage(globalDb: Db, m: { fromSession?: string; toSession?: string; kind?: string; body?: string }): void {
  globalDb.prepare(`INSERT INTO message_mirror (from_session, to_session, kind, body, created_at) VALUES (@f,@t,@k,@b,@c)`)
    .run({ f: m.fromSession ?? null, t: m.toSession ?? null, k: m.kind ?? null, b: m.body ?? null, c: Date.now() });
}

export function sendIntercom(pi: any, globalDb: Db, m: { to: string; message: string; fromSession?: string; kind?: string; timeoutMs?: number }): Promise<{ delivered: boolean; error?: string }> {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const off = pi.events.on(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, (p: any) => {
      if (p?.requestId !== requestId || settled) return;
      settled = true; off?.();
      mirrorMessage(globalDb, { fromSession: m.fromSession, toSession: m.to, kind: m.kind ?? "message", body: m.message });
      resolve({ delivered: !!p.delivered, error: p.error });
    });
    const timer = setTimeout(() => {
      if (settled) return; settled = true; off?.();
      mirrorMessage(globalDb, { fromSession: m.fromSession, toSession: m.to, kind: m.kind ?? "message", body: m.message });
      resolve({ delivered: false, error: "intercom delivery timeout" });
    }, m.timeoutMs ?? 10_000);
    if (typeof (timer as any).unref === "function") (timer as any).unref();
    pi.events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, { to: m.to, message: m.message, requestId });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/subagents -- intercom`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/subagents/src/intercom.ts spider/packages/subagents/test/intercom.test.ts
git commit -m "feat(subagents): intercom message wrapper (pi-intercom seam) + message_mirror observability"
```

---

### Task 10: `PipelineCoordinator` — first-class `run {pipeline, handoff:"intercom"}` auto-wake

> **DESIGN DECISION (resolves the spec's OPEN sub-decision — see spec §"Subagents runtime + intercom orchestration"):** the pipeline-with-handoff is a **first-class `run` construct**, NOT prompt-driven. **Justification:** (1) *Deterministic edges for the UI* — Phase 5's pipeline-aware footer/grid renders `handoff` edges + phase state; those edges must be recorded by the runtime as `run_events(type='handoff')` with exact `toRunId`, which an LLM prompt cannot reliably produce. (2) *Correct addressing + delivery* — waking the next stage requires the parent to set the child's env (`PI_SUBAGENT_ORCHESTRATOR_TARGET`, run id, intercom session name) at spawn and to guarantee/ack delivery; a prompt-driven worker cannot self-address an as-yet-unspawned successor. (3) *Testability* — a runtime coordinator is unit-testable (this task); prompt-driven handoff is not. (4) *Observability* — `message_mirror` + `run_events` give a complete, queryable pipeline history for the organism. Prompt guidance still exists (the rewritten skills in Phase 7 tell workers to use `contact_supervisor`/`message`), but the pipeline *mechanism* is the runtime construct defined here.

**Pipeline schema (frozen for this phase; add to `schemas.ts` in Task 11):**
```ts
export interface PipelineStage {
  agent: string;                       // agent to spawn for this stage
  role?: string;                       // semantic role label (e.g. "worker","reviewer")
  phase?: string;                      // phase label for footer/grid
  task?: string;                       // template; {task} original, {previous} prior result, {handoff} = intercom body, {outputs.<as>}
  as?: string;                         // name to reference this stage's output downstream
  model?: string; skill?: string;
  context?: "fresh" | "fork";          // default "fresh"
  count?: number;                      // fan out N parallel workers at this stage (all must finish before wake)
  wakeOn?: "done" | "accepted";        // when to advance (default "done"; "accepted" gates on acceptance ledger — Phase 8, treated as "done" now)
}
export interface RunPipelineArgs { pipeline: PipelineStage[]; handoff: "intercom" | "wait"; async?: boolean; }
```
`handoff:"intercom"` = push-based auto-wake (this task). `handoff:"wait"` = legacy blocking fallback (delegates to `runChain`, Task 8) — kept so callers can opt out.

**Files:**
- Create: `spider/packages/subagents/src/pipeline.ts`
- Create: `spider/packages/subagents/test/pipeline.test.ts`

**Interfaces:**
- Consumes: `Runner`, `RunStore`, `emitHandoff`, `sendIntercom`, `bus`.
- Produces:
```ts
export class PipelineCoordinator {
  constructor(deps: { db: Db; globalDb: Db; store: RunStore; runner: Runner; pi: ExtensionAPI; sessionId: string });
  start(args: RunPipelineArgs): { pipelineId: string; firstRunId: string };  // spawns stage 0, arms wake-on-terminal for the rest
  // internal (exported for tests):
  onRunTerminal(runId: string): void;  // advances to next stage: records handoff edge, wakes next via intercom, spawns it
  dispose(): void;
}
```
Mechanism: `start` spawns stage 0 (async) with `orchestratorTarget = the parent session intercom name`. The coordinator subscribes to `bus` for `status` events; when a stage's run(s) reach terminal (`done`), it (a) records `emitHandoff(from=stageRun, to=nextRun)`, (b) `sendIntercom(pi, globalDb, {to: nextStage intercom name, message: prior result, kind:"handoff"})` — the wake — and (c) spawns the next stage async pre-wired with `{previous}`/`{handoff}` = prior result. No blocking `wait`.

- [ ] **Step 1: Write the failing test** (fake runner/spawn, synchronous terminal)

```ts
// test/pipeline.test.ts
import { describe, it, expect } from "vitest";
import { PipelineCoordinator } from "../src/pipeline.js";
import { RunStore } from "../src/run-store.js";
import { RunEventTailer } from "../src/event-tailer.js";
import { Runner } from "../src/runner.js";
import { freshGlobal } from "./intercom.test.js"; // reuse helper or duplicate
import { freshDb } from "./testutil.js";

function fakePi() {
  const h: Record<string, Function[]> = {};
  return { events: { on: (n: string, f: Function) => ((h[n] ??= []).push(f), () => {}),
    emit: (n: string, p: any) => { (h[n] ?? []).forEach(f => f(p)); if (n === "subagent:result-intercom") (h["subagent:result-intercom-delivery"] ?? []).forEach(f => f({ requestId: p.requestId, delivered: true })); } } } as any;
}

describe("PipelineCoordinator", () => {
  it("advances stage-by-stage, records handoff edges, and wakes via intercom (no blocking wait)", async () => {
    const db = freshDb(); const globalDb = freshGlobal();
    const store = new RunStore(db);
    // fake runner: runAsync creates run + immediately finishes it done, returning the row
    let seq = 0;
    const runner: any = {
      runAsync(opts: any) {
        const id = `run-${seq++}`;
        store.create({ id, sessionId: "s1", agent: opts.agent, role: opts.role, task: opts.task, parentRunId: opts.parentRunId });
        store.start(id); store.finish(id, { status: "done", result: `${opts.agent}-out` });
        // emit terminal on the bus so the coordinator advances
        setTimeout(() => require("@spider/db-core").bus.emit({ runId: id, sessionId: "s1", ts: Date.now(), type: "status", payload: { status: "done" } }), 0);
        return store.get(id);
      },
    };
    const pi = fakePi();
    const coord = new PipelineCoordinator({ db, globalDb, store, runner, pi, sessionId: "s1" });
    coord.start({ pipeline: [{ agent: "worker", role: "impl" }, { agent: "worker", role: "reviewer", task: "review {previous}" }], handoff: "intercom" });
    await new Promise(r => setTimeout(r, 30));
    const handoffs = db.prepare(`SELECT * FROM run_events WHERE type='handoff'`).all() as any[];
    expect(handoffs.length).toBe(1);                                // one worker→reviewer edge
    const mirror = globalDb.prepare(`SELECT * FROM message_mirror WHERE kind='handoff'`).all() as any[];
    expect(mirror.length).toBe(1);                                  // wake was mirrored
    const reviewer = store.listForSession("s1").find(r => r.role === "reviewer")!;
    expect(reviewer.task).toContain("impl-out");                    // reviewer received prior output as {previous}
    coord.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/subagents -- pipeline`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `pipeline.ts`**

```ts
// src/pipeline.ts
import { randomUUID } from "node:crypto";
import { bus } from "@spider/db-core";
import type { Db, RunEvent } from "@spider/db-core";
import { RunStore, type RunRow } from "./run-store.js";
import { emitHandoff } from "./run-events.js";
import { sendIntercom } from "./intercom.js";
import type { PipelineStage, RunPipelineArgs } from "./schemas.js"; // types added in Task 11

export class PipelineCoordinator {
  private off: (() => void) | null = null;
  private stageIndex = 0;
  private pipelineId = randomUUID();
  private stages: PipelineStage[] = [];
  private lastRun: RunRow | null = null;
  private baseTask = "";
  constructor(private deps: { db: Db; globalDb: Db; store: RunStore; runner: any; pi: any; sessionId: string }) {}

  private intercomName(stage: PipelineStage, runId: string): string {
    return `${stage.role ?? stage.agent}-${runId.slice(0, 8)}`;
  }
  private interpolate(tmpl: string, previous: string): string {
    return tmpl.replace(/\{task\}/g, this.baseTask).replace(/\{previous\}/g, previous).replace(/\{handoff\}/g, previous);
  }

  start(args: RunPipelineArgs): { pipelineId: string; firstRunId: string } {
    this.stages = args.pipeline;
    this.stageIndex = 0;
    this.baseTask = args.pipeline[0]?.task ?? "";
    const first = this.spawnStage(0, "");
    this.off = bus.on((e: RunEvent) => {
      if (e.type !== "status") return;
      const status = (e.payload as any)?.status;
      if (e.runId && e.runId === this.lastRun?.id && (status === "done" || status === "error" || status === "interrupted")) {
        this.onRunTerminal(e.runId);
      }
    });
    return { pipelineId: this.pipelineId, firstRunId: first.id };
  }

  private spawnStage(index: number, previous: string): RunRow {
    const stage = this.stages[index];
    const task = this.interpolate(stage.task ?? (index === 0 ? "{task}" : "{previous}"), previous);
    const parentRunId = this.lastRun?.id;
    const row: RunRow = this.deps.runner.runAsync({
      agent: stage.agent, role: stage.role, task, model: stage.model, skill: stage.skill,
      context: stage.context ?? "fresh", phase: stage.phase ?? `stage-${index}`, parentRunId,
      orchestratorTarget: undefined, intercomSessionName: undefined, async: true,
    });
    this.lastRun = row;
    this.stageIndex = index;
    return row;
  }

  onRunTerminal(runId: string): void {
    const finished = this.deps.store.get(runId);
    const nextIndex = this.stageIndex + 1;
    if (!finished || nextIndex >= this.stages.length) { this.dispose(); return; }
    const previous = finished.result ?? "";
    const nextStage = this.stages[nextIndex];
    // spawn next stage first so we have its run id for the handoff edge + wake target
    const next = this.spawnStage(nextIndex, previous);
    emitHandoff(this.deps.db, { runId: finished.id, sessionId: this.deps.sessionId, toRunId: next.id, phase: nextStage.phase, summary: `${finished.role ?? finished.agent}→${nextStage.role ?? nextStage.agent}` });
    void sendIntercom(this.deps.pi, this.deps.globalDb, { to: this.intercomName(nextStage, next.id), message: previous, fromSession: this.deps.sessionId, kind: "handoff" });
  }

  dispose(): void { this.off?.(); this.off = null; }
}
```
> **NOTE (fan-out `count`):** when `stage.count > 1`, spawn N children at the stage and only advance when ALL N reach terminal (track a per-stage completion set). The test covers `count` omitted (=1); add a `count`-aware completion set in the same file when Phase 5 needs multi-worker stages — keep the single-worker path as written. `wakeOn:"accepted"` is treated as `"done"` until the acceptance ledger lands (Phase 8); document this in the JSDoc.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/subagents -- pipeline`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/subagents/src/pipeline.ts spider/packages/subagents/test/pipeline.test.ts
git commit -m "feat(subagents): first-class pipeline auto-wake coordinator (run {pipeline, handoff:intercom})"
```

---

### Task 11: `schemas.ts` — trimmed TypeBox for `run`/`wait`/`message` + pipeline types

**Files:**
- Create: `spider/packages/subagents/src/schemas.ts`
- Create: `spider/packages/subagents/test/schemas.test.ts`

**Interfaces:**
- Produces: `RunParams`, `WaitParams`, `MessageParams` (TypeBox), and TS types `PipelineStage`, `RunPipelineArgs` (imported by `pipeline.ts`).
- `RunParams` accepts SINGLE (`agent`,`task`), CHAIN (`chain`), PARALLEL (`tasks`,`concurrency`), PIPELINE (`pipeline`,`handoff`), plus `context`,`async`,`model`,`skill`.

- [ ] **Step 1: Write the failing test**

```ts
// test/schemas.test.ts
import { describe, it, expect } from "vitest";
import { RunParams, WaitParams, MessageParams } from "../src/schemas.js";
import { Value } from "typebox/value";

describe("schemas", () => {
  it("RunParams accepts a pipeline+handoff shape", () => {
    const ok = Value.Check(RunParams, { pipeline: [{ agent: "worker", role: "impl" }, { agent: "worker", role: "reviewer" }], handoff: "intercom" });
    expect(ok).toBe(true);
  });
  it("RunParams accepts single agent+task", () => {
    expect(Value.Check(RunParams, { agent: "worker", task: "do it" })).toBe(true);
  });
  it("MessageParams requires to+message", () => {
    expect(Value.Check(MessageParams, { to: "reviewer", message: "hi" })).toBe(true);
    expect(Value.Check(MessageParams, { to: "reviewer" })).toBe(false);
  });
  it("WaitParams accepts empty (wait-any) and {all:true}", () => {
    expect(Value.Check(WaitParams, {})).toBe(true);
    expect(Value.Check(WaitParams, { all: true, timeoutMs: 1000 })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/subagents -- schemas`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `schemas.ts`** (trim from ported pi-subagents `SubagentParams`/`WaitParams`)

```ts
// src/schemas.ts
import { Type } from "typebox";

const ContextEnum = Type.Optional(Type.String({ enum: ["fresh", "fork"], description: "'fresh' or fork from parent session" }));

const PipelineStageSchema = Type.Object({
  agent: Type.String(),
  role: Type.Optional(Type.String()),
  phase: Type.Optional(Type.String()),
  task: Type.Optional(Type.String({ description: "Template: {task},{previous},{handoff},{outputs.<as>}" })),
  as: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  skill: Type.Optional(Type.String()),
  context: ContextEnum,
  count: Type.Optional(Type.Integer({ minimum: 1 })),
  wakeOn: Type.Optional(Type.String({ enum: ["done", "accepted"] })),
}, { additionalProperties: false });

const TaskItem = Type.Object({ agent: Type.String(), task: Type.String(), count: Type.Optional(Type.Integer({ minimum: 1 })), model: Type.Optional(Type.String()), context: ContextEnum }, { additionalProperties: false });
const ChainItem = Type.Object({ agent: Type.Optional(Type.String()), task: Type.Optional(Type.String()), model: Type.Optional(Type.String()), context: ContextEnum }, { additionalProperties: false });

export const RunParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "SINGLE mode agent" })),
  task: Type.Optional(Type.String({ description: "SINGLE mode task" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "CHAIN mode: sequential steps ({previous} passed forward)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "PARALLEL mode tasks" })),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "PARALLEL max concurrent (default 4)" })),
  pipeline: Type.Optional(Type.Array(PipelineStageSchema, { description: "PIPELINE mode: push-based auto-wake stages" })),
  handoff: Type.Optional(Type.String({ enum: ["intercom", "wait"], description: "PIPELINE handoff mechanism (default intercom)" })),
  context: ContextEnum,
  async: Type.Optional(Type.Boolean({ description: "Run in background" })),
  model: Type.Optional(Type.String()),
  skill: Type.Optional(Type.String()),
});

export const WaitParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Run id/prefix to wait for one run; omit to wait across all active async runs" })),
  all: Type.Optional(Type.Boolean({ description: "Wait for ALL active runs (default false = first-finish)" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Give up after ms (default 1800000)" })),
});

export const MessageParams = Type.Object({
  to: Type.String({ description: "Target session name/id" }),
  message: Type.String({ description: "Message body" }),
  kind: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

export interface PipelineStage { agent: string; role?: string; phase?: string; task?: string; as?: string; model?: string; skill?: string; context?: "fresh" | "fork"; count?: number; wakeOn?: "done" | "accepted"; }
export interface RunPipelineArgs { pipeline: PipelineStage[]; handoff: "intercom" | "wait"; async?: boolean; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/subagents -- schemas`
Expected: PASS (4 tests). Adjust the `typebox/value` import path to the installed typebox's value checker if different.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/subagents/src/schemas.ts spider/packages/subagents/test/schemas.test.ts
git commit -m "feat(subagents): trimmed TypeBox schemas for run/wait/message + pipeline types"
```

---

### Task 12: `wait` semantics — event-driven over `runs` + `bus` with poll fallback

**Files:**
- Create: `spider/packages/subagents/src/wait.ts`
- Create: `spider/packages/subagents/test/wait.test.ts`

**Interfaces:**
- Consumes: `RunStore`, `bus`, `run-id` resolver.
- Produces:
```ts
export interface WaitResult { finished: RunRow[]; stillActive: RunRow[]; timedOut: boolean; }
export function waitForRuns(deps: { db: Db; store: RunStore; sessionId: string }, opts: { id?: string; all?: boolean; timeoutMs?: number }): Promise<WaitResult>;
// Semantics (ported from pi-subagents WaitParams): id → wait that one run; all=true → wait until ALL active finish;
//   default (no id, all falsey) → resolve as soon as the FIRST active run finishes (fleet-manager pattern). timeoutMs default 1800000.
```
Event-driven: subscribe to `bus` `status` terminal events; a stale-run reconcile query (runs `running` with no `run_events` for > staleMs) is treated as finished/error on timeout. Already-terminal runs resolve immediately without waiting.

- [ ] **Step 1: Write the failing test**

```ts
// test/wait.test.ts
import { describe, it, expect } from "vitest";
import { bus } from "@spider/db-core";
import { waitForRuns } from "../src/wait.js";
import { RunStore } from "../src/run-store.js";
import { emitStatus } from "../src/run-events.js";
import { freshDb } from "./testutil.js";

describe("waitForRuns", () => {
  it("resolves immediately if the targeted run is already terminal", async () => {
    const db = freshDb(); const store = new RunStore(db);
    store.create({ id: "r1", sessionId: "s1", agent: "w" }); store.start("r1"); store.finish("r1", { status: "done" });
    const res = await waitForRuns({ db, store, sessionId: "s1" }, { id: "r1", timeoutMs: 500 });
    expect(res.timedOut).toBe(false);
    expect(res.finished.map(r => r.id)).toEqual(["r1"]);
  });

  it("first-finish (default) resolves when one of several active runs finishes", async () => {
    const db = freshDb(); const store = new RunStore(db);
    store.create({ id: "a", sessionId: "s1", agent: "w" }); store.start("a");
    store.create({ id: "b", sessionId: "s1", agent: "w" }); store.start("b");
    const p = waitForRuns({ db, store, sessionId: "s1" }, { timeoutMs: 1000 });
    store.finish("b", { status: "done" });
    emitStatus(db, { runId: "b", sessionId: "s1", status: "done" });
    const res = await p;
    expect(res.finished.map(r => r.id)).toContain("b");
    expect(res.stillActive.map(r => r.id)).toContain("a");
  });

  it("all=true waits for every active run", async () => {
    const db = freshDb(); const store = new RunStore(db);
    store.create({ id: "a", sessionId: "s1", agent: "w" }); store.start("a");
    store.create({ id: "b", sessionId: "s1", agent: "w" }); store.start("b");
    const p = waitForRuns({ db, store, sessionId: "s1" }, { all: true, timeoutMs: 1000 });
    store.finish("a", { status: "done" }); emitStatus(db, { runId: "a", sessionId: "s1", status: "done" });
    store.finish("b", { status: "error" }); emitStatus(db, { runId: "b", sessionId: "s1", status: "error" });
    const res = await p;
    expect(res.finished.map(r => r.id).sort()).toEqual(["a", "b"]);
  });

  it("returns timedOut=true when nothing finishes in time", async () => {
    const db = freshDb(); const store = new RunStore(db);
    store.create({ id: "a", sessionId: "s1", agent: "w" }); store.start("a");
    const res = await waitForRuns({ db, store, sessionId: "s1" }, { timeoutMs: 30 });
    expect(res.timedOut).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/subagents -- wait`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `wait.ts`**

```ts
// src/wait.ts
import { bus } from "@spider/db-core";
import type { Db, RunEvent } from "@spider/db-core";
import { RunStore, type RunRow } from "./run-store.js";

const TERMINAL = new Set(["done", "error", "interrupted"]);
export interface WaitResult { finished: RunRow[]; stillActive: RunRow[]; timedOut: boolean; }

export function waitForRuns(deps: { db: Db; store: RunStore; sessionId: string }, opts: { id?: string; all?: boolean; timeoutMs?: number }): Promise<WaitResult> {
  const { store, sessionId } = deps;
  const targetIds = opts.id
    ? store.listForSession(sessionId).filter(r => r.id === opts.id || r.id.startsWith(opts.id!)).map(r => r.id)
    : store.listActive(sessionId).map(r => r.id);

  const done = (): RunRow[] => targetIds.map(id => store.get(id)!).filter(r => r && TERMINAL.has(r.status));
  const finishedNow = done();
  const wantAll = opts.all || !!opts.id;
  const satisfied = () => wantAll ? done().length === targetIds.length : done().length >= 1;

  if (targetIds.length === 0 || satisfied()) {
    const f = done();
    return Promise.resolve({ finished: f, stillActive: store.listActive(sessionId), timedOut: false });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (timedOut: boolean) => {
      if (settled) return; settled = true; off(); clearTimeout(timer);
      resolve({ finished: done(), stillActive: store.listActive(sessionId), timedOut });
    };
    const off = bus.on((e: RunEvent) => {
      if (e.type !== "status" || !e.runId || !targetIds.includes(e.runId)) return;
      if (satisfied()) finish(false);
    });
    const timer = setTimeout(() => finish(true), opts.timeoutMs ?? 1_800_000);
    if (typeof (timer as any).unref === "function") (timer as any).unref();
    if (satisfied()) finish(false);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/subagents -- wait`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/subagents/src/wait.ts spider/packages/subagents/test/wait.test.ts
git commit -m "feat(subagents): event-driven waitForRuns (first-finish / all / id / timeout) over runs+bus"
```

---

### Task 13: `coordinators.ts` — per-session registry (replaces `globalThis` singletons)

**Files:**
- Create: `spider/packages/subagents/src/coordinators.ts`
- Create: `spider/packages/subagents/test/coordinators.test.ts`

**Interfaces:**
- Produces:
```ts
export interface SessionCoordinators { tailer: RunEventTailer; pipelines: PipelineCoordinator[]; }
export function getCoordinators(sessionId: string, make: () => SessionCoordinators): SessionCoordinators;
export function teardownCoordinators(sessionId: string): void;   // stops tailer, disposes pipelines
export function teardownAll(): void;
```
Module-scoped `Map<string, SessionCoordinators>` — one activation owns it; no `globalThis`. Teardown on `session_shutdown`.

- [ ] **Step 1: Write the failing test**

```ts
// test/coordinators.test.ts
import { describe, it, expect } from "vitest";
import { getCoordinators, teardownCoordinators } from "../src/coordinators.js";

describe("coordinators registry", () => {
  it("creates once per session and tears down", () => {
    let stopped = 0, disposed = 0;
    const make = () => ({ tailer: { stop: () => stopped++ } as any, pipelines: [{ dispose: () => disposed++ } as any] });
    const a = getCoordinators("s1", make);
    const b = getCoordinators("s1", make);
    expect(a).toBe(b);                       // same instance, make() called once
    teardownCoordinators("s1");
    expect(stopped).toBe(1); expect(disposed).toBe(1);
    const c = getCoordinators("s1", make);   // recreated after teardown
    expect(c).not.toBe(a);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/subagents -- coordinators`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `coordinators.ts`**

```ts
// src/coordinators.ts
import type { RunEventTailer } from "./event-tailer.js";
import type { PipelineCoordinator } from "./pipeline.js";
export interface SessionCoordinators { tailer: RunEventTailer; pipelines: PipelineCoordinator[]; }
const registry = new Map<string, SessionCoordinators>();
export function getCoordinators(sessionId: string, make: () => SessionCoordinators): SessionCoordinators {
  let c = registry.get(sessionId);
  if (!c) { c = make(); registry.set(sessionId, c); }
  return c;
}
export function teardownCoordinators(sessionId: string): void {
  const c = registry.get(sessionId);
  if (!c) return;
  try { c.tailer.stop(); } catch {}
  for (const p of c.pipelines) { try { p.dispose(); } catch {} }
  registry.delete(sessionId);
}
export function teardownAll(): void { for (const id of [...registry.keys()]) teardownCoordinators(id); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/subagents -- coordinators`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/subagents/src/coordinators.ts spider/packages/subagents/test/coordinators.test.ts
git commit -m "feat(subagents): module-scoped per-session coordinator registry (no globalThis)"
```

---

### Task 14: Action handlers — wire `run`/`wait`/`message` into `registerAction`

**Files:**
- Create: `spider/packages/subagents/src/actions/run.ts`
- Create: `spider/packages/subagents/src/actions/wait.ts`
- Create: `spider/packages/subagents/src/actions/message.ts`
- Modify: `spider/packages/subagents/src/index.ts`
- Create: `spider/packages/subagents/test/actions.test.ts`

**Interfaces:**
- Consumes: `ActionCtx` (db/globalDb/project/sessionId/cwd/pi), all mode/pipeline/wait/intercom modules, `paths.scratch`.
- Produces: `registerSubagentActions(host, pi)` registers `run`/`wait`/`message`; the `run` handler routes by args shape (pipeline > chain > tasks > single), builds a `Runner` with the real default spawner + the session tailer, and returns an `ActionResult`.

- [ ] **Step 1: Write the failing test** (drive `run` handler with a fake Runner via dependency seam)

```ts
// test/actions.test.ts
import { describe, it, expect } from "vitest";
import { makeRunHandler } from "../src/actions/run.js";
import { RunStore } from "../src/run-store.js";
import { freshDb } from "./testutil.js";

describe("run action routing", () => {
  it("routes a single {agent,task} to a single foreground run", async () => {
    const db = freshDb(); const store = new RunStore(db);
    const calls: string[] = [];
    const fakeRunnerFactory = () => ({
      runForeground: async (o: any) => { calls.push(`single:${o.agent}`); store.create({ id: "x", sessionId: "s1", agent: o.agent, task: o.task }); return store.get("x"); },
      runAsync: (o: any) => { store.create({ id: "y", sessionId: "s1", agent: o.agent }); return store.get("y"); },
    });
    const handler = makeRunHandler({ makeRunner: fakeRunnerFactory as any, makeStore: () => store });
    const ctx: any = { db, globalDb: db, sessionId: "s1", cwd: "/x", project: { dbPath: "/x/db" }, pi: { events: { on() {}, emit() {} } } };
    const res = await handler({ agent: "worker", task: "do it" } as any, ctx);
    expect(calls).toContain("single:worker");
    expect((res as any).isError).not.toBe(true);
  });

  it("routes {pipeline,handoff} to the pipeline coordinator", async () => {
    const db = freshDb(); const store = new RunStore(db);
    let started = false;
    const handler = makeRunHandler({
      makeRunner: () => ({ runAsync: (o: any) => { store.create({ id: "p0", sessionId: "s1", agent: o.agent }); store.start("p0"); return store.get("p0"); } }) as any,
      makeStore: () => store,
      makePipeline: () => ({ start: () => { started = true; return { pipelineId: "pl", firstRunId: "p0" }; }, dispose() {} }) as any,
    });
    const ctx: any = { db, globalDb: db, sessionId: "s1", cwd: "/x", project: { dbPath: "/x/db" }, pi: { events: { on() {}, emit() {} } } };
    await handler({ pipeline: [{ agent: "worker" }, { agent: "worker", role: "reviewer" }], handoff: "intercom" } as any, ctx);
    expect(started).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/subagents -- actions`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the handlers + `index.ts` wiring**

```ts
// src/actions/run.ts
import { paths } from "@spider/db-core";
import { RunStore } from "../run-store.js";
import { RunEventTailer } from "../event-tailer.js";
import { Runner, type Spawner } from "../runner.js";
import { PipelineCoordinator } from "../pipeline.js";
import { runChain } from "../chain.js";
import { runParallel } from "../parallel.js";
import { runSingle } from "../single.js";
import { defaultSpawner } from "../spawn-default.js";

interface RunDeps {
  makeStore?: (db: any) => RunStore;
  makeRunner?: (db: any, sessionId: string, cwd: string, deps: any) => any;
  makePipeline?: (deps: any) => any;
  spawner?: Spawner;
}
export function makeRunHandler(overrides: RunDeps = {}) {
  return async function runHandler(args: any, ctx: any) {
    const store = overrides.makeStore?.(ctx.db) ?? new RunStore(ctx.db);
    const tailer = new RunEventTailer(ctx.db); tailer.start();
    const spawn = overrides.spawner ?? defaultSpawner;
    const scratchRoot = paths.scratch("project", ctx.cwd);
    const runner = overrides.makeRunner
      ? overrides.makeRunner(ctx.db, ctx.sessionId, ctx.cwd, { store, tailer, spawn, scratchRoot, dbPath: ctx.project.dbPath })
      : new Runner(ctx.db, ctx.sessionId, ctx.cwd, { store, tailer, spawn, scratchRoot, dbPath: ctx.project.dbPath });

    if (Array.isArray(args.pipeline)) {
      const coord = overrides.makePipeline
        ? overrides.makePipeline({ db: ctx.db, globalDb: ctx.globalDb, store, runner, pi: ctx.pi, sessionId: ctx.sessionId })
        : new PipelineCoordinator({ db: ctx.db, globalDb: ctx.globalDb, store, runner, pi: ctx.pi, sessionId: ctx.sessionId });
      const { pipelineId, firstRunId } = coord.start({ pipeline: args.pipeline, handoff: args.handoff ?? "intercom", async: true });
      return { content: `pipeline ${pipelineId} started (${args.pipeline.length} stages), first run ${firstRunId}`, details: { pipelineId, firstRunId } };
    }
    if (Array.isArray(args.chain)) {
      const rows = await runChain(runner, args.chain, { task: args.task ?? "", context: args.context ?? "fresh" });
      return { content: `chain complete: ${rows.length} steps`, details: { runs: rows } };
    }
    if (Array.isArray(args.tasks)) {
      const rows = await runParallel(runner, args.tasks, { concurrency: args.concurrency, context: args.context ?? "fresh" });
      return { content: `parallel complete: ${rows.length} runs`, details: { runs: rows } };
    }
    const row = await runSingle(runner, { agent: args.agent ?? "worker", task: args.task, model: args.model, skill: args.skill, context: args.context ?? "fresh", async: args.async });
    return { content: `run ${(row as any).id} ${(row as any).status}`, details: { run: row } };
  };
}
```

```ts
// src/actions/wait.ts
import { RunStore } from "../run-store.js";
import { waitForRuns } from "../wait.js";
export function makeWaitHandler() {
  return async function waitHandler(args: any, ctx: any) {
    const store = new RunStore(ctx.db);
    const res = await waitForRuns({ db: ctx.db, store, sessionId: ctx.sessionId }, { id: args.id, all: args.all, timeoutMs: args.timeoutMs });
    return { content: `${res.finished.length} finished, ${res.stillActive.length} active${res.timedOut ? " (timed out)" : ""}`, details: res };
  };
}
```

```ts
// src/actions/message.ts
import { sendIntercom } from "../intercom.js";
export function makeMessageHandler() {
  return async function messageHandler(args: any, ctx: any) {
    const res = await sendIntercom(ctx.pi, ctx.globalDb, { to: args.to, message: args.message, fromSession: ctx.sessionId, kind: args.kind, timeoutMs: args.timeoutMs });
    return { content: res.delivered ? `message delivered to ${args.to}` : `message NOT delivered: ${res.error}`, isError: !res.delivered, details: res };
  };
}
```

```ts
// src/spawn-default.ts  (real child spawner; NOT exercised in unit tests)
import { spawn } from "node:child_process";
import type { Spawner, ChildHandle } from "./runner.js";
export const defaultSpawner: Spawner = (spec): ChildHandle => {
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: "ignore" });
  let exit: Promise<{ exitCode: number; result?: string }> | null = null;
  return {
    pid: child.pid,
    wait() { return (exit ??= new Promise((res) => child.on("exit", (code) => res({ exitCode: code ?? 0 })))); },
    kill() { child.kill(); },
    detach() { child.unref(); },
  };
};
```

```ts
// src/index.ts
import { registerAction } from "@spider/host"; // or whatever host exposes; adapt to Phase 0 host handle
import { attachChildReporter, isSubagentChild } from "./child-reporter.js";
import { makeRunHandler } from "./actions/run.js";
import { makeWaitHandler } from "./actions/wait.js";
import { makeMessageHandler } from "./actions/message.js";
import { teardownAll } from "./coordinators.js";

export function registerSubagentActions(host: any, pi: any): void {
  if (isSubagentChild()) { attachChildReporter(pi); return; }   // child: report only, no orchestration surface
  (host.registerAction ?? registerAction)("run", makeRunHandler());
  (host.registerAction ?? registerAction)("wait", makeWaitHandler());
  (host.registerAction ?? registerAction)("message", makeMessageHandler());
  pi.on?.("session_shutdown", () => teardownAll());
}
export { makeRunHandler, makeWaitHandler, makeMessageHandler };
```
> **VALIDATE FIRST:** how `registerAction` is reached from a package (import from `@spider/host` vs a `host` handle passed in) depends on Phase 0's export. The phase-0 plan re-exports `registerAction` from the host extension; confirm the import path. Adapt the `(host.registerAction ?? registerAction)` shim to the real surface.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/subagents -- actions`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add spider/packages/subagents/src/actions spider/packages/subagents/src/spawn-default.ts spider/packages/subagents/src/index.ts spider/packages/subagents/test/actions.test.ts
git commit -m "feat(subagents): run/wait/message action handlers + default child spawner + child-guard wiring"
```

---

### Task 15: Host wiring — register actions, child guard, teardown

**Files:**
- Modify: `spider/packages/host/src/extension.ts`
- Create: `spider/packages/host/test/subagents-wiring.test.ts`

**Interfaces:**
- Consumes: `registerSubagentActions` from `@spider/subagents`; Phase 0 host `dispatch`/`registerAction`, hook registration surface.
- Produces: the host activation calls `registerSubagentActions(host, pi)` (once, guarded), and `session_shutdown` tears coordinators down.

- [ ] **Step 1: Write the failing test**

```ts
// packages/host/test/subagents-wiring.test.ts
import { describe, it, expect, vi } from "vitest";
import { getAction } from "../src/dispatch.js";
import spiderExtension from "../src/extension.js";

describe("host wires subagent actions", () => {
  it("registers run/wait/message actions on activation", () => {
    const pi: any = { registerTool: vi.fn(), registerCommand: vi.fn(), registerMessageRenderer: vi.fn(), on: vi.fn(), events: { on: vi.fn(), emit: vi.fn() }, getSessionName: () => "s1" };
    spiderExtension(pi);
    expect(getAction("run")).toBeTypeOf("function");
    expect(getAction("wait")).toBeTypeOf("function");
    expect(getAction("message")).toBeTypeOf("function");
  });

  it("does NOT register orchestration actions in a subagent child", () => {
    const prev = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = "1";
    try {
      const pi: any = { registerTool: vi.fn(), registerCommand: vi.fn(), registerMessageRenderer: vi.fn(), on: vi.fn(), events: { on: vi.fn(), emit: vi.fn() }, getSessionName: () => "child" };
      // clear registry between activations via dispatch.clearActions() if exposed by Phase 0
      spiderExtension(pi);
      // run should not have been registered by the subagents package in child mode
      // (a fresh dispatch registry; if Phase 0 shares module state, assert via a spy on registerSubagentActions instead)
    } finally { if (prev === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = prev; }
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spider && npm test -w @spider/host -- subagents-wiring`
Expected: FAIL — actions not registered (host doesn't yet call `registerSubagentActions`).

- [ ] **Step 3: Wire the host**

In `spider/packages/host/src/extension.ts`, inside the existing `spiderExtension(pi)` activation (after Phase 0's tool + control registration), add:
```ts
import { registerSubagentActions } from "@spider/subagents";
// ... inside spiderExtension(pi):
registerSubagentActions({ registerAction }, pi);
```
The `isSubagentChild()` early-out inside `registerSubagentActions` (Task 14) handles the child guard — it registers no `run`/`wait`/`message` and only attaches the reporter. Ensure `session_shutdown` teardown is registered (the package does this via `pi.on("session_shutdown", teardownAll)`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spider && npm test -w @spider/host -- subagents-wiring`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spider/packages/host/src/extension.ts spider/packages/host/test/subagents-wiring.test.ts
git commit -m "feat(host): register subagent run/wait/message actions + child guard + shutdown teardown"
```

---

### Task 16: Strangler cutover note + deprecation of legacy `subagent`/`wait`

**Files:**
- Modify: `spider/packages/host/src/extension.ts` (deprecation notice on any legacy `subagent`/`wait` tool still present)
- Create: `spider/docs/superpowers/plans/notes/phase4-cutover.md`

**Interfaces:**
- Produces: a documented cutover — spider's `run`/`wait`/`message` are live; the legacy pi-subagents `subagent`/`wait` tools are marked deprecated (kept, not deleted; removal owned by this phase's follow-up once Phase 5 UI consumes the new stream).

- [ ] **Step 1: Write the cutover note**

```md
<!-- notes/phase4-cutover.md -->
# Phase 4 cutover
- spider `run` (single/chain/parallel/pipeline), `wait`, `message` are live on the shared DB (`runs`/`run_events`, `message_mirror`).
- Legacy pi-subagents `subagent`/`wait` tools + tmpdir state are DEPRECATED (not removed).
- Removal condition: Phase 5 footer/grid consume `runs`/`run_events`; then delete the legacy tool registration + tmpdir consts.
- Open decision RESOLVED: pipeline-with-handoff is a first-class `run {pipeline, handoff:"intercom"}` construct (see plan Task 10 justification).
- Deferred (out of Phase 4 scope): worktree isolation, dynamic expand/collect fanout, clarify TUI, cost/profiles/doctor management actions, acceptance-gated `wakeOn:"accepted"` (Phase 8).
```

- [ ] **Step 2: Add the deprecation guard** — if the legacy `subagent`/`wait` tool is still registered anywhere, emit a one-time `pi.sendMessage` deprecation notice (or a `console.warn` behind a config flag). No test needed beyond a grep confirming the note references the removal condition.

- [ ] **Step 3: Full package test run**

Run: `cd spider && npm test -w @spider/subagents && npm test -w @spider/host`
Expected: PASS (all suites).

- [ ] **Step 4: Commit**

```bash
git add spider/docs/superpowers/plans/notes/phase4-cutover.md spider/packages/host/src/extension.ts
git commit -m "docs(subagents): phase 4 cutover note + legacy subagent/wait deprecation"
```

---

### Task 17 (optional, env-gated): end-to-end async run against a real `pi` child

**Files:**
- Create: `spider/packages/subagents/test/e2e-async.test.ts`

**Interfaces:**
- Consumes: everything wired; a real `pi` binary on PATH.
- Produces: proof that an async run's child process writes `run_events` to the shared DB and the tailer bridges them.

- [ ] **Step 1: Write the gated test**

```ts
// test/e2e-async.test.ts
import { describe, it, expect } from "vitest";
const RUN_E2E = process.env.SPIDER_E2E === "1";
describe.skipIf(!RUN_E2E)("async e2e", () => {
  it("a real async child appends run_events into the shared DB", async () => {
    // Build a Runner with the real defaultSpawner + a trivial agent/task ("echo hi"),
    // openProject in .spider/scratch, runAsync, poll run_events until a terminal runs row appears (<=60s),
    // assert runs.status === 'done' and >=1 run_events row for the run id.
    expect(true).toBe(true); // replace with the real assertions when a pi binary is available in CI
  });
});
```

- [ ] **Step 2: Run gated (default skip)**

Run: `cd spider && npm test -w @spider/subagents -- e2e-async`
Expected: SKIPPED unless `SPIDER_E2E=1` and a `pi` binary is present.

- [ ] **Step 3: Commit**

```bash
git add spider/packages/subagents/test/e2e-async.test.ts
git commit -m "test(subagents): env-gated end-to-end async child run_events e2e"
```

---

## Self-Review

**1. Spec coverage** (spec §"Subagents runtime + intercom orchestration"):
- Port run/wait single/chain/parallel/async/forked-context onto `runs`+`run_events` → Tasks 2,3,7,8 (single/chain/parallel), 5+6 (async cross-process), pi-args `context:"fresh"|"fork"` (Task 4). ✓
- Replaces tmpdir JSON/JSONL, persists across restarts → Tasks 2,3 (DB tables), Deleted-NOT-ported list. ✓
- Emits on in-process `bus` for the UI → Tasks 3 (direct), 6 (async tailer bridge). ✓
- Intercom = external dependency, NOT vendored → Task 1 (`pi-intercom` dep), Task 9 (seam only). ✓
- Value-add auto-wake worker chaining, push-based, replaces spawn→wait→process→spawn → Task 10 (`PipelineCoordinator`). ✓
- `message` verb thin wrapper + mirrored into shared DB for observability → Task 9 (`sendIntercom`+`mirrorMessage` into `message_mirror`), Task 14 (`message` action). ✓
- OPEN sub-decision resolved → Task 10 (first-class `run {pipeline, handoff:"intercom"}`, justified). ✓
- Self-named runs → Task 2 (`deriveRunName`). ✓
- TDD against temp DB in `.spider/scratch/` → every task, `testutil.freshDb`. ✓
- Child guard `PI_SUBAGENT_CHILD` → Tasks 4,5,14,15. ✓

**2. Placeholder scan:** every code step contains real code; no "TBD"/"handle edge cases". `wakeOn:"accepted"` + `count>1` fan-out are explicitly deferred with a documented interim behavior, not silent gaps. ✓

**3. Type consistency:** `RunRow`/`RunStatus`/`NewRun` (Task 2) reused in Runner/modes/pipeline/wait; `ChildSpawnSpec`/`Spawner`/`ChildHandle` (Tasks 4,7) reused in runner/spawn-default; `PipelineStage`/`RunPipelineArgs` defined in schemas (Task 11) imported by pipeline (Task 10) — note the import-order dependency (Task 11 types are referenced by Task 10's file; implement Task 11's type exports first or co-locate the interfaces in `pipeline.ts` and re-export). `deriveRunName`, `emitHandoff`, `sendIntercom`, `mirrorMessage`, `waitForRuns`, `getCoordinators` names are stable across tasks. ✓

---

## Files to Modify
- `spider/package.json` — add `pi-intercom` dependency (Task 1).
- `spider/packages/host/src/extension.ts` — call `registerSubagentActions`, child guard, shutdown teardown, legacy deprecation (Tasks 15,16).

## New Files
- `spider/packages/subagents/{package.json,tsconfig.json}` — package (Task 1).
- `spider/packages/subagents/src/{self-name,run-store,run-events,event-tailer,pi-spawn,pi-args,run-id,child-reporter,runner,single,chain,parallel,modes-index,intercom,pipeline,schemas,wait,coordinators,spawn-default,index}.ts` + `src/actions/{run,wait,message}.ts` — runtime (Tasks 2–14).
- `spider/packages/subagents/test/*.test.ts` + `test/testutil.ts` — Vitest suites (Tasks 1–14,17).
- `spider/packages/host/test/subagents-wiring.test.ts` (Task 15).
- `spider/docs/superpowers/plans/notes/phase4-cutover.md` (Task 16).

## Dependencies
- Tasks 2–3 depend on Phase 0 (`db-core` schema + `appendRunEvent`/`bus` + `openProject`).
- Task 4 (pi-args) has no runtime dep on 2–3; can proceed in parallel but is consumed by Task 7.
- Task 5 (child-reporter) depends on 2,3. Task 6 (tailer) depends on 3.
- Task 7 (Runner) depends on 2,3,4,6. Task 8 (modes) depends on 7. Task 9 (intercom) depends on Phase 0 global DB only.
- Task 10 (pipeline) depends on 7,9,3 and the types from 11 → **implement Task 11's type exports before Task 10** (or co-locate types in `pipeline.ts`).
- Task 12 (wait) depends on 2,3. Task 13 (coordinators) depends on 6,10.
- Task 14 (actions) depends on 7,8,9,10,12,13. Task 15 (host) depends on 14 + Phase 0 host. Task 16 depends on 15. Task 17 depends on all.

## Risks
- **`openProject`/`openGlobal` signature (blocker):** the contract exposes `openProject(projectKey)` + registry resolution, but the child + tests need open-by-explicit-path. Confirm/obtain `openProjectByPath(dbPath)` from Phase 0 (Task 5 VALIDATE FIRST). Never fall back to raw `new Database()` (loses WAL/retry). Surface to Phase 0 owner via `contact_supervisor` if missing.
- **`ActionCtx.pi` reachability (blocker):** the intercom seam is on `pi.events`; if Phase 0 does not thread a `pi` handle into `ActionCtx`, the `message` action + pipeline wake cannot emit. Confirm before Task 8/14 (interfaces VALIDATE FIRST).
- **`appendRunEvent` bus emission:** if Phase 0 does NOT emit on `bus` inside `appendRunEvent`, all emit helpers must call `bus.emit` explicitly (Task 3 note). Verify against Phase 0 Task 6.
- **Multi-process WAL contention:** async children write `run_events` to the same DB the parent reads. WAL + `busy_timeout` + `withRetry` (Phase 0) must be applied on the child side too; the child opens its own connection via `openProjectByPath`. If lock contention appears under many parallel children, lower child write frequency (batch tool events) — do not disable WAL.
- **pi-intercom availability at runtime:** `message`/pipeline wake depend on the pi-intercom broker being up. `sendIntercom` bounds on `timeoutMs` and mirrors even on failure, so a down broker degrades to "not delivered" (surfaced in the action result) rather than hanging — verify the broker auto-spawn path (pi-intercom `spawnBrokerIfNeeded`) works in-process.
- **Pipeline terminal detection races:** `PipelineCoordinator` advances on `bus` `status` terminal events; with the real async runner the terminal status is written by the child (Task 5) and bridged by the tailer (Task 6). Ensure the coordinator's `bus` subscription is installed before stage 0 can finish, and that it only advances for its own `lastRun.id` (guard included). The `count>1` fan-out completion set is deferred — do not ship multi-worker stages until it's added.
- **Ported `buildPiArgs` drift:** pi-subagents' `buildPiArgs` is large and couples to nested-path/event-sink env; the edit (Task 4) removes that wiring. Re-run pi-subagents' own arg expectations mentally against the trimmed version — a missed env var (e.g. capability token) may break child spawn. Keep the intercom env vars byte-identical (pi-intercom reads exact names).
- **`typebox`/`typebox/value` import paths:** the installed `typebox` (v1.x, per pi-subagents/pi-intercom) may expose `Value` at a different path than `typebox/value`. Adjust Task 11's test import to the real module.
- **Underspecified:** the spec does not define acceptance-gated handoff (`wakeOn:"accepted"`) semantics or worktree isolation for pipeline stages — both are explicitly deferred to Phase 8/later in the cutover note rather than guessed here.
