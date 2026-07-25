import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDbAt } from "@spider/db-core";
import { makeRunHandler } from "../actions/run";
import { makeMessageHandler } from "../actions/message";
import { makeKillHandler } from "../actions/kill";
import { SUBAGENT_RESULT_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT } from "../intercom";
import { RunStore } from "../run-store";
import { teardownAll, registerChild, getChild } from "../coordinators";
import { freshDb, testScratchPath } from "./helpers/testutil";
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
    expect(registered.has("kill")).toBe(true);
    expect(registered.has("wait")).toBe(false);
  } finally {
    if (savedEnv !== undefined) process.env.PI_SUBAGENT_CHILD = savedEnv;
  }
});

describe("run action routing", () => {
  afterEach(() => teardownAll());
  it("stamps the parent's model + thinking on runs that don't name one; parses thinking from a model suffix; explicit wins", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const seen: any[] = [];
    const fakeRunner = () => ({
      runForeground: async (o: any) => { seen.push(o); const { id } = store.create({ sessionId: "s1", agent: o.agent, model: o.model, thinking: o.thinking, task: o.task }); store.start(id); store.finish(id, { status: "done" }); return store.get(id); },
      runAsync: (o: any) => { seen.push(o); const { id } = store.create({ sessionId: "s1", agent: o.agent, model: o.model, thinking: o.thinking }); return store.get(id); },
    });
    const handler = makeRunHandler({ makeRunner: fakeRunner as any, makeStore: () => store });
    // parent is on opus:low → children inherit base model 'opus' + thinking 'low'
    const ctx: any = { db, globalDb: db, sessionId: "s1", cwd: process.cwd(), project: { dbPath: testScratchPath("test.db") }, pi: { events: { on() {}, emit() {} } }, model: { id: "github-copilot/claude-opus-4.8:low" } };
    await handler({ agent: "worker", task: "x" } as any, ctx);
    expect(seen[0].model).toBe("github-copilot/claude-opus-4.8");
    expect(seen[0].thinking).toBe("low");
    // explicit model suffix parsed into base + thinking
    await handler({ agent: "worker", task: "y", model: "prov/m:high" } as any, ctx);
    expect(seen[1].model).toBe("prov/m");
    expect(seen[1].thinking).toBe("high");
    // explicit thinking param wins over the suffix
    await handler({ agent: "worker", task: "z", model: "prov/m:high", thinking: "minimal" } as any, ctx);
    expect(seen[2].thinking).toBe("minimal");
  });
  it("routes a single {agent,task} to a single async run (async-only)", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const calls: string[] = [];
    const fakeRunnerFactory = () => ({
      runForeground: async () => { throw new Error("must not run foreground — subagents are async-only"); },
      runAsync: (o: any) => {
        calls.push(`single:${o.agent}`);
        const { id } = store.create({ sessionId: "s1", agent: o.agent, task: o.task });
        store.start(id);
        return store.get(id);
      },
    });
    const handler = makeRunHandler({ makeRunner: fakeRunnerFactory as any, makeStore: () => store });
    const ctx: any = { db, globalDb: db, sessionId: "s1", cwd: process.cwd(), project: { dbPath: testScratchPath("test.db") }, pi: { events: { on() {}, emit() {} } } };
    const res = await handler({ agent: "worker", task: "do it" } as any, ctx);
    expect(calls).toContain("single:worker");
    expect((res as any).isError).not.toBe(true);
    expect((res as any).content).toContain("worker");
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
    const ctx: any = { db, globalDb: db, sessionId: "s1", cwd: process.cwd(), project: { dbPath: testScratchPath("test.db") }, pi: { events: { on() {}, emit() {} } } };
    await handler({ pipeline: [{ agent: "worker" }, { agent: "worker", role: "reviewer" }], handoff: "intercom" } as any, ctx);
    expect(started).toBe(true);
  });

  it("reuses ONE tailer across multiple run calls for the same session", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const tailers: any[] = [];
    const fakeRunner = { runAsync: (o: any) => { const { id } = store.create({ sessionId: "reuse", agent: o.agent }); store.start(id); return store.get(id); } };
    const handler = makeRunHandler({
      makeStore: () => store,
      makeRunner: (_db: any, _sid: string, _cwd: string, deps: any) => { tailers.push(deps.tailer); return fakeRunner as any; },
    });
    const ctx: any = { db, globalDb: db, sessionId: "reuse", cwd: process.cwd(), project: { dbPath: testScratchPath("test.db") }, pi: { events: { on() {}, emit() {} } } };
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
    const ctx: any = { db, globalDb: db, sessionId: "pl-sess", cwd: process.cwd(), project: { dbPath: testScratchPath("test.db") }, pi: { events: { on() {}, emit() {} } } };
    await handler({ pipeline: [{ agent: "worker" }], handoff: "intercom" } as any, ctx);
    expect(disposeSpy).not.toHaveBeenCalled();
    teardownAll();
    expect(disposeSpy).toHaveBeenCalled();
  });
});

describe("message action handler", () => {
  function globalDb() {
    return openDbAt(testScratchPath(`msg-${randomUUID()}.db`), "global");
  }

  it("reports queued (not error) when intercom delivery times out (queue-first durability)", async () => {
    const gdb = globalDb();
    const handler = makeMessageHandler();
    const ctx: any = { pi: { events: fakeEvents() }, globalDb: gdb, sessionId: "from-sess" };
    const res: any = await handler({ to: "nobody", message: "hi", timeoutMs: 20 }, ctx);
    expect(res.content).toContain("message queued for nobody");
    expect(res.isError).toBe(false); // Queued is not an error — message is durable
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

describe("kill action", () => {
  it("kills all active runs and reports each", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const a = store.create({ sessionId: "s1", agent: "worker", name: "alpha", task: "t" });
    const b = store.create({ sessionId: "s1", agent: "worker", name: "beta", task: "t" });
    store.start(a.id); store.start(b.id);
    const handler = makeKillHandler();
    const res = await handler({ id: "all" }, { db, sessionId: "s1" });
    expect(res.details.killed).toHaveLength(2);
    expect(store.get(a.id)!.status).toBe("cancelled");
    expect(store.get(b.id)!.status).toBe("cancelled");
  });

  it("reports 'no active subagents' rather than erroring when none are running", async () => {
    const db = freshDb();
    const handler = makeKillHandler();
    const res = await handler({ id: "all" }, { db, sessionId: "s1" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/no active subagents/i);
  });

  it("returns an error result for an unmatched target instead of throwing", async () => {
    const db = freshDb();
    const handler = makeKillHandler();
    const res = await handler({ id: "ghost" }, { db, sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/no active run/i);
  });

  it("continues the kill loop on store.cancel failure and reports partial results", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const a = store.create({ sessionId: "s1", agent: "worker", name: "alpha", task: "t" });
    const b = store.create({ sessionId: "s1", agent: "worker", name: "beta", task: "t" });
    store.start(a.id); store.start(b.id);
    
    // Spy on killRun to throw on first call
    const killModule = await import("../kill");
    let callCount = 0;
    const originalKillRun = killModule.killRun;
    const spy = vi.spyOn(killModule, "killRun").mockImplementation(async (deps, sessionId, run) => {
      callCount++;
      if (callCount === 1) throw new Error("SQLITE_BUSY");
      return originalKillRun(deps, sessionId, run);
    });
    
    try {
      const handler = makeKillHandler();
      const res = await handler({ id: "all" }, { db, sessionId: "s1" });
      
      // Should report BOTH runs even though first failed
      expect(res.details.killed).toHaveLength(2);
      expect(res.isError).toBe(true);
      
      // First run should have failed outcome
      expect(res.details.killed[0].outcome).toBe("failed");
      expect(res.details.killed[0].error).toContain("SQLITE_BUSY");
      // Second run should be processed normally (no spawned process, so reconciled)
      expect(res.details.killed[1].outcome).toBe("no-process");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("session_shutdown wiring", () => {
  afterEach(() => teardownAll());

  const fakeHandle = (): import("../runner").ChildHandle & { killed: boolean } => {
    const h = { pid: 111, killed: false, wait: async () => ({ exitCode: 0 }), kill() { h.killed = true; }, detach() {} };
    return h as import("../runner").ChildHandle & { killed: boolean };
  };

  it("registers a session_shutdown listener that kills registered children", async () => {
    const savedEnv = process.env.PI_SUBAGENT_CHILD;
    try {
      delete process.env.PI_SUBAGENT_CHILD; // Ensure we're in parent mode

      const listeners = new Map<string, Array<() => void | Promise<void>>>();
      const piDouble = {
        on: (event: string, handler: () => void | Promise<void>) => {
          const arr = listeners.get(event) ?? [];
          arr.push(handler);
          listeners.set(event, arr);
        },
      };
      const host = { registerAction: () => {} };
      registerSubagentActions(host as never, piDouble as never);

      // Assert the listener was registered
      expect(listeners.has("session_shutdown")).toBe(true);
      const handlers = listeners.get("session_shutdown") ?? [];
      expect(handlers).toHaveLength(1);

      // Register some fake children
      const h1 = fakeHandle();
      const h2 = fakeHandle();
      registerChild("shutdown-sess", "run-a", h1);
      registerChild("shutdown-sess", "run-b", h2);

      // Verify they're registered
      expect(getChild("shutdown-sess", "run-a")).toBe(h1);
      expect(getChild("shutdown-sess", "run-b")).toBe(h2);

      // Invoke the handler directly (it may be async, so await it)
      const result = handlers[0]();
      if (result instanceof Promise) {
        await result;
      }

      // Assert children were killed
      expect(h1.killed).toBe(true);
      expect(h2.killed).toBe(true);
    } finally {
      if (savedEnv !== undefined) process.env.PI_SUBAGENT_CHILD = savedEnv;
    }
  });
});
