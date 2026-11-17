import { afterEach, describe, expect, it } from "vitest";
import { makeRunHandler } from "../actions/run.js";
import { getCoordinators, teardownCoordinators } from "../coordinators.js";
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
      wait: () => new Promise(resolve => { exits.push(resolve); }), kill() {}, detach() {},
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
