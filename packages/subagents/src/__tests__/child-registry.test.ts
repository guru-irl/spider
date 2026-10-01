import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { openDbAt } from "@spider/db-core";
import { testScratchPath } from "./helpers/testutil";
import { RunStore } from "../run-store";
import {
  DEFAULT_DETACH_TTL_MS, sweepDetachedOnExit,
  CHILD_REGISTRY_KEY, CHILD_REGISTRY_VERSION, adoptShared, detachShared, disposeSessionRegistries, getShared,
  registerShared, releaseShared, resetSharedRegistryForTests, setSink, sharedRegistry, type SharedHandle,
} from "../child-registry";

function fakeHandle() {
  let resolve!: (v: { exitCode: number; result?: string }) => void;
  let reject!: (e: unknown) => void;
  const exit = new Promise<{ exitCode: number; result?: string }>((res, rej) => { resolve = res; reject = rej; });
  const calls = { kill: 0, killAsync: 0, unbind: 0, bind: [] as unknown[] };
  const handle: SharedHandle = {
    pid: 4242,
    wait: () => exit,
    kill: () => { calls.kill++; },
    killAsync: async () => { calls.killAsync++; },
    unbindEvents: () => { calls.unbind++; },
    bindEvents: sink => { calls.bind.push(sink); },
  };
  return { handle, resolve, reject, calls };
}
const init = (runId: string, handle: SharedHandle, extra: Record<string, unknown> = {}) => ({
  runId, sessionId: "s1", dbPath: "/nowhere/project.db", mode: "rpc" as const, handle, survivable: true, ...extra,
});
const tick = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => resetSharedRegistryForTests());
afterEach(() => { vi.useRealTimers(); resetSharedRegistryForTests(); });

describe("shared child registry", () => {
  it("lives on globalThis under a versioned Symbol.for key", () => {
    const reg = sharedRegistry();
    expect(CHILD_REGISTRY_KEY).toBe(Symbol.for(`spider.childRegistry.v${CHILD_REGISTRY_VERSION}`));
    expect((globalThis as any)[CHILD_REGISTRY_KEY]).toBe(reg);
    expect(reg.version).toBe(1);
    expect(sharedRegistry()).toBe(reg);
  });

  it("hands the exit to an attached sink exactly once", async () => {
    const f = fakeHandle(); const sink = vi.fn();
    registerShared(init("r1", f.handle)); setSink("r1", sink);
    f.resolve({ exitCode: 0, result: "ok" });
    await tick(); await tick();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][1]).toEqual({ exitCode: 0, result: "ok" });
  });

  it("turns a rejected wait into a failed exit", async () => {
    const f = fakeHandle(); const sink = vi.fn();
    registerShared(init("r1", f.handle)); setSink("r1", sink);
    f.reject(new Error("boom"));
    await tick();
    expect(sink.mock.calls[0][1].exitCode).toBe(1);
    expect(sink.mock.calls[0][1].result).toContain("Child wait failed: Error: boom");
  });

  it("detach keeps survivable children alive, drops the sink, and unbinds events", async () => {
    const f = fakeHandle(); const sink = vi.fn();
    registerShared(init("r1", f.handle)); setSink("r1", sink);
    await detachShared("s1", { ttlMs: 60_000 });
    const entry = getShared("r1")!;
    expect(entry.state).toBe("detached");
    expect(entry.sink).toBeUndefined();
    expect(f.calls.unbind).toBe(1);
    expect(f.calls.kill + f.calls.killAsync).toBe(0);
    f.resolve({ exitCode: 0 }); await tick(); await tick();
    expect(sink).not.toHaveBeenCalled();
    expect(getShared("r1")!.exit).toEqual({ exitCode: 0 });
  });

  it("detach kills children that cannot survive and removes them", async () => {
    const f = fakeHandle();
    registerShared(init("fg", f.handle, { survivable: false }));
    await detachShared("s1", { ttlMs: 60_000 });
    expect(f.calls.killAsync).toBe(1);
    expect(getShared("fg")).toBeUndefined();
  });

  it("adoption rebinds, installs the sink, and delivers a gap completion exactly once", async () => {
    const f = fakeHandle(); const old = vi.fn(); const next = vi.fn();
    registerShared(init("r1", f.handle)); setSink("r1", old);
    await detachShared("s1", { ttlMs: 60_000 });
    f.resolve({ exitCode: 0, result: "late" }); await tick(); await tick();
    const res = adoptShared("s1", entry => { entry.sink = next; });
    expect(res.adopted).toEqual(["r1"]);
    await tick();
    expect(next).toHaveBeenCalledTimes(1);
    expect(old).not.toHaveBeenCalled();
    expect(getShared("r1")!.state).toBe("attached");
    // A second adoption pass cannot deliver again.
    expect(adoptShared("s1", entry => { entry.sink = next; }).adopted).toEqual([]);
    await tick();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("refuses duplicate adoption of an already attached entry", async () => {
    const f = fakeHandle();
    registerShared(init("r1", f.handle)); setSink("r1", () => {});
    await detachShared("s1", { ttlMs: 60_000 });
    expect(adoptShared("s1", e => { e.sink = () => {}; }).adopted).toEqual(["r1"]);
    const second = adoptShared("s1", e => { e.sink = () => {}; });
    expect(second.adopted).toEqual([]);
    expect(second.refused).toEqual([{ runId: "r1", reason: "already attached" }]);
  });

  it("refuses adoption by another session and leaves the entry detached", async () => {
    const f = fakeHandle();
    registerShared(init("r1", f.handle)); setSink("r1", () => {});
    await detachShared("s1", { ttlMs: 60_000 });
    const res = adoptShared("other", e => { e.sink = () => {}; });
    expect(res.adopted).toEqual([]);
    expect(res.refused).toEqual([{ runId: "r1", reason: "owned by another session" }]);
    expect(getShared("r1")!.state).toBe("detached");
  });

  it("ignores a registry at an unknown version and cleans it at disposal", async () => {
    const dispose = vi.fn(async () => {});
    const foreign = { version: 2, entries: new Map([["x", { weird: true }]]), disposeSession: dispose };
    (globalThis as any)[Symbol.for("spider.childRegistry.v2")] = foreign;
    try {
      // Our own registry is unaffected and never reads the foreign one.
      const reg = sharedRegistry();
      expect(reg.version).toBe(1);
      expect(reg.entries.size).toBe(0);
      expect(adoptShared("s1", () => {}).adopted).toEqual([]);
      await disposeSessionRegistries("s1", "quit");
      expect(dispose).toHaveBeenCalledWith("s1", "quit");
    } finally { delete (globalThis as any)[Symbol.for("spider.childRegistry.v2")]; }
  });

  it("replaces a malformed registry at our own key instead of trusting it", () => {
    (globalThis as any)[CHILD_REGISTRY_KEY] = { version: 1, entries: "not a map" };
    const reg = sharedRegistry();
    expect(reg.entries).toBeInstanceOf(Map);
  });

  it("a detached entry that is never adopted is killed and cancelled when its TTL elapses", async () => {
    vi.useFakeTimers();
    const f = fakeHandle(); const expired = vi.fn();
    registerShared(init("r1", f.handle)); setSink("r1", () => {});
    await detachShared("s1", { ttlMs: 1000, onExpire: expired });
    vi.advanceTimersByTime(1001);
    await vi.runAllTimersAsync();
    expect(f.calls.killAsync).toBe(1);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(getShared("r1")).toBeUndefined();
  });

  it("adoption cancels the TTL", async () => {
    vi.useFakeTimers();
    const f = fakeHandle(); const expired = vi.fn();
    registerShared(init("r1", f.handle)); setSink("r1", () => {});
    await detachShared("s1", { ttlMs: 1000, onExpire: expired });
    adoptShared("s1", e => { e.sink = () => {}; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(expired).not.toHaveBeenCalled();
    expect(f.calls.killAsync).toBe(0);
  });

  it("release removes the entry and its timer", async () => {
    const f = fakeHandle();
    registerShared(init("r1", f.handle));
    releaseShared("r1");
    expect(getShared("r1")).toBeUndefined();
  });

  it("disposeSessionRegistries kills every entry, including detached ones, and skips excluded runs", async () => {
    const a = fakeHandle(); const b = fakeHandle();
    registerShared(init("a", a.handle)); registerShared(init("b", b.handle));
    await detachShared("s1", { ttlMs: 60_000 });
    await disposeSessionRegistries("s1", "quit", { exclude: new Set(["b"]) });
    expect(a.calls.killAsync).toBe(1);
    expect(b.calls.killAsync).toBe(0);
    expect(getShared("a")).toBeUndefined();
  });
});

/** A run row in a real DB file, so registry code that finalizes rows BY PATH is exercised for real. */
function realRun(sessionId = "s1") {
  const path = testScratchPath(`registry-${randomUUID()}.db`);
  const db = openDbAt(path, "project");
  const store = new RunStore(db);
  const { id } = store.create({ sessionId, agent: "worker", task: "t" });
  store.start(id);
  return { path, db, store, id };
}

describe("session scope (I1)", () => {
  it("detachShared parks only the named session and leaves another session's entries and timers alone", async () => {
    const a = fakeHandle(); const b = fakeHandle(); const bSink = vi.fn();
    registerShared(init("a", a.handle)); registerShared(init("b", b.handle, { sessionId: "s2" }));
    setSink("a", () => {}); setSink("b", bSink);
    await detachShared("s1", { ttlMs: 60_000 });
    expect(getShared("a")!.state).toBe("detached");
    expect(getShared("b")!.state).toBe("attached");
    expect(b.calls.unbind).toBe(0);
    b.resolve({ exitCode: 0 });
    await tick(); await tick();
    expect(bSink).toHaveBeenCalledTimes(1);
  });

  it("parking is idempotent per entry: a second reload keeps the original TTL", async () => {
    const a = fakeHandle();
    registerShared(init("a", a.handle)); setSink("a", () => {});
    await detachShared("s1", { ttlMs: 60_000 });
    const first = getShared("a")!.timer;
    await detachShared("s1", { ttlMs: 60_000 });
    expect(getShared("a")!.timer).toBe(first);
  });

  it("detachShared kills a non-survivable entry of the named session only", async () => {
    const a = fakeHandle(); const b = fakeHandle();
    registerShared(init("a", a.handle, { survivable: false }));
    registerShared(init("b", b.handle, { survivable: false, sessionId: "s2" }));
    await detachShared("s1", { ttlMs: 60_000 });
    expect(a.calls.killAsync).toBe(1);
    expect(b.calls.killAsync).toBe(0);
    expect(getShared("a")).toBeUndefined();
    expect(getShared("b")).toBeDefined();
  });

  it("disposeSessionRegistries kills only the named session", async () => {
    const a = fakeHandle(); const b = fakeHandle();
    registerShared(init("a", a.handle)); registerShared(init("b", b.handle, { sessionId: "s2" }));
    await disposeSessionRegistries("s1", "quit");
    expect(a.calls.killAsync).toBe(1);
    expect(b.calls.killAsync).toBe(0);
    expect(getShared("b")).toBeDefined();
  });

  it("the v1 contract itself is per session: registry.disposeSession(sessionId, reason)", async () => {
    const a = fakeHandle(); const b = fakeHandle();
    registerShared(init("a", a.handle)); registerShared(init("b", b.handle, { sessionId: "s2" }));
    await sharedRegistry().disposeSession("s2", "bye");
    expect(b.calls.killAsync).toBe(1);
    expect(a.calls.killAsync).toBe(0);
  });
});

describe("failed adoption (I2)", () => {
  it("re-arms the TTL, goes back to detached, and the entry is still reaped on expiry", async () => {
    vi.useFakeTimers();
    const f = fakeHandle(); const expired = vi.fn();
    registerShared(init("r1", f.handle)); setSink("r1", () => {});
    await detachShared("s1", { ttlMs: 1000, onExpire: expired });
    const res = adoptShared("s1", () => { throw new Error("no row"); });
    expect(res.refused[0].reason).toMatch(/adoption failed: no row/);
    const e = getShared("r1")!;
    expect(e.state).toBe("detached");
    expect(e.timer).toBeDefined();
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.calls.killAsync).toBe(1);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(getShared("r1")).toBeUndefined();
  });

  it("a later adoption attempt can still succeed after a failed one", async () => {
    const f = fakeHandle();
    registerShared(init("r1", f.handle)); setSink("r1", () => {});
    await detachShared("s1", { ttlMs: 60_000 });
    adoptShared("s1", () => { throw new Error("transient"); });
    const res = adoptShared("s1", e => { e.sink = () => {}; });
    expect(res.adopted).toEqual(["r1"]);
    expect(getShared("r1")!.timer).toBeUndefined();
  });
});

describe("finalizing rows by DB path", () => {
  it("quit disposal of a detached, never-adopted child kills it and cancels its row with the reason (I3)", async () => {
    const r = realRun(); const f = fakeHandle();
    registerShared(init(r.id, f.handle, { dbPath: r.path })); setSink(r.id, () => {});
    await detachShared("s1", { ttlMs: 60_000 });
    await disposeSessionRegistries("s1", "Session shutdown cancelled this run.");
    expect(f.calls.killAsync).toBe(1);
    const row = r.store.get(r.id)!;
    expect(row.status).toBe("cancelled");
    expect(row.result).toBe("Session shutdown cancelled this run.");
  });

  it("the production TTL expiry (no onExpire override) kills the child and cancels the row", async () => {
    vi.useFakeTimers();
    const r = realRun(); const f = fakeHandle();
    registerShared(init(r.id, f.handle, { dbPath: r.path })); setSink(r.id, () => {});
    await detachShared("s1", { ttlMs: 1000, graceMs: 1 });
    await vi.advanceTimersByTimeAsync(1500);
    vi.useRealTimers();
    expect(f.calls.killAsync).toBe(1);
    const row = r.store.get(r.id)!;
    expect(row.status).toBe("cancelled");
    expect(row.result).toMatch(/never re-adopted/);
  });

  it("a run that finished during the gap gets its REAL terminal status on expiry, not cancelled (M2)", async () => {
    vi.useFakeTimers();
    const ok = realRun(); const bad = realRun(); const f1 = fakeHandle(); const f2 = fakeHandle();
    registerShared(init(ok.id, f1.handle, { dbPath: ok.path })); setSink(ok.id, () => {});
    registerShared(init(bad.id, f2.handle, { dbPath: bad.path })); setSink(bad.id, () => {});
    await detachShared("s1", { ttlMs: 1000, graceMs: 1 });
    f1.resolve({ exitCode: 0, result: "all good" });
    f2.resolve({ exitCode: 3, result: "it broke" });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1500);
    vi.useRealTimers();
    expect(ok.store.get(ok.id)).toMatchObject({ status: "done", result: "all good" });
    expect(bad.store.get(bad.id)).toMatchObject({ status: "failed" });
    expect(f1.calls.killAsync).toBe(0);
  });

  it("a run that finished during the gap gets its real status when quit disposes it (M2)", async () => {
    const r = realRun(); const f = fakeHandle();
    registerShared(init(r.id, f.handle, { dbPath: r.path })); setSink(r.id, () => {});
    await detachShared("s1", { ttlMs: 60_000 });
    f.resolve({ exitCode: 0, result: "done in the gap" });
    await tick(); await tick();
    await disposeSessionRegistries("s1", "Session shutdown cancelled this run.");
    expect(r.store.get(r.id)).toMatchObject({ status: "done", result: "done in the gap" });
    expect(f.calls.killAsync).toBe(0);
  });

  it("does not overwrite a row that is already terminal", async () => {
    const r = realRun(); const f = fakeHandle();
    registerShared(init(r.id, f.handle, { dbPath: r.path })); setSink(r.id, () => {});
    await detachShared("s1", { ttlMs: 60_000 });
    r.store.finish(r.id, { status: "done", result: "child reported itself" });
    await disposeSessionRegistries("s1", "Session shutdown cancelled this run.");
    expect(r.store.get(r.id)).toMatchObject({ status: "done", result: "child reported itself" });
  });

  it("the TTL timer is unref'd so it can never hold the host process open", async () => {
    const f = fakeHandle();
    registerShared(init("r1", f.handle)); setSink("r1", () => {});
    await detachShared("s1", { ttlMs: DEFAULT_DETACH_TTL_MS });
    expect((getShared("r1")!.timer as any).hasRef()).toBe(false);
  });
});

describe("exit sweep (a host that exits while children are still detached)", () => {
  it("terminates the detached child's process group and finalizes its row", async () => {
    const r = realRun(); const f = fakeHandle();
    registerShared(init(r.id, f.handle, { dbPath: r.path })); setSink(r.id, () => {});
    getShared(r.id)!.startTime = "linux:123";
    await detachShared("s1", { ttlMs: 60_000 });
    const kill = vi.fn();
    sweepDetachedOnExit({ kill, identity: () => true });
    if (process.platform !== "win32") expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
    expect(r.store.get(r.id)).toMatchObject({ status: "cancelled" });
  });

  it("never signals a pid whose recorded identity no longer matches, or one with no recorded identity", async () => {
    const a = realRun(); const b = realRun(); const fa = fakeHandle(); const fb = fakeHandle();
    registerShared(init(a.id, fa.handle, { dbPath: a.path })); setSink(a.id, () => {});
    registerShared(init(b.id, fb.handle, { dbPath: b.path })); setSink(b.id, () => {});
    getShared(a.id)!.startTime = "linux:1";
    await detachShared("s1", { ttlMs: 60_000 });
    const kill = vi.fn();
    sweepDetachedOnExit({ kill, identity: () => false });
    expect(kill).not.toHaveBeenCalled();
    expect(a.store.get(a.id)!.status).toBe("cancelled");
    expect(b.store.get(b.id)!.status).toBe("cancelled");
  });

  it("a child that already finished gets its real status and is not signalled", async () => {
    const r = realRun(); const f = fakeHandle();
    registerShared(init(r.id, f.handle, { dbPath: r.path })); setSink(r.id, () => {});
    getShared(r.id)!.startTime = "linux:123";
    await detachShared("s1", { ttlMs: 60_000 });
    f.resolve({ exitCode: 0, result: "finished in the gap" });
    await tick(); await tick();
    const kill = vi.fn();
    sweepDetachedOnExit({ kill, identity: () => true });
    expect(kill).not.toHaveBeenCalled();
    expect(r.store.get(r.id)).toMatchObject({ status: "done", result: "finished in the gap" });
  });

  it("leaves attached entries alone", async () => {
    const r = realRun(); const f = fakeHandle();
    registerShared(init(r.id, f.handle, { dbPath: r.path })); setSink(r.id, () => {});
    const kill = vi.fn();
    sweepDetachedOnExit({ kill, identity: () => true });
    expect(kill).not.toHaveBeenCalled();
    expect(r.store.get(r.id)!.status).toBe("running");
  });
});
