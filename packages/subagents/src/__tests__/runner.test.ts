import { describe, it, expect, vi } from "vitest";
import { Runner, type Spawner, type ChildHandle } from "../runner.js";
import { RunStore } from "../run-store.js";
import { RunEventTailer } from "../event-tailer.js";
import { freshDb } from "./helpers/testutil.js";

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
});
