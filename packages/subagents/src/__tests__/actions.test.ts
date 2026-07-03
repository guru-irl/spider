import { describe, it, expect, afterEach, vi } from "vitest";
import { makeRunHandler } from "../actions/run.js";
import { RunStore } from "../run-store.js";
import { teardownAll } from "../coordinators.js";
import { freshDb } from "./helpers/testutil.js";

describe("run action routing", () => {
  afterEach(() => teardownAll());
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

  it("reuses ONE tailer across multiple run calls for the same session", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailers: any[] = [];
    const fakeRunner = { runForeground: async () => { const { id } = store.create({ sessionId: "reuse", agent: "worker" }); store.start(id); store.finish(id, { status: "done" }); return store.get(id); } };
    const handler = makeRunHandler({
      makeStore: () => store,
      makeRunner: (_db: any, _sid: string, _cwd: string, deps: any) => { tailers.push(deps.tailer); return fakeRunner as any; },
    });
    const ctx: any = { db, globalDb: db, sessionId: "reuse", cwd: process.cwd(), project: { dbPath: "/x/db" }, pi: { events: { on() {}, emit() {} } } };
    await handler({ agent: "worker", task: "a" } as any, ctx);
    await handler({ agent: "worker", task: "b" } as any, ctx);
    expect(tailers).toHaveLength(2);
    expect(tailers[0]).toBe(tailers[1]);
  });

  it("disposes a pipeline coordinator registered via run on teardownAll()", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const disposeSpy = vi.fn();
    const handler = makeRunHandler({
      makeStore: () => store,
      makeRunner: () => ({ runAsync: (o: any) => { const { id } = store.create({ sessionId: "pl-sess", agent: o.agent }); store.start(id); return store.get(id); } }) as any,
      makePipeline: () => ({ start: () => ({ pipelineId: "pl", firstRunId: "p0" }), dispose: disposeSpy }) as any,
    });
    const ctx: any = { db, globalDb: db, sessionId: "pl-sess", cwd: process.cwd(), project: { dbPath: "/x/db" }, pi: { events: { on() {}, emit() {} } } };
    await handler({ pipeline: [{ agent: "worker" }], handoff: "intercom" } as any, ctx);
    expect(disposeSpy).not.toHaveBeenCalled();
    teardownAll();
    expect(disposeSpy).toHaveBeenCalled();
  });
});
