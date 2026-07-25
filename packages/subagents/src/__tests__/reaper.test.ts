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
    await reapOrphanRuns({ db, alive: (pid) => pid === 999, kill, selfPid: 1 });
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
});
