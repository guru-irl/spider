import { describe, it, expect, vi } from "vitest";
import { RunStore } from "../run-store";
import { reapOrphanRuns } from "../reaper";
import { freshDb } from "./helpers/testutil";

describe("reapOrphanRuns", () => {
  it("cancels a running run whose owning host is dead", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    store.setPid(id, 999, 12345);
    const res = await reapOrphanRuns({ db, alive: (pid) => pid === 999, kill: vi.fn(async () => {}), selfPid: 1 });
    expect(res.reaped).toContain(id);
    expect(store.get(id)!.status).toBe("cancelled");
  });

  it("kills the orphaned child process when it is still alive", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    store.setPid(id, 999, 12345);
    const kill = vi.fn(async () => {});
    const probeCommand = vi.fn(() => "pi --mode json -p --session /x/session.jsonl Task: work");
    await reapOrphanRuns({ db, alive: (pid) => pid === 999, kill, selfPid: 1, probeCommand });
    expect(kill).toHaveBeenCalledWith(999);
  });

  it("LEAVES ALONE a run whose owning host is still alive", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    store.setPid(id, 999, 4242);
    const kill = vi.fn(async () => {});
    const res = await reapOrphanRuns({ db, alive: () => true, kill, selfPid: 1 });
    expect(res.reaped).toHaveLength(0);
    expect(kill).not.toHaveBeenCalled();
    expect(store.get(id)!.status).toBe("running");
  });

  it("ignores runs that never recorded a host pid", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    const res = await reapOrphanRuns({ db, alive: () => false, kill: vi.fn(async () => {}), selfPid: 1 });
    expect(res.reaped).toHaveLength(0);
    expect(store.get(id)!.status).toBe("running");
  });

  it("never reaps runs owned by selfPid", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    store.setPid(id, 999, 5555);
    const kill = vi.fn(async () => {});
    const res = await reapOrphanRuns({ db, alive: () => false, kill, selfPid: 5555 });
    expect(res.reaped).toHaveLength(0);
    expect(kill).not.toHaveBeenCalled();
    expect(store.get(id)!.status).toBe("running");
  });

  it("does not signal a child pid that is already dead", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    store.setPid(id, 999, 12345);
    const kill = vi.fn(async () => {});
    // Provide probeCommand that would confirm identity, so alive() is the only guard
    const probeCommand = vi.fn(() => "pi --mode json -p --session /x/session.jsonl Task: work");
    const res = await reapOrphanRuns({ db, alive: () => false, kill, selfPid: 1, probeCommand });
    expect(kill).not.toHaveBeenCalled();
    expect(res.reaped).toContain(id);
  });

  it("returns error when SELECT throws", async () => {
    const db = freshDb();
    const badDb = { prepare: () => { throw new Error("SQLITE_BUSY"); } } as any;
    const res = await reapOrphanRuns({ db: badDb });
    expect(res.reaped).toEqual([]);
    expect(res.error).toBe("SQLITE_BUSY");
  });

  it("uses production defaults when no doubles are provided", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    store.setPid(id, 12345, process.pid); // host_pid is this process, so shouldn't be reaped
    const res = await reapOrphanRuns({ db });
    expect(res.reaped).toHaveLength(0);
    expect(store.get(id)!.status).toBe("running");
  });
});

  it("kills orphaned child when process identity confirms it is a subagent", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    store.setPid(id, 999, 12345);
    const kill = vi.fn(async () => {});
    const probeCommand = vi.fn(() => "pi --mode json -p --session /x/session.jsonl Task: work");
    await reapOrphanRuns({ db, alive: (pid) => pid === 999, kill, selfPid: 1, probeCommand });
    expect(kill).toHaveBeenCalledWith(999);
    expect(store.get(id)!.status).toBe("cancelled");
  });

  it("does NOT kill when pid is alive but identity shows it is NOT a subagent (pid reused)", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    store.setPid(id, 999, 12345);
    const kill = vi.fn(async () => {});
    const probeCommand = vi.fn(() => "/usr/bin/postgres -D /var/lib/postgresql/data");
    await reapOrphanRuns({ db, alive: (pid) => pid === 999, kill, selfPid: 1, probeCommand });
    expect(kill).not.toHaveBeenCalled();
    expect(store.get(id)!.status).toBe("cancelled");
  });

  it("does NOT kill when probe returns null (unknown identity), but still cancels row", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    store.setPid(id, 999, 12345);
    const kill = vi.fn(async () => {});
    const probeCommand = vi.fn(() => null);
    await reapOrphanRuns({ db, alive: (pid) => pid === 999, kill, selfPid: 1, probeCommand });
    expect(kill).not.toHaveBeenCalled();
    expect(store.get(id)!.status).toBe("cancelled");
  });
