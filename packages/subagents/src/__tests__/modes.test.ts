import { describe, it, expect } from "vitest";
import { runChain, runParallel } from "../modes-index";
import { Runner } from "../runner";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";
import { freshDb, testScratchPath } from "./helpers/testutil";

function makeRunner(db: ReturnType<typeof freshDb>, capture: Array<Record<string, unknown>>) {
  const store = new RunStore(db);
  const tailer = new RunEventTailer(db);
  const runner = new Runner(db, "sess1", "/repo", {
    store,
    tailer,
    scratchRoot: testScratchPath("modes-scratch"),
    dbPath: testScratchPath("modes.db"),
    spawn: () => ({
      pid: 4242,
      wait: async () => ({ exitCode: 0, result: `res-${capture.length}` }),
      kill: () => {},
      detach: () => {},
    }),
  });
  const original = runner.runForeground.bind(runner);
  runner.runForeground = (opts: Parameters<typeof original>[0]) => {
    capture.push(opts as unknown as Record<string, unknown>);
    return original(opts);
  };
  return runner;
}

describe("mode orchestrators", () => {
  it("runChain: interpolates {task} and {previous} across steps", async () => {
    const db = freshDb();
    const capture: Array<Record<string, unknown>> = [];
    const runner = makeRunner(db, capture);

    const rows = await runChain(
      runner,
      [
        { agent: "worker", task: "start on {task}" },
        { agent: "worker", task: "continue from {previous}" },
      ],
      { task: "the feature", context: "fresh" }
    );

    expect(rows).toHaveLength(2);
    expect(capture[0].task).toBe("start on the feature");
    expect(capture[1].task).toBe("continue from res-1");
    expect(rows[1].result).toBe("res-2");
  });

  it("runParallel: expands count and runs a bounded pool", async () => {
    const db = freshDb();
    const capture: Array<Record<string, unknown>> = [];
    const runner = makeRunner(db, capture);

    const rows = await runParallel(
      runner,
      [{ agent: "worker", task: "scan", count: 3 }],
      { context: "fresh", concurrency: 2 }
    );

    expect(rows).toHaveLength(3);
    expect(capture).toHaveLength(3);
    expect(new Set(capture.map((c) => c.childIndex))).toEqual(new Set([0, 1, 2]));
  });
});
