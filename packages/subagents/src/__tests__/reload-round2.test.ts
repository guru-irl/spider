import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { openDbAt } from "@spider/db-core";
import { freshDb, testScratchPath } from "./helpers/testutil";
import { resetSharedRegistryForTests, getShared } from "../child-registry";
import type { ChildHandle, Spawner } from "../runner";

// Each "activation" gets a FRESH module graph (vi.resetModules), like a rebuilt bundle after /reload.
// Only globalThis (the shared child registry) is common. `loadBuild` is also reused WITHOUT a reset
// to model an unchanged bundle, where the shim hands the reloaded activation the same module.
type Mods = { index: typeof import("../index"); run: typeof import("../actions/run"); coords: typeof import("../coordinators") };
async function loadBuild(): Promise<Mods> {
  vi.resetModules();
  return { index: await import("../index"), run: await import("../actions/run"), coords: await import("../coordinators") };
}

function fakeChild(pid = 4242) {
  let resolve!: (v: { exitCode: number; result?: string }) => void;
  const exit = new Promise<{ exitCode: number; result?: string }>(r => { resolve = r; });
  const calls = { kill: 0, killAsync: 0, unbind: 0, bind: 0 };
  let bound: ((e: Record<string, any>) => void) | undefined;
  const handle: ChildHandle & Record<string, any> = {
    pid, wait: () => exit, detach: () => {},
    kill() { calls.kill++; resolve({ exitCode: 143 }); },
    async killAsync() { calls.killAsync++; resolve({ exitCode: 143 }); },
    async steer() { return { accepted: true }; },
    unbindEvents() { calls.unbind++; bound = undefined; },
    bindEvents(sink: (e: Record<string, any>) => void) { calls.bind++; bound = sink; },
  };
  return { handle, resolve, calls, bound: () => bound };
}

const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };
function workdir(): string { const d = testScratchPath("reload-cwd"); mkdirSync(d, { recursive: true }); return d; }

interface Fixture { db: ReturnType<typeof freshDb>; sessionId: string; pi: { sendMessage: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }; hooks: Map<string, (...a: any[]) => any>; ctx: any }
function activation(db: Fixture["db"], sessionId = "sess"): Fixture {
  const hooks = new Map<string, (...a: any[]) => any>();
  const pi = { sendMessage: vi.fn(), on: vi.fn((name: string, fn: (...a: any[]) => any) => { hooks.set(name, fn); }) };
  const ui = { notify: vi.fn() };
  return { db, sessionId, pi, hooks, ctx: { db, sessionId, cwd: workdir(), pi, ui, runDbPath: "/nowhere/project.db", childMode: "rpc" } };
}
/** What pi passes to a session_shutdown handler: the ending session's context. */
const sessionCtx = (sessionId: string) => ({ sessionManager: { getSessionId: () => sessionId } });
const shutdown = (a: Fixture, reason: string) => a.hooks.get("session_shutdown")!({ type: "session_shutdown", reason }, sessionCtx(a.sessionId));

beforeEach(() => { vi.stubEnv("PI_SUBAGENT_CHILD", "0"); resetSharedRegistryForTests(); });
afterEach(async () => {
  const coords = await import("../coordinators");
  coords.teardownAll(); resetSharedRegistryForTests(); vi.unstubAllEnvs(); vi.useRealTimers();
});

async function launch(mods: Mods, a: Fixture, child: ReturnType<typeof fakeChild>, args: Record<string, unknown> = { task: "do it", agent: "worker", name: "bg" }) {
  const spawner: Spawner = () => child.handle;
  mods.index.registerSubagentActions({ registerAction: () => {} }, a.pi);
  const out = await mods.run.makeRunHandler({ spawner })(args, a.ctx);
  return out.details.run ?? out.details;
}
const done = (pi: Fixture["pi"]) => pi.sendMessage.mock.calls.filter(c => c[0]?.customType === "spider.subagent_done");
const status = (db: Fixture["db"], id: string) => (db.prepare("SELECT status FROM runs WHERE id=?").get(id) as any).status;

describe("I1: every registry operation is scoped to one session", () => {
  it("reloading session A neither detaches nor re-times session B's child", async () => {
    const dbA = freshDb(), dbB = freshDb();
    const childA = fakeChild(1), childB = fakeChild(2);
    const build = await loadBuild();
    const A = activation(dbA, "A"), B = activation(dbB, "B");
    const runA = await launch(build, A, childA);
    const runB = await launch(build, B, childB);

    await shutdown(A, "reload");

    expect(getShared(runA.id)?.state).toBe("detached");
    expect(getShared(runB.id)?.state).toBe("attached");
    expect(childB.calls.unbind).toBe(0);
    childB.resolve({ exitCode: 0, result: "B finished" });
    await tick();
    expect(done(B.pi)).toHaveLength(1);
    expect(status(dbB, runB.id)).toBe("done");
  });

  it("reloading A does not restart the TTL of an already detached B", async () => {
    const dbA = freshDb(), dbB = freshDb();
    const build = await loadBuild();
    const A = activation(dbA, "A"), B = activation(dbB, "B");
    await launch(build, A, fakeChild(1));
    const runB = await launch(build, B, fakeChild(2));
    await shutdown(B, "reload");
    const before = getShared(runB.id)!;
    const timer = before.timer, at = before.detachedAt;
    expect(timer).toBeDefined();
    await shutdown(A, "reload");
    expect(getShared(runB.id)!.timer).toBe(timer);
    expect(getShared(runB.id)!.detachedAt).toBe(at);
  });

  it.each(["quit", "new", "resume", "fork"])("%s of session A does not kill session B's child", async reason => {
    const dbA = freshDb(), dbB = freshDb();
    const childA = fakeChild(1), childB = fakeChild(2);
    const build = await loadBuild();
    const A = activation(dbA, "A"), B = activation(dbB, "B");
    await launch(build, A, childA);
    const runB = await launch(build, B, childB);

    await shutdown(A, reason);

    expect(childA.calls.killAsync + childA.calls.kill).toBeGreaterThan(0);
    expect(childB.calls.killAsync + childB.calls.kill).toBe(0);
    expect(getShared(runB.id)?.state).toBe("attached");
    expect(status(dbB, runB.id)).toBe("running");
    childB.resolve({ exitCode: 0, result: "still fine" });
    await tick();
    expect(status(dbB, runB.id)).toBe("done");
  });

  it("quit of A also leaves B's detached (reloaded, not yet adopted) child alone", async () => {
    const dbA = freshDb(), dbB = freshDb();
    const childB = fakeChild(2);
    const build = await loadBuild();
    const A = activation(dbA, "A"), B = activation(dbB, "B");
    await launch(build, A, fakeChild(1));
    const runB = await launch(build, B, childB);
    await shutdown(B, "reload");
    await shutdown(A, "quit");
    expect(childB.calls.killAsync + childB.calls.kill).toBe(0);
    expect(getShared(runB.id)?.state).toBe("detached");
    expect(status(dbB, runB.id)).toBe("running");
  });
});

describe("I3: quit disposes children that were detached but never adopted", () => {
  it("kills the child and finalizes its row as cancelled with a shutdown reason", async () => {
    const path = testScratchPath(`reload-${randomUUID()}.db`);
    const db = openDbAt(path, "project");
    const child = fakeChild();
    const A = activation(db);
    A.ctx.runDbPath = path; // the registry finalizes the row through the entry's own DB path
    const run = await launch(await loadBuild(), A, child);
    await shutdown(A, "reload");
    expect(status(db, run.id)).toBe("running");

    // The reloaded activation never adopted (bundle failed, or no session_start). Quit arrives.
    const B = activation(db);
    const buildB = await loadBuild();
    buildB.index.registerSubagentActions({ registerAction: () => {} }, B.pi);
    await shutdown(B, "quit");

    expect(child.calls.killAsync + child.calls.kill).toBe(1);
    const row = db.prepare("SELECT status,result FROM runs WHERE id=?").get(run.id) as any;
    expect(row.status).toBe("cancelled");
    expect(row.result).toMatch(/shutdown/i);
    expect(getShared(run.id)).toBeUndefined();
  });
});

describe("I4: a chain step killed by a reload starts no model turn in the old pi", () => {
  it("sends no triggerTurn message through the old pi", async () => {
    const db = freshDb();
    const child = fakeChild();
    const A = activation(db);
    const mods = await loadBuild();
    mods.index.registerSubagentActions({ registerAction: () => {} }, A.pi);
    await mods.run.makeRunHandler({ spawner: (() => child.handle) as Spawner })({ chain: [{ agent: "worker", task: "one" }, { agent: "worker", task: "two" }] }, A.ctx);
    await tick();
    await shutdown(A, "reload");
    await tick();
    expect(A.pi.sendMessage.mock.calls.filter(c => c[1]?.triggerTurn === true)).toEqual([]);
  });

  it("the cancellation reason and the notifier agree for every shutdown kind", async () => {
    const { shutdownReason, isShutdownReason, SHUTDOWN_KINDS } = await import("../shutdown-reason");
    const { makeAsyncNotifier } = await import("../actions/run");
    expect(SHUTDOWN_KINDS.length).toBeGreaterThanOrEqual(2);
    for (const kind of SHUTDOWN_KINDS) {
      const reason = shutdownReason(kind);
      expect(isShutdownReason(reason)).toBe(true);
      const pi = { sendMessage: vi.fn() };
      makeAsyncNotifier({ pi, ui: { notify: vi.fn() }, db: freshDb() })({ id: "r", agent: "worker" }, "cancelled", reason);
      expect(pi.sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
    }
    const pi = { sendMessage: vi.fn() };
    makeAsyncNotifier({ pi, ui: { notify: vi.fn() }, db: freshDb() })({ id: "r", agent: "worker" }, "cancelled", "killed by somebody else");
    expect(pi.sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: true });
  });
});

describe("I6: the parent is told when a reload dropped later pipeline stages", () => {
  it("the stage's completion notice says so", async () => {
    const db = freshDb();
    const child = fakeChild();
    const A = activation(db);
    const buildA = await loadBuild();
    buildA.index.registerSubagentActions({ registerAction: () => {} }, A.pi);
    await buildA.run.makeRunHandler({ spawner: (() => child.handle) as Spawner })({
      pipeline: [{ agent: "worker", task: "one" }, { agent: "worker", task: "two" }],
    }, A.ctx);
    await shutdown(A, "reload");
    child.resolve({ exitCode: 0, result: "stage one result" });
    await tick();

    const B = activation(db);
    const buildB = await loadBuild();
    buildB.run.adoptReloadedChildren(B.ctx);
    await tick();
    expect(done(B.pi)).toHaveLength(1);
    const content: string = done(B.pi)[0][0].content;
    expect(content).toContain("stage one result");
    expect(content).toMatch(/reload/i);
    expect(content).toMatch(/later stages|remaining stages/i);
  });
});

describe("I2: a failed adoption is reported and the child stays under a TTL", () => {
  it("notifies the user, keeps the entry detached, and re-arms the timer", async () => {
    const dbA = freshDb(), dbOther = freshDb();
    const child = fakeChild();
    const A = activation(dbA);
    const run = await launch(await loadBuild(), A, child);
    await shutdown(A, "reload");

    // The reloaded activation resolved a DB that has no row for this run: Runner.adopt throws.
    const B = activation(dbOther);
    const res = (await loadBuild()).run.adoptReloadedChildren(B.ctx);

    expect(res.adopted).toEqual([]);
    expect(res.refused[0]?.reason).toMatch(/adoption failed/);
    const entry = getShared(run.id)!;
    expect(entry.state).toBe("detached");
    expect(entry.timer).toBeDefined();
    expect(B.ctx.ui.notify).toHaveBeenCalled();
    expect(String(B.ctx.ui.notify.mock.calls[0][0])).toMatch(/adopt/i);
  });
});

describe("I7: claims the first round could not detect", () => {
  it("unchanged bundle: the SAME module instance reloads, adopts, and only the new pi is called", async () => {
    const db = freshDb();
    const child = fakeChild();
    const A = activation(db);
    const mods = await loadBuild();
    const run = await launch(mods, A, child);
    await shutdown(A, "reload");

    const B = activation(db);
    mods.index.registerSubagentActions({ registerAction: () => {} }, B.pi);
    const res = mods.run.adoptReloadedChildren(B.ctx);
    expect(res.adopted).toEqual([run.id]);

    // An escalation raised in the gap/after adoption reaches the NEW pi only.
    db.prepare("INSERT INTO run_events (run_id, session_id, ts, type, summary, payload) VALUES (?,?,?,?,?,?)")
      .run(run.id, "sess", Date.now(), "escalation", "need help", JSON.stringify({ severity: "blocked" }));
    mods.coords.getCoordinators("sess", () => { throw new Error("tailer must exist after adoption"); }).tailer.poll();
    await tick();
    const esc = (pi: Fixture["pi"]) => pi.sendMessage.mock.calls.filter(c => c[0]?.customType === "spider.escalation");
    expect(esc(B.pi)).toHaveLength(1);
    expect(esc(A.pi)).toHaveLength(0);

    child.resolve({ exitCode: 0, result: "fin" });
    await tick();
    expect(done(B.pi)).toHaveLength(1);
    expect(done(A.pi)).toHaveLength(0);
  });

  it("escalations raised in the reload gap are delivered by the adopting activation", async () => {
    const db = freshDb();
    const child = fakeChild();
    const A = activation(db);
    const run = await launch(await loadBuild(), A, child);
    await shutdown(A, "reload");
    db.prepare("INSERT INTO run_events (run_id, session_id, ts, type, summary, payload) VALUES (?,?,?,?,?,?)")
      .run(run.id, "sess", Date.now(), "escalation", "gap help", JSON.stringify({ severity: "blocked" }));
    const B = activation(db);
    const buildB = await loadBuild();
    buildB.run.adoptReloadedChildren(B.ctx);
    buildB.coords.getCoordinators("sess", () => { throw new Error("x"); }).tailer.poll();
    await tick();
    expect(B.pi.sendMessage.mock.calls.filter(c => c[0]?.customType === "spider.escalation")).toHaveLength(1);
    expect(A.pi.sendMessage.mock.calls.filter(c => c[0]?.customType === "spider.escalation")).toHaveLength(0);
  });

  it("after detach nothing calls into the old activation's DB or pi (separate connections, A's closed)", async () => {
    const path = testScratchPath(`reload-${randomUUID()}.db`);
    const dbA = openDbAt(path, "project"), dbB = openDbAt(path, "project");
    const child = fakeChild();
    const A = activation(dbA);
    const run = await launch(await loadBuild(), A, child);
    await shutdown(A, "reload");
    const aCalls = A.pi.sendMessage.mock.calls.length;
    dbA.close();

    const B = activation(dbB);
    const buildB = await loadBuild();
    expect(buildB.run.adoptReloadedChildren(B.ctx).adopted).toEqual([run.id]);
    // kill-failure style warning and the completion both go through the NEW activation.
    child.bound()!({ type: "warning", message: "after adoption" });
    child.resolve({ exitCode: 0, result: "all done" });
    await tick();

    expect(A.pi.sendMessage.mock.calls.length).toBe(aCalls);
    expect(done(B.pi)).toHaveLength(1);
    expect(status(dbB, run.id)).toBe("done");
    const warned = dbB.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='warning'").all(run.id) as any[];
    expect(warned.map(r => r.summary)).toContain("after adoption");
    dbB.close();
  });
});
