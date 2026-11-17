import { afterEach, describe, expect, it } from "vitest";
import { makeRunHandler } from "../actions/run.js";
import { detachForReload, getCoordinators, teardownCoordinators } from "../coordinators.js";
import { PipelineCoordinator } from "../pipeline.js";
import { RunStore } from "../run-store.js";
import { RunEventTailer } from "../event-tailer.js";
import { freshDb } from "./helpers/testutil.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

// Only the OS child is replaced. Dispatch, runners, the event bus, and coordinators are real.
function fixture(exitCode = 0) {
  const db = freshDb(), sessionId = crypto.randomUUID();
  cleanups.push(() => db.close(), () => teardownCoordinators(sessionId));
  let completions = 0, target = 0;
  let done = () => {};
  const handler = makeRunHandler({ spawner: () => ({
    wait: async () => ({ exitCode, result: "verified stage output" }),
    kill() {}, detach() {},
  }) });
  const ctx = { db, sessionId, cwd: process.cwd(), pi: { sendMessage() { if (++completions === target) done(); } } };
  return {
    coords: () => getCoordinators(sessionId, () => { throw new Error("missing live coordinators"); }),
    async dispatch() {
      target = completions + 2;
      const finished = new Promise<void>(resolve => { done = resolve; });
      await handler({ pipeline: [{ agent: "worker", task: "implement" }, { agent: "reviewer", task: "review {previous}" }] }, ctx);
      await finished;
    },
  };
}

describe("session pipeline ownership", () => {
  it("releases ownership when the initial stage cannot be dispatched", async () => {
    const db = freshDb(), sessionId = crypto.randomUUID();
    cleanups.push(() => db.close());
    const coords = { tailer: new RunEventTailer(db), pipelines: [] as PipelineCoordinator[], children: new Map() };
    const handler = makeRunHandler({ getCoordinators: () => coords, makeRunner: () => ({ runAsync() { throw new Error("fixture launch failure"); } }) });
    await expect(handler({ pipeline: [{ agent: "worker", task: "work" }] }, { db, sessionId, cwd: process.cwd(), pi: {} })).rejects.toThrow("fixture launch failure");
    expect(coords.pipelines).toHaveLength(0);
  });

  it.each(["quit", "reload"])("disposes every live pipeline on %s without skipping self-removing entries", async reason => {
    const db = freshDb(), sessionId = crypto.randomUUID(), store = new RunStore(db);
    cleanups.push(() => db.close(), () => teardownCoordinators(sessionId));
    const coords = getCoordinators(sessionId, () => ({ tailer: new RunEventTailer(db), pipelines: [], children: new Map() }));
    const runner = { runAsync: (opts: { agent: string; task: string }) => store.get(store.create({ sessionId, ...opts }).id)! };
    let released = 0;
    const live = Array.from({ length: 3 }, () => {
      const pipeline = new PipelineCoordinator({ db, globalDb: db, store, runner, pi: {}, sessionId, onDispose() {
        released++;
        const index = coords.pipelines.indexOf(pipeline);
        if (index >= 0) coords.pipelines.splice(index, 1);
      } });
      coords.pipelines.push(pipeline);
      pipeline.start({ pipeline: [{ agent: "worker", task: "work" }, { agent: "reviewer", task: "review {previous}" }], handoff: "intercom" });
      return pipeline;
    });
    if (reason === "quit") teardownCoordinators(sessionId);
    else await detachForReload(sessionId);
    expect(coords.pipelines).toHaveLength(0);
    expect(live.map(pipeline => pipeline.isActive())).toEqual([false, false, false]);
    for (const pipeline of live) pipeline.dispose();
    expect(released).toBe(3);
  });

  it.each([0, 1])("releases finished pipelines after repeated dispatches (exit %i)", async exitCode => {
    const f = fixture(exitCode);
    for (let i = 0; i < 12; i++) {
      await f.dispatch();
      expect(f.coords().pipelines).toHaveLength(0);
    }
  });

  it("keeps a running pipeline owned until its final child finishes", async () => {
    const db = freshDb(), sessionId = crypto.randomUUID();
    cleanups.push(() => db.close(), () => teardownCoordinators(sessionId));
    const exits: ((result: { exitCode: number; result: string }) => void)[] = [];
    let markFirst!: () => void, markLast!: () => void;
    const first = new Promise<void>(resolve => { markFirst = resolve; });
    const last = new Promise<void>(resolve => { markLast = resolve; });
    let count = 0;
    const handler = makeRunHandler({ spawner: () => ({
      wait: () => new Promise<{ exitCode: number; result: string }>(resolve => { exits.push(resolve); }), kill() {}, detach() {},
    }) });
    const ctx = { db, sessionId, cwd: process.cwd(), pi: { sendMessage() { if (++count === 1) markFirst(); else markLast(); } } };
    await handler({ pipeline: [{ agent: "worker", task: "work" }, { agent: "reviewer", task: "review {previous}" }] }, ctx);
    const coords = getCoordinators(sessionId, () => { throw new Error("missing coordinators"); });
    expect(coords.pipelines).toHaveLength(1);
    exits[0]({ exitCode: 0, result: "first stage" });
    await first;
    expect(coords.pipelines).toHaveLength(1);
    exits[1]({ exitCode: 0, result: "final stage" });
    await last;
    expect(coords.pipelines).toHaveLength(0);
  });
});
