import { describe, it, expect, vi } from "vitest";
import { Runner, type Spawner, type ChildHandle } from "../runner";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";
import { freshDb } from "./helpers/testutil";
import { appendRunEvent } from "@spider/db-core";
import { latestRunOutput } from "../completion-output";

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
  scratchRoot: "/x/.spider/scratch",
  dbPath: "/x/.spider/project.db",
  spawn,
});

describe("Runner", () => {
  it("runForeground: queued -> running -> done, links to parent P", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailer = new RunEventTailer(db);
    const runner = new Runner(db, "sess1", "/repo", { store, tailer, ...deps(fakeSpawn({ exitCode: 0, result: "ok" })) });

    const run = await runner.runForeground({ agent: "worker", task: "do it", context: "fresh", parentRunId: "P" });

    expect(run.status).toBe("done");
    expect(run.parent_run_id).toBe("P");
    expect(run.result).toBe("ok");
    expect(run.started_at).toBeTruthy();
    expect(run.ended_at).toBeTruthy();
  });

  it("runForeground: non-zero exit code becomes a failed run", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailer = new RunEventTailer(db);
    const runner = new Runner(db, "sess1", "/repo", { store, tailer, ...deps(fakeSpawn({ exitCode: 1, result: "boom" })) });

    const run = await runner.runForeground({ agent: "worker", task: "do it", context: "fresh" });

    expect(run.status).toBe("failed");
    expect(run.result).toBe("boom");
  });

  it("runAsync: returns immediately as running and tracks the run in the tailer", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailer = new RunEventTailer(db);
    const trackSpy = vi.spyOn(tailer, "track");
    const spawn: Spawner = () => ({
      wait: () => new Promise(() => {}),
      kill: () => {},
      detach: () => {},
    });
    const runner = new Runner(db, "sess1", "/repo", { store, tailer, ...deps(spawn) });

    const run = runner.runAsync({ agent: "worker", task: "do it", context: "fresh" });

    expect(run.status).toBe("running");
    expect(run.started_at).toBeTruthy();
    expect(trackSpy).toHaveBeenCalledWith(run.id);
  });

  it("runAsync: fires onComplete with the finished run when the child exits", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailer = new RunEventTailer(db);
    const onComplete = vi.fn();
    const runner = new Runner(db, "sess1", "/repo", {
      store, tailer, onComplete, ...deps(fakeSpawn({ exitCode: 0, result: "done-result" })),
    });

    const run = runner.runAsync({ agent: "worker", name: "todo-hunt", task: "do it", context: "fresh" });
    expect(run.status).toBe("running");

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    const [finished, status, result] = onComplete.mock.calls[0];
    expect(status).toBe("done");
    expect(result).toBe("done-result");
    expect(finished.id).toBe(run.id);
    expect(finished.name).toBe("todo-hunt");
    expect(finished.status).toBe("done");
  });

  it("runAsync: onComplete reports failed on non-zero exit", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailer = new RunEventTailer(db);
    const onComplete = vi.fn();
    const runner = new Runner(db, "sess1", "/repo", {
      store, tailer, onComplete, ...deps(fakeSpawn({ exitCode: 1, result: "boom" })),
    });
    runner.runAsync({ agent: "worker", task: "do it", context: "fresh" });
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0][1]).toBe("failed");
  });

  it("runAsync: latestRunOutput captures the child's real final message output", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailer = new RunEventTailer(db);
    const onComplete = vi.fn();
    
    // Create a spawner that delays completion so we can append events
    let resolveWait: ((val: any) => void) | null = null;
    const spawn: Spawner = () => {
      const handle: ChildHandle = {
        pid: 4242,
        wait: () => new Promise(resolve => { resolveWait = resolve; }),
        kill: () => {},
        detach: () => {},
      };
      return handle;
    };

    const runner = new Runner(db, "sess1", "/repo", { store, tailer, onComplete, ...deps(spawn) });
    const run = runner.runAsync({ agent: "worker", task: "test everything", context: "fresh" });

    // Give the runner time to set up
    await new Promise(resolve => setTimeout(resolve, 20));

    // Append message events to simulate child output
    appendRunEvent(db, { runId: run.id, sessionId: "sess1", ts: Date.now(), type: "message", summary: "Analyzed 5 files" });
    appendRunEvent(db, { runId: run.id, sessionId: "sess1", ts: Date.now() + 1, type: "tool_intent", tool: "bash", summary: "run tests" });
    appendRunEvent(db, { runId: run.id, sessionId: "sess1", ts: Date.now() + 2, type: "message", summary: "FINAL: All tests passed, 3 TODOs found" });

    // Verify latestRunOutput retrieves the final message before completion
    expect(latestRunOutput(db, run.id)).toBe("FINAL: All tests passed, 3 TODOs found");

    // Now complete the child process
    resolveWait!({ exitCode: 0, result: "generic-result" });

    // Wait for onComplete to be called
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), { timeout: 1000 });
    
    // Verify onComplete was called with the correct run
    const [finished] = onComplete.mock.calls[0];
    expect(finished.id).toBe(run.id);
  });
});
