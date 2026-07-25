import { describe, it, expect, vi } from "vitest";
import { RunStore } from "../run-store";
import { resolveKillTargets, killRun } from "../kill";
import { freshDb } from "./helpers/testutil";

function seed() {
  const db = freshDb();
  const store = new RunStore(db);
  // NOTE: alpha-build and alpha-review deliberately SHARE the "alpha" prefix so the
  // ambiguity branch is reachable; beta-review is the unique-name control.
  const a = store.create({ sessionId: "s1", agent: "worker", name: "alpha-build", task: "t" });
  const b = store.create({ sessionId: "s1", agent: "worker", name: "beta-review", task: "t" });
  const c = store.create({ sessionId: "s1", agent: "worker", name: "alpha-review", task: "t" });
  store.start(a.id); store.start(b.id); store.start(c.id);
  return { db, store, a, b, c };
}

describe("resolveKillTargets", () => {
  it("resolves 'all' to every active run in the session", () => {
    const { store } = seed();
    expect(resolveKillTargets(store, "s1", "all")).toHaveLength(3);
  });

  it("resolves an exact run id", () => {
    const { store, a } = seed();
    const [row] = resolveKillTargets(store, "s1", a.id);
    expect(row.id).toBe(a.id);
  });

  it("resolves a unique id prefix", () => {
    const { store, a } = seed();
    const [row] = resolveKillTargets(store, "s1", a.id.slice(0, 8));
    expect(row.id).toBe(a.id);
  });

  it("prefers an exact name over a prefix match", () => {
    const { store, b } = seed();
    const [row] = resolveKillTargets(store, "s1", "beta-review");
    expect(row.id).toBe(b.id);
  });

  it("throws naming every candidate when a name prefix is ambiguous", () => {
    const { store } = seed();
    // "alpha" matches BOTH alpha-build and alpha-review.
    expect(() => resolveKillTargets(store, "s1", "alpha")).toThrow(/ambiguous/i);
    expect(() => resolveKillTargets(store, "s1", "alpha")).toThrow(/alpha-build/);
    expect(() => resolveKillTargets(store, "s1", "alpha")).toThrow(/alpha-review/);
  });

  it("throws asking for an id when the target is empty", () => {
    const { store } = seed();
    expect(() => resolveKillTargets(store, "s1", "")).toThrow(/required/i);
  });

  it("throws when nothing matches", () => {
    const { store } = seed();
    expect(() => resolveKillTargets(store, "s1", "nope")).toThrow(/no active run/i);
  });

  it("ignores runs belonging to another session", () => {
    const { store } = seed();
    expect(() => resolveKillTargets(store, "other-session", "alpha-build")).toThrow(/no active run/i);
  });
});

describe("killRun", () => {
  it("kills via the live in-process handle when present", async () => {
    const { db, store, a } = seed();
    store.setPid(a.id, 555, process.pid);
    const handle = { pid: 555, killed: false, wait: async () => ({ exitCode: 0 }), kill() { handle.killed = true; }, detach() {} };
    const res = await killRun({ store, db, getChild: () => handle as any }, "s1", store.get(a.id)!);
    expect(handle.killed).toBe(true);
    expect(res.via).toBe("handle");
    expect(res.outcome).toBe("killed");
    expect(store.get(a.id)!.status).toBe("cancelled");
  });

  it("falls back to the persisted pid when no handle is registered", async () => {
    const { db, store, a } = seed();
    store.setPid(a.id, 777, 4242);
    const kill = vi.fn(async () => "terminated" as const);
    const res = await killRun(
      { store, db, getChild: () => undefined, kill, alive: () => true },
      "s1", store.get(a.id)!,
    );
    expect(kill).toHaveBeenCalledWith(777, expect.anything());
    expect(res.via).toBe("pid");
    expect(store.get(a.id)!.status).toBe("cancelled");
  });

  it("is a no-op for an already-finished run", async () => {
    const { db, store, a } = seed();
    store.finish(a.id, { status: "done", result: "ok" });
    const kill = vi.fn();
    const res = await killRun({ store, db, getChild: () => undefined, kill: kill as any }, "s1", store.get(a.id)!);
    expect(res.outcome).toBe("already-finished");
    expect(kill).not.toHaveBeenCalled();
    expect(store.get(a.id)!.status).toBe("done");
  });

  it("still cancels the row when the pid is already dead", async () => {
    const { db, store, a } = seed();
    store.setPid(a.id, 888, 4242);
    const res = await killRun(
      { store, db, getChild: () => undefined, alive: () => false },
      "s1", store.get(a.id)!,
    );
    expect(res.outcome).toBe("no-process");
    expect(store.get(a.id)!.status).toBe("cancelled");
  });
});
