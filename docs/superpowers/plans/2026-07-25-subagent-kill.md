# Subagent Kill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the orchestrator agent and the human a reliable way to kill running subagents — a `spider kill` verb, a `k`-`k` affordance in the agent detail view, and a guarantee that quitting the session kills every child.

**Architecture:** Subagent children are spawned into their own process group (`detached`), their live `ChildHandle` is retained in the per-session `SessionCoordinators` registry, and their `pid` + owning `host_pid` are persisted on `runs`. Kill prefers the in-process handle and falls back to the persisted pid, so children orphaned by a host reload or crash remain killable. A startup reaper cancels runs whose owning host is gone.

**Tech Stack:** TypeScript (ESM), better-sqlite3 (WAL), vitest, `@earendil-works/pi-tui` for the TUI layer. Monorepo with `@spider/*` workspace packages built by vite into a single `dist/extension.js`.

Source spec: `docs/superpowers/specs/2026-07-25-tiering-intercom-kill-design.md` (Problem 3 + "Shutdown guarantee").

## Global Constraints

- Node `>=22.19.0`; build target `node22`. **Volta pins `26.4.0`** — spider's bundle loads inside pi's process and `better-sqlite3` is native, so the build node must match pi's runtime ABI (147). Build and test with `~/.nvm/versions/node/v26.4.0/bin` on PATH.
- Package dependency direction is a one-way DAG: `host` → `subagents` → `db-core`. **`subagents` must never import `@spider/host`.** Hosts are passed structurally.
- `@earendil-works/pi-coding-agent` is a **peer dependency and `external`** in `vite.config.mjs`. Its `exports` map exposes only `.` and `./rpc-entry` — **deep imports such as `dist/utils/shell.js` are forbidden** and fail at runtime.
- Scratch/test data goes under a package's `.spider/scratch/` — **never `/tmp`, `$TMPDIR`, or `/var/tmp`.** Use `scratchDbPath()` from `@spider/db-core`'s testutil.
- All user-visible output renders as a themed card via a registered renderer — **never raw JSON**.
- Every hook body is defensive: a failure must never block agent start, session start, or shutdown.
- Run `npm run typecheck` and `npm test` before every commit.
- Windows parity: process-group kill is Unix-only; Windows uses `taskkill /F /T /PID`. Guard every `detached`/negative-pid call with `process.platform === "win32"`.

---

### Task 1: Persist `pid` and `host_pid` on runs

**Files:**
- Modify: `packages/db-core/src/schema.ts:83-91` (the `runs` table in `PROJECT_SCHEMA`)
- Modify: `packages/db-core/src/migrate.ts:4` (`SCHEMA_VERSION`) and `:9-33` (`PROJECT_MIGRATIONS`)
- Modify: `packages/subagents/src/run-store.ts`
- Test: `packages/subagents/src/__tests__/run-store.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `runs.pid INTEGER` — the child process's pid, or NULL.
  - `runs.host_pid INTEGER` — `process.pid` of the spider host that spawned it.
  - `RunStore.setPid(id: string, pid: number, hostPid: number): void`
  - `RunStore.cancel(id: string, reason?: string): void` — sets `status='cancelled'`, `ended_at`, and `result`.
  - `RunRow` gains `pid: number | null; host_pid: number | null`.

- [ ] **Step 1: Write the failing test**

Append to `packages/subagents/src/__tests__/run-store.test.ts`, inside the existing `describe("RunStore", ...)` block:

```ts
  it("setPid() records the child pid and owning host pid", () => {
    const store = new RunStore(freshDb());
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.setPid(id, 4242, 99);
    const row = store.get(id)!;
    expect(row.pid).toBe(4242);
    expect(row.host_pid).toBe(99);
  });

  it("cancel() sets cancelled status, ended_at and a reason", () => {
    const store = new RunStore(freshDb());
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    store.cancel(id, "killed by orchestrator");
    const row = store.get(id)!;
    expect(row.status).toBe("cancelled");
    expect(row.ended_at).toBeGreaterThan(0);
    expect(row.result).toBe("killed by orchestrator");
  });

  it("cancel() does not resurrect an already-finished run", () => {
    const store = new RunStore(freshDb());
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    store.finish(id, { status: "done", result: "ok" });
    store.cancel(id, "too late");
    const row = store.get(id)!;
    expect(row.status).toBe("done");
    expect(row.result).toBe("ok");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/subagents/src/__tests__/run-store.test.ts`
Expected: FAIL — `store.setPid is not a function`.

- [ ] **Step 3: Add the columns to the schema**

In `packages/db-core/src/schema.ts`, replace the `runs` table definition:

```sql
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_run_id TEXT,
  agent TEXT NOT NULL, role TEXT, name TEXT,
  status TEXT NOT NULL,
  phase TEXT, model TEXT, task TEXT, thinking TEXT,
  started_at INTEGER, ended_at INTEGER,
  step_count INTEGER DEFAULT 0, token_count INTEGER DEFAULT 0,
  result TEXT,
  pid INTEGER, host_pid INTEGER
);
```

- [ ] **Step 4: Add the incremental migration**

In `packages/db-core/src/migrate.ts`, bump the version and add step 4:

```ts
export const SCHEMA_VERSION = 4;
```

Then add to `PROJECT_MIGRATIONS`, after the existing `3:` entry:

```ts
  4: [
    "ALTER TABLE runs ADD COLUMN pid INTEGER",
    "ALTER TABLE runs ADD COLUMN host_pid INTEGER",
  ],
```

- [ ] **Step 5: Implement the RunStore methods**

In `packages/subagents/src/run-store.ts`, add `pid` and `host_pid` to the `RunRow` interface (after `result: string | null;`):

```ts
  pid: number | null;
  host_pid: number | null;
```

Then add two methods to the `RunStore` class, after `finish()`:

```ts
  setPid(id: string, pid: number, hostPid: number): void {
    this.db
      .prepare(`UPDATE runs SET pid = @pid, host_pid = @hostPid WHERE id = @id`)
      .run({ id, pid, hostPid });
  }

  /** Terminal-cancel a run. No-op if it already reached a terminal status, so a
   *  kill racing a natural exit never rewrites the real outcome. */
  cancel(id: string, reason?: string): void {
    this.db
      .prepare(
        `UPDATE runs SET status = 'cancelled', ended_at = @now, result = COALESCE(@reason, result)
         WHERE id = @id AND status IN ('queued', 'running', 'paused')`
      )
      .run({ id, now: Date.now(), reason: reason ?? null });
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/subagents/src/__tests__/run-store.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 7: Verify the migration applies to an existing DB**

Run:
```bash
cd /Users/dev/src/spider && npx vitest run packages/db-core
```
Expected: PASS. The migration path is exercised by db-core's existing migrate tests; if none covers v3→v4, they still must not regress.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add packages/db-core/src/schema.ts packages/db-core/src/migrate.ts packages/subagents/src/run-store.ts packages/subagents/src/__tests__/run-store.test.ts
git commit -m "feat(subagents): persist child pid + owning host_pid on runs; add RunStore.cancel

Schema v4. cancel() is guarded to non-terminal statuses so a kill racing a
natural exit never rewrites the real outcome."
```

---

### Task 2: Process-group kill primitives

**Files:**
- Create: `packages/subagents/src/kill-process.ts`
- Test: `packages/subagents/src/__tests__/kill-process.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isProcessAlive(pid: number): boolean`
  - `killProcessGroup(pid: number, opts?: { graceMs?: number; kill?: (pid: number, sig: NodeJS.Signals | number) => void; platform?: string }): Promise<"terminated" | "forced" | "already-dead">`

**Why a separate file:** these are pure OS primitives with no DB or run knowledge, so they can be unit-tested with an injected `kill` spy instead of real processes.

- [ ] **Step 1: Write the failing test**

Create `packages/subagents/src/__tests__/kill-process.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { isProcessAlive, killProcessGroup } from "../kill-process";

describe("isProcessAlive", () => {
  it("is true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("is false for an implausible pid", () => {
    expect(isProcessAlive(2_147_483_600)).toBe(false);
  });
});

describe("killProcessGroup", () => {
  it("reports already-dead when the first signal throws ESRCH", async () => {
    const kill = vi.fn(() => { const e: any = new Error("no such process"); e.code = "ESRCH"; throw e; });
    const res = await killProcessGroup(123, { kill, platform: "darwin", graceMs: 1 });
    expect(res).toBe("already-dead");
  });

  it("sends SIGTERM to the negative pid on unix", async () => {
    const kill = vi.fn();
    // Dies after the SIGTERM: the liveness probe (signal 0) throws ESRCH.
    kill.mockImplementationOnce(() => {})
        .mockImplementation(() => { const e: any = new Error("gone"); e.code = "ESRCH"; throw e; });
    const res = await killProcessGroup(123, { kill, platform: "darwin", graceMs: 5 });
    expect(kill).toHaveBeenCalledWith(-123, "SIGTERM");
    expect(res).toBe("terminated");
  });

  it("escalates to SIGKILL when the process survives the grace period", async () => {
    const kill = vi.fn(); // never throws => always alive
    const res = await killProcessGroup(123, { kill, platform: "darwin", graceMs: 5 });
    expect(kill).toHaveBeenCalledWith(-123, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-123, "SIGKILL");
    expect(res).toBe("forced");
  });

  it("uses the positive pid on win32 (no process groups)", async () => {
    const kill = vi.fn();
    await killProcessGroup(123, { kill, platform: "win32", graceMs: 5 });
    expect(kill).toHaveBeenCalledWith(123, "SIGTERM");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/subagents/src/__tests__/kill-process.test.ts`
Expected: FAIL — cannot resolve `../kill-process`.

- [ ] **Step 3: Implement the primitives**

Create `packages/subagents/src/kill-process.ts`:

```ts
/** OS-level process-group termination. No DB or run knowledge — pure primitives so
 *  they can be unit-tested with an injected `kill` instead of real processes.
 *  Mirrors the proven approach in packages/context/src/executor.ts (killTree). */

export type KillOutcome = "terminated" | "forced" | "already-dead";

export interface KillOpts {
  /** Grace period between SIGTERM and SIGKILL. */
  graceMs?: number;
  /** Injected for tests; defaults to process.kill. */
  kill?: (pid: number, sig: NodeJS.Signals | number) => void;
  /** Injected for tests; defaults to process.platform. */
  platform?: string;
}

const DEFAULT_GRACE_MS = 3000;

/** Liveness probe: signal 0 checks permission+existence without delivering a signal. */
export function isProcessAlive(pid: number, kill: (p: number, s: NodeJS.Signals | number) => void = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means it exists but belongs to another user — still alive.
    return (err as { code?: string })?.code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  (t as unknown as { unref?: () => void }).unref?.();
});

/**
 * SIGTERM the process group, wait `graceMs`, then SIGKILL if still alive.
 * On Unix the target is `-pid` (the whole group, so the child's own tool
 * subprocesses die too). Windows has no process groups, so the positive pid is
 * used and the caller is expected to have spawned without `detached`.
 */
export async function killProcessGroup(pid: number, opts: KillOpts = {}): Promise<KillOutcome> {
  const kill = opts.kill ?? process.kill;
  const platform = opts.platform ?? process.platform;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const target = platform === "win32" ? pid : -pid;

  try {
    kill(target, "SIGTERM");
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "ESRCH") return "already-dead";
    throw err;
  }

  await sleep(graceMs);

  // Probe the LEADER pid, not the group: a group probe reports alive while any
  // member lingers, and the leader is what the run row records.
  if (!isProcessAlive(pid, kill)) return "terminated";

  try {
    kill(target, "SIGKILL");
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "ESRCH") return "terminated";
    throw err;
  }
  return "forced";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/subagents/src/__tests__/kill-process.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add packages/subagents/src/kill-process.ts packages/subagents/src/__tests__/kill-process.test.ts
git commit -m "feat(subagents): process-group kill primitives (SIGTERM -> grace -> SIGKILL)"
```

---

### Task 3: Spawn children detached and retain their handles

**Files:**
- Modify: `packages/subagents/src/spawn-default.ts`
- Modify: `packages/subagents/src/coordinators.ts`
- Modify: `packages/subagents/src/runner.ts:96-125` (`runAsync`)
- Test: `packages/subagents/src/__tests__/coordinators.test.ts`
- Test: `packages/subagents/src/__tests__/spawn-default.test.ts`

**Interfaces:**
- Consumes: `RunStore.setPid` (Task 1).
- Produces:
  - `SessionCoordinators` gains `children: Map<string, ChildHandle>`.
  - `registerChild(sessionId: string, runId: string, handle: ChildHandle): void`
  - `unregisterChild(sessionId: string, runId: string): void`
  - `getChild(sessionId: string, runId: string): ChildHandle | undefined`
  - `listChildSessions(): string[]`
  - `Runner.runAsync` persists the pid and registers the handle before detaching.

**Critical:** `runner.ts:120` currently calls `handle.detach()` and drops the handle. That is the bug this task fixes.

- [ ] **Step 1: Write the failing test**

Append to `packages/subagents/src/__tests__/coordinators.test.ts`:

```ts
import { registerChild, unregisterChild, getChild, getCoordinators, teardownAll } from "../coordinators";
import type { ChildHandle } from "../runner";

describe("child handle registry", () => {
  const fakeHandle = (): ChildHandle & { killed: boolean } => {
    const h = { pid: 111, killed: false, wait: async () => ({ exitCode: 0 }), kill() { h.killed = true; }, detach() {} };
    return h as ChildHandle & { killed: boolean };
  };

  it("registers and retrieves a child handle by session + run", () => {
    const h = fakeHandle();
    registerChild("sess-a", "run-1", h);
    expect(getChild("sess-a", "run-1")).toBe(h);
  });

  it("unregisters a child handle", () => {
    registerChild("sess-b", "run-2", fakeHandle());
    unregisterChild("sess-b", "run-2");
    expect(getChild("sess-b", "run-2")).toBeUndefined();
  });

  it("does not leak handles across sessions", () => {
    registerChild("sess-c", "run-3", fakeHandle());
    expect(getChild("sess-d", "run-3")).toBeUndefined();
  });

  it("teardownAll kills every registered child", () => {
    const h1 = fakeHandle();
    const h2 = fakeHandle();
    registerChild("sess-e", "run-4", h1);
    registerChild("sess-e", "run-5", h2);
    teardownAll();
    expect(h1.killed).toBe(true);
    expect(h2.killed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/subagents/src/__tests__/coordinators.test.ts`
Expected: FAIL — `registerChild` is not exported.

- [ ] **Step 3: Extend the coordinator registry**

Rewrite `packages/subagents/src/coordinators.ts`:

```ts
import type { RunEventTailer } from "./event-tailer";
import type { PipelineCoordinator } from "./pipeline";
import type { ChildHandle } from "./runner";

export interface SessionCoordinators {
  tailer: RunEventTailer;
  pipelines: PipelineCoordinator[];
  /** Live child handles by runId — the in-process fast path for kill, and what
   *  session_shutdown iterates so quitting the session kills its subagents. */
  children: Map<string, ChildHandle>;
}

// Module-scoped registry — one extension activation owns it; NO globalThis singletons.
const registry = new Map<string, SessionCoordinators>();

export function getCoordinators(sessionId: string, make: () => SessionCoordinators): SessionCoordinators {
  let c = registry.get(sessionId);
  if (!c) {
    c = make();
    c.children ??= new Map();
    registry.set(sessionId, c);
    return c;
  }
  // A slot() created by registerChild() before the first `run` has NO tailer. Returning it
  // as-is would permanently suppress tailer creation for the session (make() is never called
  // again), silently killing the live agent feed. Upgrade the slot in place instead, keeping
  // any children already registered against it.
  if (!c.tailer) {
    const made = make();
    c.tailer = made.tailer;
    if (made.pipelines.length) c.pipelines.push(...made.pipelines);
  }
  c.children ??= new Map();
  return c;
}

/** Coordinators for a session that may not have a tailer yet — used by the child
 *  registry, which must work even before the first `run` builds a full coordinator.
 *  Any slot this creates is upgraded by the next getCoordinators() call. */
function slot(sessionId: string): SessionCoordinators {
  let c = registry.get(sessionId);
  if (!c) {
    c = { tailer: undefined as unknown as RunEventTailer, pipelines: [], children: new Map() };
    registry.set(sessionId, c);
  }
  c.children ??= new Map();
  return c;
}

export function registerChild(sessionId: string, runId: string, handle: ChildHandle): void {
  slot(sessionId).children.set(runId, handle);
}

export function unregisterChild(sessionId: string, runId: string): void {
  registry.get(sessionId)?.children?.delete(runId);
}

export function getChild(sessionId: string, runId: string): ChildHandle | undefined {
  return registry.get(sessionId)?.children?.get(runId);
}

export function listChildSessions(): string[] {
  return [...registry.keys()];
}

export function teardownCoordinators(sessionId: string): void {
  const c = registry.get(sessionId);
  if (!c) return;
  // Kill children FIRST: the tailer is what surfaces their final events, and a
  // stopped tailer would swallow them.
  for (const [, h] of c.children ?? []) { try { h.kill(); } catch {} }
  c.children?.clear();
  try { c.tailer?.stop(); } catch {}
  for (const p of c.pipelines) { try { p.dispose(); } catch {} }
  registry.delete(sessionId);
}

export function teardownAll(): void {
  for (const id of [...registry.keys()]) teardownCoordinators(id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/subagents/src/__tests__/coordinators.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for detached spawning**

Append to `packages/subagents/src/__tests__/spawn-default.test.ts`:

```ts
it("spawns unix children detached so they own a process group", async () => {
  const calls: any[] = [];
  vi.doMock("node:child_process", () => ({
    spawn: (...a: any[]) => {
      calls.push(a);
      return { pid: 1, on: () => {}, unref: () => {}, kill: () => {} };
    },
  }));
  vi.resetModules();
  const { defaultSpawner } = await import("../spawn-default");
  defaultSpawner({ argv: ["pi", "-p"], env: {}, cwd: "/tmp-not-used", sessionFile: "s" } as any);
  const opts = calls[0][2];
  expect(opts.detached).toBe(process.platform !== "win32");
  vi.doUnmock("node:child_process");
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/subagents/src/__tests__/spawn-default.test.ts`
Expected: FAIL — `expected undefined to be true`.

- [ ] **Step 7: Spawn detached and kill the group**

Rewrite `packages/subagents/src/spawn-default.ts`:

```ts
import { spawn } from "node:child_process";
import type { Spawner, ChildHandle } from "./runner";
import { killProcessGroup } from "./kill-process";

const isWin = process.platform === "win32";

/** Real child-process spawner (production). NOT exercised in unit tests, which inject a fake. */
export const defaultSpawner: Spawner = (spec): ChildHandle => {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: "ignore",
    // On Unix give the child its OWN process group, so killing it also kills every
    // tool subprocess IT spawned. Without this, kill() signals only `pi` and orphans
    // the rest. Mirrors packages/context/src/executor.ts.
    detached: !isWin,
  });
  // Attach 'exit'/'error' listeners EAGERLY (not lazily in wait()): runner.runAsync
  // detaches without ever calling wait(), so a lazy 'error' listener would leave an
  // async ENOENT unhandled → uncaught exception that crashes the host. Eager attachment
  // guarantees a handler on every path; the memoized promise settles once (idempotent).
  let settle!: (v: { exitCode: number; result?: string }) => void;
  const exit = new Promise<{ exitCode: number; result?: string }>((res) => { settle = res; });
  child.on("exit", (code) => settle({ exitCode: code ?? 0 }));
  child.on("error", () => settle({ exitCode: 1 }));
  return {
    pid: child.pid,
    wait() { return exit; },
    kill() {
      if (child.pid === undefined) return;
      // Fire-and-forget: kill() is sync by contract (session_shutdown calls it), but
      // the SIGTERM→SIGKILL escalation is inherently async.
      void killProcessGroup(child.pid).catch(() => { /* best-effort */ });
    },
    detach() { child.unref(); },
  };
};
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run packages/subagents/src/__tests__/spawn-default.test.ts`
Expected: PASS.

- [ ] **Step 9: Retain the handle and persist the pid in runAsync**

In `packages/subagents/src/runner.ts`, add to the imports at the top:

```ts
import { registerChild, unregisterChild } from "./coordinators";
```

Then in `runAsync`, replace the block from `const handle = this.spawnFor(run, opts);` through `handle.detach();` with:

```ts
    const handle = this.spawnFor(run, opts);
    // Retain the handle (in-process fast path for kill + session_shutdown teardown) and
    // persist the pid (fallback path after a host reload, when the map is empty but the
    // child is still alive). Previously the handle was detached and DROPPED, which is
    // why killing a subagent meant hunting the pi process by hand.
    registerChild(this.sessionId, run.id, handle);
    if (handle.pid !== undefined) {
      try { this.deps.store.setPid(run.id, handle.pid, process.pid); } catch { /* best-effort */ }
    }
    // Finalize the row on child EXIT even if the child-reporter missed session_shutdown
    // (headless/killed children) — otherwise the run is stuck "running" in the UI.
    void handle.wait().then(({ exitCode, result }) => {
      unregisterChild(this.sessionId, run.id);
      const cur = this.deps.store.get(run.id);
      let status: RunStatus;
      if (cur && (cur.status === "running" || cur.status === "queued")) {
        // Child never finalized its own row (headless/killed) — the parent finalizes it.
        status = exitCode === 0 ? "done" : "failed";
        this.deps.store.finish(run.id, { status, result });
        emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status, summary: run.name ?? undefined });
      } else {
        // Child already finalized the row (fast clean exit, or a kill that cancelled it)
        // — honour its terminal status.
        status = (cur?.status as RunStatus) ?? (exitCode === 0 ? "done" : "failed");
      }
      // Async completion notification: let the parent agent (and human) know a background
      // subagent finished. Fired EXACTLY ONCE per child exit, whether the parent or the child
      // finalized the row. A CANCELLED run is a deliberate stop — the notifier suppresses it
      // (see makeAsyncNotifier), so killing an agent does not wake the orchestrator.
      this.deps.onComplete?.(this.deps.store.get(run.id) ?? run, status, result);
    }).catch(() => { /* best-effort finalize */ });
    handle.detach();
    return this.deps.store.get(run.id)!;
```

- [ ] **Step 10: Run the full subagents suite**

Run: `npx vitest run packages/subagents`
Expected: PASS. If `modes.test.ts` or `e2e-async.test.ts` fail because their fake spawner lacks `pid`, add `pid: 1` to the fake handle — do not weaken the production path.

- [ ] **Step 11: Typecheck and commit**

```bash
npm run typecheck
git add packages/subagents/src/spawn-default.ts packages/subagents/src/coordinators.ts packages/subagents/src/runner.ts packages/subagents/src/__tests__/
git commit -m "feat(subagents): detached children + retained handle registry

runAsync detached the ChildHandle and dropped it, so nothing could kill a
running subagent. Children now own a process group (so their tool subprocesses
die with them), their handle is retained per-session, and their pid is
persisted for the post-reload fallback path."
```

---

### Task 4: Resolve a kill target and kill it

**Files:**
- Create: `packages/subagents/src/kill.ts`
- Test: `packages/subagents/src/__tests__/kill.test.ts`

**Interfaces:**
- Consumes: `RunStore` (`get`, `cancel`, `listActive`), `killProcessGroup`/`isProcessAlive` (Task 2), `getChild`/`unregisterChild` (Task 3).
- Produces:
  - `resolveKillTargets(store: RunStore, sessionId: string, id: string): RunRow[]`
  - `killRun(deps: KillDeps, sessionId: string, run: RunRow): Promise<KillResult>`
  - `interface KillResult { runId: string; name: string; outcome: "killed" | "already-finished" | "no-process"; via: "handle" | "pid" | "none"; lastActivity?: string; }`
  - `interface KillDeps { store: RunStore; db: Db; getChild?: typeof getChild; kill?: typeof killProcessGroup; alive?: typeof isProcessAlive; }`

**Target grammar:** `"all"` → every active run for the session; otherwise exact id, then unique id-prefix, then exact name, then unique name-prefix. Ambiguous prefixes throw with the candidates listed.

- [ ] **Step 1: Write the failing test**

Create `packages/subagents/src/__tests__/kill.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { RunStore } from "../run-store";
import { resolveKillTargets, killRun } from "../kill";
import { freshDb } from "./helpers/testutil";

function seed() {
  const db = freshDb();
  const store = new RunStore(db);
  // NOTE: alpha-build and alpha-review deliberately SHARE the "alpha" prefix so the
  // ambiguity branch is reachable; beta-review is the unique-name control.
  const a = store.create({ sessionId: "s1", agent: "worker", name: "alpha-build", task: "t" });
  const b = store.create({ sessionId: "s1", agent: "worker", name: "beta-review", task: "t" });
  const c = store.create({ sessionId: "s1", agent: "worker", name: "alpha-review", task: "t" });
  store.start(a.id); store.start(b.id); store.start(c.id);
  return { db, store, a, b, c };
}

describe("resolveKillTargets", () => {
  it("resolves 'all' to every active run in the session", () => {
    const { store } = seed();
    expect(resolveKillTargets(store, "s1", "all")).toHaveLength(3);
  });

  it("resolves an exact run id", () => {
    const { store, a } = seed();
    const [row] = resolveKillTargets(store, "s1", a.id);
    expect(row.id).toBe(a.id);
  });

  it("resolves a unique id prefix", () => {
    const { store, a } = seed();
    const [row] = resolveKillTargets(store, "s1", a.id.slice(0, 8));
    expect(row.id).toBe(a.id);
  });

  it("prefers an exact name over a prefix match", () => {
    const { store, b } = seed();
    const [row] = resolveKillTargets(store, "s1", "beta-review");
    expect(row.id).toBe(b.id);
  });

  it("throws naming every candidate when a name prefix is ambiguous", () => {
    const { store } = seed();
    // "alpha" matches BOTH alpha-build and alpha-review.
    expect(() => resolveKillTargets(store, "s1", "alpha")).toThrow(/ambiguous/i);
    expect(() => resolveKillTargets(store, "s1", "alpha")).toThrow(/alpha-build/);
    expect(() => resolveKillTargets(store, "s1", "alpha")).toThrow(/alpha-review/);
  });

  it("throws asking for an id when the target is empty", () => {
    const { store } = seed();
    expect(() => resolveKillTargets(store, "s1", "")).toThrow(/required/i);
  });

  it("throws when nothing matches", () => {
    const { store } = seed();
    expect(() => resolveKillTargets(store, "s1", "nope")).toThrow(/no active run/i);
  });

  it("ignores runs belonging to another session", () => {
    const { store } = seed();
    expect(() => resolveKillTargets(store, "other-session", "alpha-build")).toThrow(/no active run/i);
  });
});

describe("killRun", () => {
  it("kills via the live in-process handle when present", async () => {
    const { db, store, a } = seed();
    store.setPid(a.id, 555, process.pid);
    const handle = { pid: 555, killed: false, wait: async () => ({ exitCode: 0 }), kill() { handle.killed = true; }, detach() {} };
    const res = await killRun({ store, db, getChild: () => handle as any }, "s1", store.get(a.id)!);
    expect(handle.killed).toBe(true);
    expect(res.via).toBe("handle");
    expect(res.outcome).toBe("killed");
    expect(store.get(a.id)!.status).toBe("cancelled");
  });

  it("falls back to the persisted pid when no handle is registered", async () => {
    const { db, store, a } = seed();
    store.setPid(a.id, 777, 4242);
    const kill = vi.fn(async () => "terminated" as const);
    const res = await killRun(
      { store, db, getChild: () => undefined, kill, alive: () => true },
      "s1", store.get(a.id)!,
    );
    expect(kill).toHaveBeenCalledWith(777, expect.anything());
    expect(res.via).toBe("pid");
    expect(store.get(a.id)!.status).toBe("cancelled");
  });

  it("is a no-op for an already-finished run", async () => {
    const { db, store, a } = seed();
    store.finish(a.id, { status: "done", result: "ok" });
    const kill = vi.fn();
    const res = await killRun({ store, db, getChild: () => undefined, kill: kill as any }, "s1", store.get(a.id)!);
    expect(res.outcome).toBe("already-finished");
    expect(kill).not.toHaveBeenCalled();
    expect(store.get(a.id)!.status).toBe("done");
  });

  it("still cancels the row when the pid is already dead", async () => {
    const { db, store, a } = seed();
    store.setPid(a.id, 888, 4242);
    const res = await killRun(
      { store, db, getChild: () => undefined, alive: () => false },
      "s1", store.get(a.id)!,
    );
    expect(res.outcome).toBe("no-process");
    expect(store.get(a.id)!.status).toBe("cancelled");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/subagents/src/__tests__/kill.test.ts`
Expected: FAIL — cannot resolve `../kill`.

- [ ] **Step 3: Implement the kill module**

Create `packages/subagents/src/kill.ts`:

```ts
import type { Db } from "@spider/db-core";
import { RunStore, type RunRow } from "./run-store";
import { killProcessGroup, isProcessAlive } from "./kill-process";
import { getChild, unregisterChild } from "./coordinators";

export interface KillResult {
  runId: string;
  name: string;
  outcome: "killed" | "already-finished" | "no-process";
  via: "handle" | "pid" | "none";
  /** What the child was last doing — so a kill mid-`edit` is visible. */
  lastActivity?: string;
}

export interface KillDeps {
  store: RunStore;
  db: Db;
  getChild?: (sessionId: string, runId: string) => { kill(): void } | undefined;
  kill?: (pid: number, opts?: unknown) => Promise<"terminated" | "forced" | "already-dead">;
  alive?: (pid: number) => boolean;
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/**
 * Resolve a user-supplied target to concrete runs.
 * Grammar: "all" | exact id | unique id prefix | exact name | unique name prefix.
 * Only ACTIVE runs are considered — killing a finished run is meaningless.
 */
export function resolveKillTargets(store: RunStore, sessionId: string, id: string): RunRow[] {
  const active = store.listActive(sessionId);
  const target = (id ?? "").trim();
  if (target === "all") return active;
  if (!target) throw new Error("kill: `id` is required (a run id, id prefix, name, or \"all\")");

  const exactId = active.find((r) => r.id === target);
  if (exactId) return [exactId];

  const exactName = active.find((r) => r.name === target);
  if (exactName) return [exactName];

  const byPrefix = active.filter((r) => r.id.startsWith(target) || (r.name ?? "").startsWith(target));
  if (byPrefix.length === 1) return byPrefix;
  if (byPrefix.length > 1) {
    const names = byPrefix.map((r) => `${r.name ?? r.agent} (${r.id.slice(0, 8)})`).join(", ");
    throw new Error(`kill: "${target}" is ambiguous — matches ${byPrefix.length} runs: ${names}`);
  }
  throw new Error(`kill: no active run matches "${target}"`);
}

/** The child's most recent meaningful activity, for the kill report.
 *  There is NO listRunEvents helper — `run_events` is queried inline, the same
 *  shape packages/host/src/agents/run-source.ts uses for the detail view. */
function lastActivityOf(db: Db, runId: string): string | undefined {
  try {
    const row = db
      .prepare(
        `SELECT summary FROM run_events
         WHERE run_id = ? AND type IN ('tool_intent','tool_result') AND summary IS NOT NULL
         ORDER BY ts DESC, id DESC LIMIT 1`
      )
      .get(runId) as { summary?: string } | undefined;
    return row?.summary ?? undefined;
  } catch {
    return undefined; // best-effort: a kill must never fail on its own report
  }
}

/**
 * Kill one run. Prefers the live in-process handle; falls back to the persisted
 * pid so children orphaned by a host reload are still killable. The run row is
 * marked `cancelled` on every path that actually stopped (or found already
 * stopped) a process, so the UI never leaves a dead run showing "running".
 */
export async function killRun(deps: KillDeps, sessionId: string, run: RunRow): Promise<KillResult> {
  const name = run.name ?? run.agent;
  if (TERMINAL.has(run.status)) {
    return { runId: run.id, name, outcome: "already-finished", via: "none" };
  }

  const lastActivity = lastActivityOf(deps.db, run.id);
  const child = (deps.getChild ?? getChild)(sessionId, run.id);

  if (child) {
    try { child.kill(); } catch { /* best-effort */ }
    unregisterChild(sessionId, run.id);
    deps.store.cancel(run.id, `killed (was: ${lastActivity ?? "no recorded activity"})`);
    return { runId: run.id, name, outcome: "killed", via: "handle", lastActivity };
  }

  const pid = run.pid ?? undefined;
  const aliveFn = deps.alive ?? isProcessAlive;
  if (pid === undefined || !aliveFn(pid)) {
    // No process to signal (never spawned, or already gone) — reconcile the row.
    deps.store.cancel(run.id, `cancelled — no live process (was: ${lastActivity ?? "no recorded activity"})`);
    return { runId: run.id, name, outcome: "no-process", via: "none", lastActivity };
  }

  const killFn = deps.kill ?? killProcessGroup;
  try { await killFn(pid); } catch { /* best-effort */ }
  deps.store.cancel(run.id, `killed via pid ${pid} (was: ${lastActivity ?? "no recorded activity"})`);
  return { runId: run.id, name, outcome: "killed", via: "pid", lastActivity };
}
```

- [ ] **Step 4: Sanity-check the `run_events` column names**

Run: `grep -n "run_events" -A4 packages/db-core/src/schema.ts`
Expected: columns `run_id`, `session_id`, `ts`, `type`, `tool`, `summary`, `payload` — matching the query in `lastActivityOf`. That query is inline precisely because **no `listRunEvents` helper exists**: `run-events.ts` exports only `emit*` functions, and db-core's `listEvents` targets the different `events` table.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/subagents/src/__tests__/kill.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add packages/subagents/src/kill.ts packages/subagents/src/__tests__/kill.test.ts
git commit -m "feat(subagents): kill target resolution + handle/pid kill paths

Resolves 'all' | id | id-prefix | name | name-prefix, kills via the live handle
when present and the persisted pid otherwise, and records what the child was
last doing so a kill mid-edit is visible."
```

---

### Task 5: Suppress the completion notifier for cancelled runs

**Files:**
- Modify: `packages/subagents/src/actions/run.ts:15-42` (`makeAsyncNotifier`)
- Test: `packages/subagents/src/__tests__/async-notifier.test.ts`

**Interfaces:**
- Consumes: `RunStatus` including `"cancelled"` (Task 1).
- Produces: `makeAsyncNotifier` returns early for `status === "cancelled"`.

**Why:** killing an agent must not fire `triggerTurn: true` and wake the orchestrator with a "subagent done" card. A deliberate stop is not a completion.

- [ ] **Step 1: Write the failing test**

Append to `packages/subagents/src/__tests__/async-notifier.test.ts`:

```ts
it("does not notify or trigger a turn for a cancelled run", () => {
  const sendMessage = vi.fn();
  const notify = vi.fn();
  const ctx: any = { db: freshDb(), pi: { sendMessage }, ui: { notify } };
  const notifier = makeAsyncNotifier(ctx);
  notifier({ id: "r1", name: "alpha", agent: "worker" } as any, "cancelled", undefined);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

it("still notifies for a failed run", () => {
  const sendMessage = vi.fn();
  const notify = vi.fn();
  const ctx: any = { db: freshDb(), pi: { sendMessage }, ui: { notify } };
  const notifier = makeAsyncNotifier(ctx);
  notifier({ id: "r2", name: "beta", agent: "worker" } as any, "failed", undefined);
  expect(sendMessage).toHaveBeenCalled();
});
```

Ensure the file imports `makeAsyncNotifier` from `../actions/run`, `vi` from `vitest`, and `freshDb` from `./helpers/testutil`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/subagents/src/__tests__/async-notifier.test.ts`
Expected: FAIL — `sendMessage` was called for the cancelled run.

- [ ] **Step 3: Add the early return**

In `packages/subagents/src/actions/run.ts`, at the very top of the returned function inside `makeAsyncNotifier`:

```ts
  return (run, status, result) => {
    // A cancelled run was killed deliberately. Waking the orchestrator with a
    // "subagent done" card + triggerTurn for something the user just stopped is
    // noise — the kill action already reported the outcome.
    if (status === "cancelled") return;
    try {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/subagents/src/__tests__/async-notifier.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add packages/subagents/src/actions/run.ts packages/subagents/src/__tests__/async-notifier.test.ts
git commit -m "fix(subagents): cancelled runs do not fire the completion notifier"
```

---

### Task 6: The `kill` action and its themed renderer

**Files:**
- Create: `packages/subagents/src/actions/kill.ts`
- Create: `packages/ui/src/renderers/kill.ts`
- Modify: `packages/ui/src/index.ts:104` (export the renderer)
- Modify: `packages/subagents/src/index.ts` (register the action)
- Modify: `packages/host/src/extension.ts:119-122` (action enum) and `:180` (param docs)
- Test: `packages/subagents/src/__tests__/actions.test.ts`
- Test: `packages/ui/src/__tests__/kill-renderer.test.ts`

**Interfaces:**
- Consumes: `resolveKillTargets`, `killRun`, `KillResult` (Task 4).
- Produces:
  - `makeKillHandler(): (args, ctx) => Promise<{ content: string; isError?: boolean; details: KillDetails }>`
  - `interface KillDetails { killed: KillResult[]; requested: string }`
  - `renderKillResult(details: KillDetails, ctx: RenderCtx): string[]`
  - Tool surface: `spider action="kill" id="<runId|prefix|name|all>"`.

- [ ] **Step 1: Write the failing test**

Append to `packages/subagents/src/__tests__/actions.test.ts`:

```ts
import { makeKillHandler } from "../actions/kill";

describe("kill action", () => {
  it("kills all active runs and reports each", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const a = store.create({ sessionId: "s1", agent: "worker", name: "alpha", task: "t" });
    const b = store.create({ sessionId: "s1", agent: "worker", name: "beta", task: "t" });
    store.start(a.id); store.start(b.id);
    const handler = makeKillHandler();
    const res = await handler({ id: "all" }, { db, sessionId: "s1" });
    expect(res.details.killed).toHaveLength(2);
    expect(store.get(a.id)!.status).toBe("cancelled");
    expect(store.get(b.id)!.status).toBe("cancelled");
  });

  it("reports 'no active subagents' rather than erroring when none are running", async () => {
    const db = freshDb();
    const handler = makeKillHandler();
    const res = await handler({ id: "all" }, { db, sessionId: "s1" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/no active subagents/i);
  });

  it("returns an error result for an unmatched target instead of throwing", async () => {
    const db = freshDb();
    const handler = makeKillHandler();
    const res = await handler({ id: "ghost" }, { db, sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/no active run/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/subagents/src/__tests__/actions.test.ts`
Expected: FAIL — cannot resolve `../actions/kill`.

- [ ] **Step 3: Implement the action handler**

Create `packages/subagents/src/actions/kill.ts`:

```ts
import { RunStore } from "../run-store";
import { resolveKillTargets, killRun, type KillResult } from "../kill";

export interface KillDetails { killed: KillResult[]; requested: string }

/** The `kill` action handler. Resolves a target to runs and terminates each. */
export function makeKillHandler(): (args: any, ctx: any) => Promise<{ content: string; isError?: boolean; details: KillDetails }> {
  return async function killHandler(args: any, ctx: any) {
    const store = new RunStore(ctx.db);
    const requested = String(args?.id ?? "");
    let targets;
    try {
      targets = resolveKillTargets(store, ctx.sessionId, requested);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: message, isError: true, details: { killed: [], requested } };
    }
    if (targets.length === 0) {
      return { content: "no active subagents to kill", details: { killed: [], requested } };
    }
    const killed: KillResult[] = [];
    for (const run of targets) {
      killed.push(await killRun({ store, db: ctx.db }, ctx.sessionId, run));
    }
    const lines = killed.map((k) => `  • ${k.name} — ${k.outcome}${k.via !== "none" ? ` (via ${k.via})` : ""}`).join("\n");
    return { content: `killed ${killed.length} subagent(s)\n${lines}`, details: { killed, requested } };
  };
}
```

- [ ] **Step 4: Register the action**

In `packages/subagents/src/index.ts`, add the import and export, then register:

```ts
import { makeKillHandler } from "./actions/kill";
```

Add `makeKillHandler` to the existing `export { makeRunHandler, makeMessageHandler };` line so it reads:

```ts
export { makeRunHandler, makeMessageHandler, makeKillHandler };
```

And inside `registerSubagentActions`, after the `message` registration:

```ts
  host.registerAction("kill", makeKillHandler());
```

Also add `export * from "./kill";` and `export * from "./kill-process";` to the top-level re-exports.

- [ ] **Step 5: Add `kill` to the tool schema**

In `packages/host/src/extension.ts`, extend the action enum (around line 119) to include `"kill"`:

```ts
        "search", "remember", "recall", "exec", "exec_file", "batch",
        "index", "fetch", "run", "kill", "todo", "skill", "import", "message", "control",
```

Then update the `id` parameter description (around line 180) so the model learns the grammar:

```ts
    id: { type: "string", description: "Run id/prefix (also a todo id). For action 'kill': a run id, id prefix, run name, or \"all\" to kill every active subagent in this session." },
```

- [ ] **Step 6: Run the action test**

Run: `npx vitest run packages/subagents/src/__tests__/actions.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing renderer test**

Create `packages/ui/src/__tests__/kill-renderer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderKillResult } from "../renderers/kill";

const theme = { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s, bold: (s: string) => s, glyph: "🕸" };
const ctx = { theme, width: 80 } as any;

describe("renderKillResult", () => {
  it("renders one line per killed run with its outcome", () => {
    const out = renderKillResult(
      { requested: "all", killed: [
        { runId: "r1", name: "alpha", outcome: "killed", via: "handle", lastActivity: "edit src/a.ts" },
        { runId: "r2", name: "beta", outcome: "already-finished", via: "none" },
      ] },
      ctx,
    ).join("\n");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("edit src/a.ts");
  });

  it("renders an empty-target message without throwing", () => {
    expect(() => renderKillResult({ requested: "all", killed: [] }, ctx)).not.toThrow();
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/kill-renderer.test.ts`
Expected: FAIL — cannot resolve `../renderers/kill`.

- [ ] **Step 9: Implement the renderer**

Create `packages/ui/src/renderers/kill.ts`:

```ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "./types.js";
import type { RenderCtx } from "./types.js";

export interface KillResultLine {
  runId: string;
  name: string;
  outcome: "killed" | "already-finished" | "no-process";
  via: "handle" | "pid" | "none";
  lastActivity?: string;
}
export interface KillDetails { killed: KillResultLine[]; requested: string }

/** RESULT body (no header — the spider call line already shows `🕸 spider · kill`). */
export function renderKillResult(details: KillDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const rows = details.killed ?? [];
  if (rows.length === 0) {
    return ["", truncateToWidth(` ${theme.fg("muted", "no active subagents to kill")}`, width, "")];
  }
  const out: string[] = [""];
  for (const r of rows) {
    const ok = r.outcome === "killed";
    const icon = statusIcon(theme, ok ? "ok" : "fail");
    const via = r.via !== "none" ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", `via ${r.via}`)}` : "";
    out.push(truncateToWidth(
      ` ${icon} ${theme.bold(r.name)} ${theme.fg("dim", "·")} ${theme.fg(ok ? "warning" : "muted", r.outcome)}${via}`,
      width, "",
    ));
    if (r.lastActivity) {
      out.push(truncateToWidth(` ${theme.fg("dim", "⎿ ")}${theme.fg("toolOutput", `was: ${r.lastActivity}`)}`, width, ""));
    }
  }
  return out;
}
```

- [ ] **Step 10: Export the renderer and wire it in the host**

In `packages/ui/src/index.ts`, after the `renderMessageResult` export:

```ts
export { renderKillResult } from "./renderers/kill";
export type { KillDetails, KillResultLine } from "./renderers/kill";
```

In `packages/host/src/render-result.ts`, follow the existing per-action dispatch pattern (as done for `message`) and route `action === "kill"` to `renderKillResult(details, ctx)`. Match the surrounding code's exact structure — do not invent a new dispatch mechanism.

- [ ] **Step 11: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 12: Typecheck, build, and commit**

```bash
npm run typecheck && npm run build
git add -A packages/subagents packages/ui packages/host
git commit -m "feat(spider): 'kill' verb with themed result card

spider kill id:<runId|prefix|name|all> terminates active subagents in the
session and reports what each was last doing."
```

---

### Task 7: Reap orphans left by a crashed or SIGKILLed host

**Files:**
- Create: `packages/subagents/src/reaper.ts`
- Modify: `packages/subagents/src/index.ts` (call the reaper on `session_start`)
- Test: `packages/subagents/src/__tests__/reaper.test.ts`

**Interfaces:**
- Consumes: `RunStore`, `isProcessAlive`, `killProcessGroup`.
- Produces: `reapOrphanRuns(deps: { db: Db; store?: RunStore; alive?: (pid: number) => boolean; kill?: (pid: number) => Promise<unknown>; selfPid?: number }): Promise<{ reaped: string[] }>`

**Why:** per the spec's shutdown matrix, `uncaughtCrash`, `emergencyTerminalExit`, and `SIGKILL` never fire `session_shutdown`. Only a pid-based startup sweep can reconcile those.

**Critical correctness rule:** a run whose `host_pid` is *still alive* belongs to a **concurrently running session** and must be left alone. Only runs whose owning host is gone are reaped.

- [ ] **Step 1: Write the failing test**

Create `packages/subagents/src/__tests__/reaper.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { RunStore } from "../run-store";
import { reapOrphanRuns } from "../reaper";
import { freshDb } from "./helpers/testutil";

describe("reapOrphanRuns", () => {
  it("cancels a running run whose owning host is dead", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    store.setPid(id, 999, 12345);
    const res = await reapOrphanRuns({ db, alive: (pid) => pid === 999, kill: vi.fn(async () => {}), selfPid: 1 });
    expect(res.reaped).toContain(id);
    expect(store.get(id)!.status).toBe("cancelled");
  });

  it("kills the orphaned child process when it is still alive", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    store.setPid(id, 999, 12345);
    const kill = vi.fn(async () => {});
    await reapOrphanRuns({ db, alive: (pid) => pid === 999, kill, selfPid: 1 });
    expect(kill).toHaveBeenCalledWith(999);
  });

  it("LEAVES ALONE a run whose owning host is still alive", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    store.setPid(id, 999, 4242);
    const kill = vi.fn(async () => {});
    const res = await reapOrphanRuns({ db, alive: () => true, kill, selfPid: 1 });
    expect(res.reaped).toHaveLength(0);
    expect(kill).not.toHaveBeenCalled();
    expect(store.get(id)!.status).toBe("running");
  });

  it("ignores runs that never recorded a host pid", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    const res = await reapOrphanRuns({ db, alive: () => false, kill: vi.fn(async () => {}), selfPid: 1 });
    expect(res.reaped).toHaveLength(0);
    expect(store.get(id)!.status).toBe("running");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/subagents/src/__tests__/reaper.test.ts`
Expected: FAIL — cannot resolve `../reaper`.

- [ ] **Step 3: Implement the reaper**

Create `packages/subagents/src/reaper.ts`:

```ts
import type { Db } from "@spider/db-core";
import { RunStore, type RunRow } from "./run-store";
import { isProcessAlive, killProcessGroup } from "./kill-process";

export interface ReapDeps {
  db: Db;
  store?: RunStore;
  alive?: (pid: number) => boolean;
  kill?: (pid: number) => Promise<unknown>;
  selfPid?: number;
}

/**
 * Reconcile runs abandoned by a host that died without firing session_shutdown
 * (uncaughtCrash, emergencyTerminalExit, SIGKILL). A run is an ORPHAN only when
 * its owning host_pid is gone — a live host_pid means a concurrently running
 * session still owns that child, and touching it would kill another session's
 * work.
 */
export async function reapOrphanRuns(deps: ReapDeps): Promise<{ reaped: string[] }> {
  const store = deps.store ?? new RunStore(deps.db);
  const alive = deps.alive ?? isProcessAlive;
  const kill = deps.kill ?? ((pid: number) => killProcessGroup(pid));
  const selfPid = deps.selfPid ?? process.pid;
  const reaped: string[] = [];

  let rows: RunRow[];
  try {
    rows = deps.db
      .prepare(`SELECT * FROM runs WHERE status IN ('queued','running','paused') AND host_pid IS NOT NULL`)
      .all() as RunRow[];
  } catch {
    return { reaped }; // pre-v4 DB or read failure — never block session start
  }

  for (const row of rows) {
    const hostPid = row.host_pid;
    if (hostPid === null || hostPid === selfPid) continue; // ours, or unknown owner
    if (alive(hostPid)) continue;                          // another live session owns it

    if (row.pid !== null && alive(row.pid)) {
      try { await kill(row.pid); } catch { /* best-effort */ }
    }
    try {
      store.cancel(row.id, "cancelled — orphaned by a host that exited without shutdown");
      reaped.push(row.id);
    } catch { /* best-effort */ }
  }
  return { reaped };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/subagents/src/__tests__/reaper.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Call the reaper on session start**

In `packages/subagents/src/index.ts`, add the import:

```ts
import { reapOrphanRuns } from "./reaper";
```

Add `export * from "./reaper";` to the re-exports, then inside `registerSubagentActions`, after the `session_shutdown` registration:

```ts
  // Reap subagents orphaned by a host that died without firing session_shutdown
  // (crash / dead tty / SIGKILL). Best-effort and defensive: a reaper failure must
  // never block session start.
  try {
    pi?.on?.("session_start", (event: any) => {
      try {
        const dbPath = event?.spiderDbPath;
        if (!dbPath) return;
        void reapOrphanRuns({ db: openDbAt(dbPath, "project") }).catch(() => {});
      } catch { /* best-effort */ }
    });
  } catch { /* best-effort */ }
```

**Note for the implementer:** `registerSubagentActions` has no `ActionCtx` and must not import `@spider/host`. If no DB path is reachable from the `session_start` event, wire the reaper from `packages/host/src/hooks.ts`'s existing `session_start` handler instead — it already calls `resolveProject(cwd)` and `openProject(...)`, so pass that `Db` straight to `reapOrphanRuns`. **Prefer the hooks.ts route** unless the event genuinely carries a DB path; do not fabricate an event field.

- [ ] **Step 6: Run the full subagents + host suites**

Run: `npx vitest run packages/subagents packages/host`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add packages/subagents/src/reaper.ts packages/subagents/src/index.ts packages/subagents/src/__tests__/reaper.test.ts packages/host/src/hooks.ts
git commit -m "feat(subagents): reap subagents orphaned by a host that died without shutdown

Covers the crash / dead-tty / SIGKILL rows of the shutdown matrix, which never
fire session_shutdown. Runs whose host_pid is still alive belong to a
concurrently running session and are deliberately left alone."
```

---

### Task 8: `k`-`k` kill affordance in the agent detail view

**Files:**
- Modify: `packages/ui/src/agents/agent-detail.ts`
- Modify: `packages/ui/src/agents/types.ts:31-36` (`AgentActions`)
- Modify: `packages/host/src/agents/actions.ts`
- Modify: `packages/host/src/agents/agents-ui.ts:130-140` (the `drill` callback)
- Test: `packages/ui/src/__tests__/agent-detail.test.ts`

**Interfaces:**
- Consumes: the `kill` action (Task 6).
- Produces:
  - `AgentActions` gains `kill(runId: string): void | Promise<void>`.
  - `AgentDetail.onKill(fn: (runId: string) => void): void`
  - `AgentDetail.handleInput` returns `true` for `k` and arms/fires/disarms.

**Interaction contract:** first `k` arms and swaps the footer line to a warning; second `k` within 3000 ms fires; **any other key disarms**; the arm also times out after 3000 ms.

- [ ] **Step 1: Write the failing test**

Append to `packages/ui/src/__tests__/agent-detail.test.ts`:

```ts
describe("AgentDetail kill affordance", () => {
  // Reuses `Src` and `id` already defined at the TOP of this file. Do not
  // redefine them — the seeded run is keyed "r1".
  const mkDetail = (now: () => number) => {
    const store = new AgentStore(new Src());
    store.start();
    return new AgentDetail(store, "r1", id, { now });
  };

  it("first k arms and shows a confirmation prompt", () => {
    const d = mkDetail(() => 1000);
    const killed: string[] = [];
    d.onKill((runId) => killed.push(runId));
    expect(d.handleInput("k")).toBe(true);
    expect(d.render(60).join("\n")).toMatch(/press k again/i);
    expect(killed).toHaveLength(0);
  });

  it("second k within the window fires the kill", () => {
    let t = 1000;
    const d = mkDetail(() => t);
    const killed: string[] = [];
    d.onKill((runId) => killed.push(runId));
    d.handleInput("k");
    t = 2000;
    d.handleInput("k");
    expect(killed).toEqual(["r1"]);
  });

  it("an intervening key disarms", () => {
    const d = mkDetail(() => 1000);
    const killed: string[] = [];
    d.onKill((runId) => killed.push(runId));
    d.handleInput("k");
    d.handleInput("j");
    d.handleInput("k");
    expect(killed).toHaveLength(0);
    expect(d.render(60).join("\n")).toMatch(/press k again/i);
  });

  it("the arm expires after the timeout", () => {
    let t = 1000;
    const d = mkDetail(() => t);
    const killed: string[] = [];
    d.onKill((runId) => killed.push(runId));
    d.handleInput("k");
    t = 9999;
    d.handleInput("k");
    expect(killed).toHaveLength(0);
  });
});
```

`Src` implements only `listActive`/`getRun`/`subscribe` (no `listEvents`), so the
detail's conversation section renders its empty state — fine for these tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/agent-detail.test.ts`
Expected: FAIL — `d.onKill is not a function`.

- [ ] **Step 3: Implement the affordance**

In `packages/ui/src/agents/agent-detail.ts`, add two fields and the `onKill` registrar next to the existing `back` field:

```ts
  private kill?: (runId: string) => void;
  private armedAt?: number;
```

Add after `onBack`:

```ts
  onKill(fn: (runId: string) => void): void { this.kill = fn; }
```

Replace `handleInput` with:

```ts
  handleInput(data: string): boolean {
    if (matchesKey(data, Key.escape)) { this.armedAt = undefined; this.back?.(); return true; }
    if (data === "k") {
      const now = this.now();
      if (this.armedAt !== undefined && now - this.armedAt <= KILL_ARM_MS) {
        this.armedAt = undefined;
        this.kill?.(this.runId);
      } else {
        this.armedAt = now;
      }
      return true;
    }
    // Any other key disarms — a destructive action must never survive an
    // unrelated keystroke.
    this.armedAt = undefined;
    return false;
  }

  private isArmed(): boolean {
    return this.armedAt !== undefined && this.now() - this.armedAt <= KILL_ARM_MS;
  }
```

Add the constant at module scope, below the imports:

```ts
const KILL_ARM_MS = 3000;
```

Then in `render`, replace the final footer line of `body`:

```ts
      "", fit(t.fg("dim", "esc back to list")),
```

with:

```ts
      "", fit(this.isArmed()
        ? t.fg("error", `⚠ kill "${a.name}"? press k again to confirm`)
        : t.fg("dim", "esc back to list · k k to kill")),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/ui/src/__tests__/agent-detail.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `kill` to AgentActions**

In `packages/ui/src/agents/types.ts`, add to the `AgentActions` interface:

```ts
  kill(runId: string): void | Promise<void>;
```

- [ ] **Step 6: Wire the host action**

Rewrite `packages/host/src/agents/actions.ts`:

```ts
// packages/host/src/agents/actions.ts
import type { AgentActions } from "@spider/ui";

// `interrupt`/`resume`/`message` still have no per-run control surface in
// @spider/subagents and degrade to a toast. `kill` IS wired: it dispatches the
// spider `kill` action for the selected run.
export function createAgentActions(
  pi: unknown,
  ctx: {
    ui: { notify(t: string, level: "info" | "error"): void };
    dispatch?: (action: string, args: Record<string, unknown>) => Promise<unknown>;
  },
): AgentActions {
  const unavailable = (command: string) => {
    try {
      ctx.ui.notify(`agent ${command} unavailable`, "error");
    } catch { /* toast is best-effort; never throw from an interaction key */ }
  };
  return {
    message: () => unavailable("message"),
    interrupt: () => unavailable("interrupt"),
    resume: () => unavailable("resume"),
    follow: () => { /* UI-local pin; no runtime call */ },
    kill: async (runId: string) => {
      try {
        await ctx.dispatch?.("kill", { id: runId });
        ctx.ui.notify("subagent killed", "info");
      } catch (err) {
        ctx.ui.notify(`kill failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  };
}
```

- [ ] **Step 7: Wire `onKill` into the drill callback**

In `packages/host/src/agents/agents-ui.ts`, extend `Deps` with an optional actions factory:

```ts
interface Deps { db: Db; sessionId: string; width?: () => number; actions?: import("@spider/ui").AgentActions }
```

Then in the `drill` callback (around line 132), after `d.onBack(...)`:

```ts
            d.onKill((id) => {
              void deps.actions?.kill(id);
              detail = undefined;
              repaint();
            });
```

Confirm `installAgentsUI`'s caller in `extension.ts` passes `actions: createAgentActions(pi, ctx)` with a `dispatch` that routes to the registered `kill` action. Follow the existing dispatch wiring in `packages/host/src/dispatch.ts` — do not invent a parallel path.

- [ ] **Step 8: Run the full suite and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 9: Manual verification**

```bash
npm run link
```
Then in a fresh pi session:
1. `spider run agent:"worker" task:"sleep 300 using exec, then report"` — note the run name.
2. `ctrl+up` → select the agent → `Enter` → confirm the footer reads `esc back to list · k k to kill`.
3. Press `k` once — confirm the warning line appears.
4. Press `j` — confirm it disarms.
5. Press `k` `k` — confirm the agent disappears from the footer and shows `cancelled`.
6. `ps aux | grep "[p]i --mode json"` — confirm **no** orphaned child remains.
7. Start another agent, then `/quit` the session. Re-run the `ps` check — confirm the child died with the session.

- [ ] **Step 10: Commit**

```bash
git add -A packages/ui packages/host
git commit -m "feat(ui): k-k kill affordance in the agent detail view

First k arms and swaps the footer to a warning, second k within 3s kills, any
other key disarms. Wires AgentActions.kill through to the spider kill action."
```

---

## Self-Review

**Spec coverage** — every "Decision" item in Problem 3 maps to a task:

| Spec item | Task |
| --- | --- |
| Killable children (`detached`, SIGTERM→grace→SIGKILL) | 2, 3 |
| Handle registry in `SessionCoordinators` | 3 |
| Persist `pid` (post-reload fallback) | 1, 3 |
| Persist `host_pid` (reaper) | 1, 7 |
| Write `status='cancelled'` | 1, 4 |
| Notifier stays quiet for cancelled | 5 |
| Report what was interrupted | 4, 6 |
| First-class `spider kill` verb, `id` grammar | 4, 6 |
| `k`-`k` in `AgentDetail` | 8 |
| `session_shutdown` kills registered children | 3 |
| Startup orphan reaper | 7 |

**Known follow-ups deliberately out of scope** (they belong to Plans 2 and 3): the `runs.pid` column ships in schema v4 here, but the tiering migration in Plan 2 will re-key the `projects` registry — Plan 2 must bump to v5 and must not renumber v4.

**Type consistency check:** `KillResult` is defined once in `packages/subagents/src/kill.ts` and structurally mirrored as `KillResultLine` in the UI package (the UI package must not import from `@spider/subagents` — that would invert the dependency DAG). The two must stay field-identical: `runId`, `name`, `outcome`, `via`, `lastActivity`.

**Two steps still require the implementer to verify a real shape before coding**, rather than trusting this plan: Task 6 Step 10 (the `render-result.ts` per-action dispatch) and Task 7 Step 5 (the `session_start` DB path). Both are flagged inline.

**Corrected during self-review** — recorded so they are not reintroduced:
- `listRunEvents` **does not exist.** `run-events.ts` exports only `emit*` helpers, and db-core's `listEvents` targets the separate `events` table. `kill.ts` queries `run_events` inline, mirroring `packages/host/src/agents/run-source.ts`.
- `packages/ui/src/__tests__/agent-detail.test.ts` has no `makeStore()`/`theme` helpers. It defines `class Src implements RunSource` and `const id: ThemeAdapter`, and its seeded run is keyed `"r1"`. Task 8's tests use those names.
- `freshDb()` lives in `packages/subagents/src/__tests__/helpers/testutil.ts` and returns a project-scope DB under `.spider/scratch` — already correct in Tasks 1, 4, 6, 7.
- `statusIcon(theme, status)` accepts only `"ok" | "fail" | "warn" | "on" | "off" | "paused"`, and `RenderCtx` is `{ theme, width, expanded? }` — both used correctly in Task 6.
