import { describe, it, expect, vi } from "vitest";
import { Runner, type Spawner, type ChildHandle } from "../runner";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";
import { freshDb, testScratchPath } from "./helpers/testutil";

// Repro for run c99fadd0: a child that escalated/blocked and then exited 0 WITHOUT
// ever producing a terminal deliverable was recorded status="done" result=null,
// ended_at set — reported as SUCCESS. The escalation existed only in callback text,
// invisible to anything keying on status. The run DID produce intermediate artifacts
// on disk; only the terminal deliverable was missing, so the bar is not "detect zero
// output" — it's "a clean exit with a null/empty result is not a success".
//
// runner.ts derives status from exitCode ALONE at two sites (sync runForeground,
// async runAsync's parent-finalizes branch). Both must independently honor this rule.

function fakeSpawn(result: { exitCode: number; result?: string }): Spawner {
  return () => {
    const handle: ChildHandle = {
      pid: 4242,
      wait: async () => result,
      kill: () => {},
      detach: () => {},
    };
    return handle;
  };
}

const deps = (spawn: Spawner) => ({
  scratchRoot: testScratchPath("runner-no-deliverable-scratch"),
  dbPath: testScratchPath("runner-no-deliverable.db"),
  spawn,
});

describe("Runner: a clean exit with no deliverable is not success (c99fadd0)", () => {
  it("runForeground [sync path, runner.ts:87]: exitCode 0 with result=undefined is NOT recorded done", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailer = new RunEventTailer(db);
    const runner = new Runner(db, "sess1", "/repo", { store, tailer, ...deps(fakeSpawn({ exitCode: 0, result: undefined })) });

    const run = await runner.runForeground({ agent: "worker", task: "do it", context: "fresh" });

    expect(run.status).not.toBe("done");
    expect(run.status).toBe("failed");
    // The old code stored result=null and gave no clue why. The fix must explain itself.
    expect(run.result).toBeTruthy();
    expect(run.result).toMatch(/no (result|deliverable)/i);
    expect(run.ended_at).toBeTruthy();
  });

  it("runForeground [sync path]: exitCode 0 with an empty-string result is NOT recorded done", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailer = new RunEventTailer(db);
    const runner = new Runner(db, "sess1", "/repo", { store, tailer, ...deps(fakeSpawn({ exitCode: 0, result: "" })) });

    const run = await runner.runForeground({ agent: "worker", task: "do it", context: "fresh" });

    expect(run.status).toBe("failed");
  });

  it("runForeground [sync path]: exitCode 0 with a whitespace-only result is NOT recorded done", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailer = new RunEventTailer(db);
    const runner = new Runner(db, "sess1", "/repo", { store, tailer, ...deps(fakeSpawn({ exitCode: 0, result: "   \n\t  " })) });

    const run = await runner.runForeground({ agent: "worker", task: "do it", context: "fresh" });

    expect(run.status).toBe("failed");
  });

  it("runForeground [sync path, no regression]: exitCode 0 with a real deliverable still reports done", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailer = new RunEventTailer(db);
    const runner = new Runner(db, "sess1", "/repo", { store, tailer, ...deps(fakeSpawn({ exitCode: 0, result: "shipped the thing" })) });

    const run = await runner.runForeground({ agent: "worker", task: "do it", context: "fresh" });

    expect(run.status).toBe("done");
    expect(run.result).toBe("shipped the thing");
  });

  it("runAsync [async path, runner.ts:114]: parent-finalized clean exit with no result reports failed, not done, in BOTH onComplete and the stored row", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailer = new RunEventTailer(db);
    const onComplete = vi.fn();
    const runner = new Runner(db, "sess1", "/repo", {
      store, tailer, onComplete, ...deps(fakeSpawn({ exitCode: 0, result: undefined })),
    });

    const run = runner.runAsync({ agent: "worker", name: "escalated-then-exited", task: "do it", context: "fresh" });
    expect(run.status).toBe("running");

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    const [finished, status, result] = onComplete.mock.calls[0];

    expect(status).not.toBe("done");
    expect(status).toBe("failed");
    expect(finished.status).toBe("failed");
    expect(result).toBeTruthy();

    // The persisted row is the source of truth for anything keying on status later —
    // it must match what was just reported, not just the in-memory callback args.
    const persisted = store.get(run.id)!;
    expect(persisted.status).toBe("failed");
    expect(persisted.result).toBeTruthy();
  });

  it("runAsync [async path, no regression]: parent-finalized clean exit WITH a result still reports done", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailer = new RunEventTailer(db);
    const onComplete = vi.fn();
    const runner = new Runner(db, "sess1", "/repo", {
      store, tailer, onComplete, ...deps(fakeSpawn({ exitCode: 0, result: "42 TODOs found" })),
    });

    runner.runAsync({ agent: "worker", task: "do it", context: "fresh" });

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0][1]).toBe("done");
    expect(onComplete.mock.calls[0][2]).toBe("42 TODOs found");
  });

  // Characterization/guard test, NOT part of the defect's RED set: this branch (the child
  // already self-finalized before the parent observed exit) is untouched by the fix — a
  // cancelled/killed run is a deliberate stop, never a missing deliverable, and must keep
  // its terminal status. Pinned explicitly because the task spec calls it out as a MUST.
  it("runAsync [cancelled invariant]: a run cancelled before exit is observed stays cancelled, even with exitCode 0 and no result", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailer = new RunEventTailer(db);
    const onComplete = vi.fn();
    let resolveWait!: (v: { exitCode: number; result?: string }) => void;
    const spawn: Spawner = () => ({ pid: 1, wait: () => new Promise((r) => { resolveWait = r; }), kill: () => {}, detach: () => {} });
    const runner = new Runner(db, "sess-cancel", "/repo", { store, tailer, onComplete, ...deps(spawn) });

    const run = runner.runAsync({ agent: "worker", task: "t", context: "fresh" });
    // Simulate a kill landing (cancel()) BEFORE the child's exit is observed by the parent —
    // exactly the shape a killed/blocked child that then exits 0 with no output would take.
    store.cancel(run.id, "killed by orchestrator");
    resolveWait({ exitCode: 0, result: undefined });

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0][1]).toBe("cancelled");
    expect(store.get(run.id)!.status).toBe("cancelled");
  });
});
