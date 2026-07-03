import { describe, it, expect } from "vitest";
import { makeRunHandler } from "../actions/run.js";
import { RunStore } from "../run-store.js";
import { freshDb } from "./helpers/testutil.js";

describe("run action routing", () => {
  it("routes a single {agent,task} to a single foreground run", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const calls: string[] = [];
    const fakeRunnerFactory = () => ({
      runForeground: async (o: any) => {
        calls.push(`single:${o.agent}`);
        const { id } = store.create({ sessionId: "s1", agent: o.agent, task: o.task });
        store.start(id);
        store.finish(id, { status: "done", result: "ok" });
        return store.get(id);
      },
      runAsync: (o: any) => {
        const { id } = store.create({ sessionId: "s1", agent: o.agent });
        return store.get(id);
      },
    });
    const handler = makeRunHandler({ makeRunner: fakeRunnerFactory as any, makeStore: () => store });
    const ctx: any = { db, globalDb: db, sessionId: "s1", cwd: process.cwd(), project: { dbPath: "/x/db" }, pi: { events: { on() {}, emit() {} } } };
    const res = await handler({ agent: "worker", task: "do it" } as any, ctx);
    expect(calls).toContain("single:worker");
    expect((res as any).isError).not.toBe(true);
    expect((res as any).content).toContain("done");
  });

  it("routes {pipeline,handoff} to the pipeline coordinator", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    let started = false;
    const handler = makeRunHandler({
      makeRunner: () => ({ runAsync: (o: any) => { const { id } = store.create({ sessionId: "s1", agent: o.agent }); store.start(id); return store.get(id); } }) as any,
      makeStore: () => store,
      makePipeline: () => ({ start: () => { started = true; return { pipelineId: "pl", firstRunId: "p0" }; }, dispose() {} }) as any,
    });
    const ctx: any = { db, globalDb: db, sessionId: "s1", cwd: process.cwd(), project: { dbPath: "/x/db" }, pi: { events: { on() {}, emit() {} } } };
    await handler({ pipeline: [{ agent: "worker" }, { agent: "worker", role: "reviewer" }], handoff: "intercom" } as any, ctx);
    expect(started).toBe(true);
  });
});
