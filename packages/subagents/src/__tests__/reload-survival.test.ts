import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { freshDb, testScratchPath } from "./helpers/testutil";
import { resetSharedRegistryForTests, getShared } from "../child-registry";
import type { ChildHandle, Spawner } from "../runner";

// Every "activation" gets a FRESH module graph (vi.resetModules), the way a rebuilt bundle
// does after /reload. Only globalThis (the shared child registry) is common to both.
type Mods = { index: typeof import("../index"); run: typeof import("../actions/run"); coords: typeof import("../coordinators") };
async function loadBuild(): Promise<Mods> {
  vi.resetModules();
  return { index: await import("../index"), run: await import("../actions/run"), coords: await import("../coordinators") };
}

function fakeChild() {
  let resolve!: (v: { exitCode: number; result?: string }) => void;
  const exit = new Promise<{ exitCode: number; result?: string }>(r => { resolve = r; });
  const calls = { kill: 0, killAsync: 0, unbind: 0, bind: 0, steer: [] as string[] };
  let bound: ((e: Record<string, any>) => void) | undefined;
  const handle: ChildHandle & Record<string, any> = {
    pid: 4242, wait: () => exit, detach: () => {},
    kill() { calls.kill++; resolve({ exitCode: 143 }); },
    async killAsync() { calls.killAsync++; resolve({ exitCode: 143 }); },
    async steer(m: string) { calls.steer.push(m); return { accepted: true }; },
    unbindEvents() { calls.unbind++; bound = undefined; },
    bindEvents(sink: (e: Record<string, any>) => void) { calls.bind++; bound = sink; },
  };
  return { handle, resolve, calls, bound: () => bound };
}

function workdir(): string { const d = testScratchPath("reload-cwd"); mkdirSync(d, { recursive: true }); return d; }
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

interface Fixture { db: ReturnType<typeof freshDb>; pi: { sendMessage: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }; hooks: Map<string, (...a: any[]) => any>; ctx: any }
function activation(db: Fixture["db"], sessionId = "sess"): Fixture {
  const hooks = new Map<string, (...a: any[]) => any>();
  const pi = { sendMessage: vi.fn(), on: vi.fn((name: string, fn: (...a: any[]) => any) => { hooks.set(name, fn); }) };
  return { db, pi, hooks, ctx: { db, sessionId, cwd: workdir(), pi, runDbPath: "/nowhere/project.db", childMode: "rpc" } };
}

beforeEach(() => { vi.stubEnv("PI_SUBAGENT_CHILD", "0"); resetSharedRegistryForTests(); });
afterEach(async () => {
  const { coords } = { coords: await import("../coordinators") };
  coords.teardownAll(); resetSharedRegistryForTests(); vi.unstubAllEnvs();
});

async function launch(mods: Mods, a: Fixture, child: ReturnType<typeof fakeChild>, args: Record<string, unknown> = { task: "do it", agent: "worker", name: "bg" }) {
  const spawner: Spawner = () => child.handle;
  mods.index.registerSubagentActions({ registerAction: () => {} }, a.pi);
  const handler = mods.run.makeRunHandler({ spawner });
  const out = await handler(args, a.ctx);
  return out.details.run ?? out.details;
}
const done = (pi: Fixture["pi"]) => pi.sendMessage.mock.calls.filter(c => c[0]?.customType === "spider.subagent_done");

describe("subagents survive /reload", () => {
  it("keeps the child on reload, finalizes in the gap, and notifies exactly once from the NEW activation", async () => {
    const db = freshDb();
    const child = fakeChild();
    const A = activation(db);
    const buildA = await loadBuild();
    const run = await launch(buildA, A, child);
    expect(run.status).toBe("running");

    await A.hooks.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, { sessionManager: { getSessionId: () => "sess" } });
    expect(child.calls.kill + child.calls.killAsync).toBe(0);
    expect(child.calls.unbind).toBe(1);

    // The child completes while no activation is attached.
    child.resolve({ exitCode: 0, result: "final answer" });
    await tick();
    expect(done(A.pi)).toHaveLength(0);
    expect(getShared(run.id)?.exit).toEqual({ exitCode: 0, result: "final answer" });

    const B = activation(db);
    const buildB = await loadBuild();
    expect(buildB.coords).not.toBe(buildA.coords);
    const res = buildB.run.adoptReloadedChildren(B.ctx);
    expect(res.adopted).toEqual([run.id]);
    await tick();

    expect(done(B.pi)).toHaveLength(1);
    expect(done(B.pi)[0][0].content).toContain("final answer");
    expect(done(A.pi)).toHaveLength(0);
    expect((db.prepare("SELECT status FROM runs WHERE id=?").get(run.id) as any).status).toBe("done");
    expect(getShared(run.id)).toBeUndefined();

    // A second adoption pass, and the old activation's own shutdown path, add nothing.
    buildB.run.adoptReloadedChildren(B.ctx);
    await buildB.index.teardownAllAsync?.();
    await tick();
    expect(done(B.pi)).toHaveLength(1);
    expect(done(A.pi)).toHaveLength(0);
  });

  it("after adoption steering, kill handles and rebound events all target the new activation", async () => {
    const db = freshDb();
    const child = fakeChild();
    const A = activation(db);
    const run = await launch(await loadBuild(), A, child);
    await A.hooks.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, { sessionManager: { getSessionId: () => "sess" } });

    const B = activation(db);
    const buildB = await loadBuild();
    expect(buildB.coords.getChild("sess", run.id)).toBeUndefined();
    buildB.run.adoptReloadedChildren(B.ctx);
    expect(child.calls.bind).toBe(1);
    const owned = buildB.coords.getChild("sess", run.id)!;
    expect(await owned.steer!("hello")).toEqual({ accepted: true });
    expect(child.calls.steer).toEqual(["hello"]);

    // Events reach the NEW run DB through the rebound sink.
    child.bound()!({ type: "warning", message: "gap warning" });
    const rows = db.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='warning'").all(run.id) as any[];
    expect(rows.map(r => r.summary)).toContain("gap warning");

    // kill works through the adopted handle and the completion is a single cancelled notice.
    await owned.killAsync!(50, "killed by test");
    await tick();
    expect((db.prepare("SELECT status FROM runs WHERE id=?").get(run.id) as any).status).toBe("cancelled");
  });

  it("quit after a reload kills the adopted child", async () => {
    const db = freshDb();
    const child = fakeChild();
    const A = activation(db);
    const run = await launch(await loadBuild(), A, child);
    await A.hooks.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, { sessionManager: { getSessionId: () => "sess" } });
    const B = activation(db);
    const buildB = await loadBuild();
    buildB.index.registerSubagentActions({ registerAction: () => {} }, B.pi);
    buildB.run.adoptReloadedChildren(B.ctx);
    await B.hooks.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, { sessionManager: { getSessionId: () => "sess" } });
    expect(child.calls.killAsync).toBe(1);
    await tick();
    expect(getShared(run.id)).toBeUndefined();
  });

  it.each(["quit", "new", "resume", "fork"])("%s still kills the child", async reason => {
    const db = freshDb();
    const child = fakeChild();
    const A = activation(db);
    await launch(await loadBuild(), A, child);
    await A.hooks.get("session_shutdown")!({ type: "session_shutdown", reason }, { sessionManager: { getSessionId: () => "sess" } });
    expect(child.calls.killAsync + child.calls.kill).toBeGreaterThan(0);
  });

  it("a shutdown without a reason keeps today's behaviour (kill)", async () => {
    const db = freshDb();
    const child = fakeChild();
    const A = activation(db);
    await launch(await loadBuild(), A, child);
    await A.hooks.get("session_shutdown")!();
    expect(child.calls.killAsync + child.calls.kill).toBeGreaterThan(0);
  });

  it("refuses adoption by another session and leaves the child running", async () => {
    const db = freshDb();
    const child = fakeChild();
    const A = activation(db);
    const run = await launch(await loadBuild(), A, child);
    await A.hooks.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, { sessionManager: { getSessionId: () => "sess" } });
    const B = activation(db, "someone-else");
    const buildB = await loadBuild();
    const res = buildB.run.adoptReloadedChildren(B.ctx);
    expect(res.adopted).toEqual([]);
    expect(getShared(run.id)?.state).toBe("detached");
    expect(child.calls.kill + child.calls.killAsync).toBe(0);
  });

  it("print-mode children survive reload the same way", async () => {
    const db = freshDb();
    const child = fakeChild();
    delete (child.handle as any).steer; delete (child.handle as any).bindEvents; delete (child.handle as any).unbindEvents;
    const A = activation(db);
    A.ctx.childMode = "print";
    const run = await launch(await loadBuild(), A, child);
    await A.hooks.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, { sessionManager: { getSessionId: () => "sess" } });
    child.resolve({ exitCode: 0, result: "print result" });
    await tick();
    const B = activation(db);
    B.ctx.childMode = "print";
    const buildB = await loadBuild();
    buildB.run.adoptReloadedChildren(B.ctx);
    await tick();
    expect(done(B.pi)).toHaveLength(1);
    expect(done(B.pi)[0][0].content).toContain("print result");
    expect(done(A.pi)).toHaveLength(0);
    expect(run.id).toBeTruthy();
  });

  it("a foreground chain step cannot survive: reload kills it", async () => {
    const db = freshDb();
    const child = fakeChild();
    const A = activation(db);
    const mods = await loadBuild();
    const spawner: Spawner = () => child.handle;
    mods.index.registerSubagentActions({ registerAction: () => {} }, A.pi);
    const handler = mods.run.makeRunHandler({ spawner });
    await handler({ chain: [{ agent: "worker", task: "step one" }] }, A.ctx);
    await tick();
    await A.hooks.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, { sessionManager: { getSessionId: () => "sess" } });
    expect(child.calls.killAsync + child.calls.kill).toBeGreaterThan(0);
  });
});
