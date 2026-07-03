import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDbAt, paths } from "@spider/db-core";
import { makeRunHandler } from "../actions/run";
import { makeMessageHandler } from "../actions/message";
import { SUBAGENT_RESULT_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT } from "../intercom";
import { RunStore } from "../run-store";
import { teardownAll } from "../coordinators";
import { freshDb } from "./helpers/testutil";
import { registerSubagentActions } from "../index";

function fakeEvents() {
  const listeners = new Map<string, Array<(p: any) => void>>();
  return {
    on(evt: string, fn: (p: any) => void) {
      const arr = listeners.get(evt) ?? [];
      arr.push(fn);
      listeners.set(evt, arr);
      return () => {
        const cur = listeners.get(evt) ?? [];
        listeners.set(evt, cur.filter((f) => f !== fn));
      };
    },
    emit(evt: string, payload: any) {
      for (const fn of [...(listeners.get(evt) ?? [])]) fn(payload);
    },
  };
}

it("does not register a synchronous 'wait' action (subagents are async-only)", () => {
  const registered = new Map<string, unknown>();
  const host = { registerAction: (name: string, h: unknown) => registered.set(name, h) };
  const savedEnv = process.env.PI_SUBAGENT_CHILD;
  try {
    delete process.env.PI_SUBAGENT_CHILD;
    registerSubagentActions(host as never, {} as never);
    expect(registered.has("run")).toBe(true);
    expect(registered.has("message")).toBe(true);
    expect(registered.has("wait")).toBe(false);
  } finally {
    if (savedEnv !== undefined) process.env.PI_SUBAGENT_CHILD = savedEnv;
  }
});

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

describe("message action handler", () => {
  function globalDb() {
    return openDbAt(join(paths.scratch("project", process.cwd()), `msg-${randomUUID()}.db`), "global");
  }

  it("reports NOT delivered + isError when intercom delivery times out", async () => {
    const gdb = globalDb();
    const handler = makeMessageHandler();
    const ctx: any = { pi: { events: fakeEvents() }, globalDb: gdb, sessionId: "from-sess" };
    const res: any = await handler({ to: "nobody", message: "hi", timeoutMs: 20 }, ctx);
    expect(res.content).toContain("message NOT delivered");
    expect(res.isError).toBe(true);
    const row = gdb.prepare(`SELECT * FROM message_mirror ORDER BY id DESC LIMIT 1`).get() as any;
    expect(row.to_session).toBe("nobody");
  });

  it("reports delivered when the broker acknowledges delivery", async () => {
    const gdb = globalDb();
    const events = fakeEvents();
    // Auto-acknowledge: when the request is emitted, echo back a successful delivery.
    events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (p: any) => {
      events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: p.requestId, delivered: true });
    });
    const handler = makeMessageHandler();
    const ctx: any = { pi: { events }, globalDb: gdb, sessionId: "from-sess" };
    const res: any = await handler({ to: "peer", message: "hi", timeoutMs: 1000 }, ctx);
    expect(res.content).toContain("message delivered to peer");
    expect(res.isError).toBe(false);
  });
});
