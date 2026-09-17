import { describe, it, expect, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { Runner, type Spawner } from "../runner";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";
import { makeChildReporter } from "../child-reporter";
import { defaultSpawner } from "../spawn-default";
import { freshDb, testScratchPath } from "./helpers/testutil";

/** A real, existing directory under the test scratch root. The two REAL-defaultSpawner
 *  cases below actually `child_process.spawn` (see spawn-default.ts); now that Runner's
 *  resolved cwd is correctly threaded into the child spawn spec, a nonexistent literal
 *  path here would ENOENT instead of exercising the real spawn/completion contract. */
function realSpawnCwd(name: string): string {
  const dir = testScratchPath(name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Prior review (C1) established the production contract three ways:
//   1. defaultSpawner's wait() NEVER resolves with a `result` field — success or failure.
//   2. The child finalizes its own row via onShutdown("done") with NO result argument.
//   3. The real deliverable lives in run_events(type='message'), not RunRow.result.
// Every test below either uses the REAL child-reporter (no hand-written final result) or
// the REAL defaultSpawner (a real OS subprocess) — a fake that returns a hand-written
// final result would hide exactly the bug this file guards against.

const deps = (spawn: Spawner) => ({
  scratchRoot: testScratchPath("runner-completion-integrity-scratch"),
  dbPath: testScratchPath("runner-completion-integrity.db"),
  spawn,
});

/** A spawner whose wait() never resolves until the test says so — production shape
 *  (`{ exitCode }`, no `result` field). `ChildSpawnSpec` (pi-args.ts) does not carry the
 *  runId, so tests recover it by querying the store: `makeRun()` (store.create + get)
 *  runs synchronously before Runner ever calls the spawner, so the row already exists by
 *  the time `runForeground`/`runAsync` returns control to the caller. */
function delayedSpawn(): { spawn: Spawner; resolveWait: (v: { exitCode: number; result?: string }) => void } {
  let resolveWait!: (v: { exitCode: number; result?: string }) => void;
  const spawn: Spawner = () => ({ pid: process.pid, wait: () => new Promise((r) => { resolveWait = r; }), kill: () => {}, detach: () => {} });
  return { spawn, resolveWait: (v) => resolveWait(v) };
}

function onlyRunId(store: RunStore, sessionId: string): string {
  const rows = store.listForSession(sessionId);
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

describe("Runner completion integrity", () => {
  describe("C2: a child that already finalized itself is honored verbatim — never recomputed, never re-emitted", () => {
    it("runForeground: real child-reporter self-finalizes done BEFORE the parent observes the (production-shaped, result-less) exit — no false 'failed' status event, canonical result preserved", async () => {
      const db = freshDb();
      const store = new RunStore(db);
      const tailer = new RunEventTailer(db);
      const d = delayedSpawn();
      const runner = new Runner(db, "sess1", "/repo", { store, tailer, ...deps(d.spawn) });

      const runPromise = runner.runForeground({ agent: "worker", task: "do it", context: "fresh" });
      const runId = onlyRunId(store, "sess1");

      // The REAL child sequence against the SAME db/runId: a genuine message, then a bare
      // onShutdown("done") — attachChildReporter never passes a result argument.
      const rep = makeChildReporter(db, { runId, sessionId: "sess1" });
      rep.onMessage("FINAL: shipped the thing");
      rep.onShutdown("done");

      d.resolveWait({ exitCode: 0 }); // production shape: no `result` field at all
      const row = await runPromise;

      expect(row.status).toBe("done");
      expect(row.result).toBe("FINAL: shipped the thing");

      const events = db.prepare(`SELECT payload FROM run_events WHERE run_id=? AND type='status' ORDER BY id`).all(runId) as any[];
      const statuses = events.map((e) => JSON.parse(e.payload).status);
      expect(statuses).toEqual(["running", "done"]);
      expect(statuses).not.toContain("failed");
    });

    it("runAsync: same child-finalizes-before-exit race — onComplete and the persisted row agree, with no contradicting status event", async () => {
      const db = freshDb();
      const store = new RunStore(db);
      const tailer = new RunEventTailer(db);
      const onComplete = vi.fn();
      const d = delayedSpawn();
      const runner = new Runner(db, "sess1", "/repo", { store, tailer, onComplete, ...deps(d.spawn) });

      const row0 = runner.runAsync({ agent: "worker", task: "do it", context: "fresh" });
      const runId = row0.id;

      const rep = makeChildReporter(db, { runId, sessionId: "sess1" });
      rep.onMessage("FINAL: 42 TODOs found");
      rep.onShutdown("done");

      d.resolveWait({ exitCode: 0 });
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

      expect(onComplete.mock.calls[0][1]).toBe("done");
      expect(onComplete.mock.calls[0][2]).toBe("FINAL: 42 TODOs found");
      const events = db.prepare(`SELECT payload FROM run_events WHERE run_id=? AND type='status' ORDER BY id`).all(runId) as any[];
      expect(events.map((e) => JSON.parse(e.payload).status)).not.toContain("failed");
    });
  });

  describe("C1: the production wait() shape (no `result` field) must defer to the real run_events deliverable, not a null RunRow.result", () => {
    it("runAsync: a headless child (no onShutdown) that wrote a real final message is finalized done by the parent, not failed", async () => {
      const db = freshDb();
      const store = new RunStore(db);
      const tailer = new RunEventTailer(db);
      const onComplete = vi.fn();
      const d = delayedSpawn();
      const runner = new Runner(db, "sess1", "/repo", { store, tailer, onComplete, ...deps(d.spawn) });

      const row0 = runner.runAsync({ agent: "worker", task: "do it", context: "fresh" });
      const runId = row0.id;

      // Real child-reporter records its real final message, but session_shutdown never
      // fires (headless/killed) — onShutdown is never called.
      const rep = makeChildReporter(db, { runId, sessionId: "sess1" });
      rep.onMessage("FINAL: analyzed 12 files, 0 issues");

      d.resolveWait({ exitCode: 0 }); // production shape: no `result`
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

      const [, status, result] = onComplete.mock.calls[0];
      expect(status).toBe("done");
      expect(result).toBe("FINAL: analyzed 12 files, 0 issues");
      expect(store.get(runId)!.status).toBe("done");
      expect(store.get(runId)!.result).toBe("FINAL: analyzed 12 files, 0 issues");
    });

    it("runAsync: an unresolved BLOCKED escalation followed by a clean headless exit is reported failed, not success", async () => {
      const db = freshDb();
      const store = new RunStore(db);
      const tailer = new RunEventTailer(db);
      const onComplete = vi.fn();
      const d = delayedSpawn();
      const runner = new Runner(db, "sess1", "/repo", { store, tailer, onComplete, ...deps(d.spawn) });

      const row0 = runner.runAsync({ agent: "worker", task: "delete the old backups", context: "fresh" });
      const runId = row0.id;

      const rep = makeChildReporter(db, { runId, sessionId: "sess1" });
      rep.onMessage("ESCALATION[blocked]: need explicit approval before deleting production data");

      d.resolveWait({ exitCode: 0 });
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

      expect(onComplete.mock.calls[0][1]).toBe("failed");
      expect(store.get(runId)!.status).toBe("failed");
    });

    it("runAsync: a clean exit with truly nothing recorded fails with a generic, non-incident-specific message (missing genuine completion, not merely a missing result field)", async () => {
      const db = freshDb();
      const store = new RunStore(db);
      const tailer = new RunEventTailer(db);
      const onComplete = vi.fn();
      const spawn: Spawner = () => ({ pid: 1, wait: async () => ({ exitCode: 0 }), kill: () => {}, detach: () => {} });
      const runner = new Runner(db, "sess1", "/repo", { store, tailer, onComplete, ...deps(spawn) });

      const row = runner.runAsync({ agent: "worker", task: "t", context: "fresh" });
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

      expect(onComplete.mock.calls[0][1]).toBe("failed");
      const persisted = store.get(row.id)!;
      expect(persisted.result).toMatch(/no result/i);
      expect(persisted.result).not.toMatch(/c99fadd0|run [0-9a-f]{8}/i);
    });
  });

  describe("uses the REAL defaultSpawner (a tiny isolated node child — no model/network needed)", () => {
    it("a real subprocess exiting 0 resolves wait() with NO `result` field at all — the production contract, confirmed directly", async () => {
      const handle = defaultSpawner({ argv: ["node", "-e", "process.exit(0)"], env: {}, cwd: process.cwd(), sessionFile: "" });
      const outcome = await handle.wait();
      expect(outcome.exitCode).toBe(0);
      expect(outcome.result).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(outcome, "result")).toBe(false);
    });

    it("runAsync wired to the REAL defaultSpawner + a real child-reporter message: the genuine output survives as canonical result even though wait() supplies none", async () => {
      const db = freshDb();
      const store = new RunStore(db);
      const tailer = new RunEventTailer(db);
      const onComplete = vi.fn();
      // Wrap the REAL defaultSpawner, swapping in a trivial node child for a full pi CLI
      // invocation (no model/network needed) — child_process.spawn, the eager exit/error
      // listeners, and exit-code capture are all the actual production code path.
      const spawn: Spawner = (spec) => defaultSpawner({ ...spec, argv: ["node", "-e", "process.exit(0)"] });
      const cwd = realSpawnCwd("real-defaultspawner-message-cwd");
      const runner = new Runner(db, "sess1", cwd, { store, tailer, onComplete, ...deps(spawn) });

      const row = runner.runAsync({ agent: "worker", task: "do it", context: "fresh" });
      store.setPid(row.id, process.pid, process.pid);
      // Written synchronously, well before the real (but async) child-process exit event
      // can fire — mirrors the live-DB evidence that the child's own message/status
      // writes land before the parent observes the exit.
      const rep = makeChildReporter(db, { runId: row.id, sessionId: "sess1" });
      rep.onMessage("FINAL: real subprocess result");

      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), { timeout: 5000 });

      expect(store.get(row.id)!.status).toBe("done");
      expect(store.get(row.id)!.result).toBe("FINAL: real subprocess result");
    }, 10000);

    it("runAsync wired to the REAL defaultSpawner with nothing recorded ends failed, not silently done", async () => {
      const db = freshDb();
      const store = new RunStore(db);
      const tailer = new RunEventTailer(db);
      const onComplete = vi.fn();
      const spawn: Spawner = (spec) => defaultSpawner({ ...spec, argv: ["node", "-e", "process.exit(0)"] });
      const cwd = realSpawnCwd("real-defaultspawner-nothing-cwd");
      const runner = new Runner(db, "sess1", cwd, { store, tailer, onComplete, ...deps(spawn) });

      const row = runner.runAsync({ agent: "worker", task: "do it", context: "fresh" });
      store.setPid(row.id, process.pid, process.pid);
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), { timeout: 5000 });

      const persisted = store.get(row.id)!;
      expect(persisted.status).toBe("failed");
      expect(persisted.result).toMatch(/no result/i);
    }, 10000);
  });
});
