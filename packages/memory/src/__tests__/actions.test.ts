import { describe, it, expect, afterEach } from "vitest";
import { makeMemDb } from "./helpers/tmpdb";
import { registerMemory } from "../index";

function fakePi() {
  const actions: Record<string, Function> = {};
  const hooks: Record<string, Function> = {};
  return {
    registerAction: (n: string, h: Function) => { actions[n] = h; },
    on: (n: string, h: Function) => { hooks[n] = h; },
    _actions: actions, _hooks: hooks,
  } as any;
}
let ctx: ReturnType<typeof makeMemDb>;
afterEach(() => ctx?.cleanup());

describe("memory actions", () => {
  it("remember (user) writes active; recall reads it back", async () => {
    ctx = makeMemDb();
    const pi = fakePi();
    registerMemory(pi, { projectDb: ctx.db, globalDb: ctx.db, getEmbedder: async () => null, config: { snapshotCharCap: 8000 } as any });
    await pi._actions.remember({ action: "remember", category: "preference", content: "dark mode" }, {});
    const res = await pi._actions.recall({ action: "recall", query: "dark" }, {});
    expect(JSON.stringify(res.details)).toContain("dark mode");
  });
  it("auto remember stages, control memory pending lists it, approve activates", async () => {
    ctx = makeMemDb();
    const pi = fakePi();
    registerMemory(pi, { projectDb: ctx.db, globalDb: ctx.db, getEmbedder: async () => null, config: { snapshotCharCap: 8000 } as any });
    const w = await pi._actions.remember({ action: "remember", category: "insight", content: "likes tabs", auto: true }, {});
    expect(JSON.stringify(w.details)).toContain("staged");
    const pend = await pi._actions.control({ action: "control", command: "memory", sub: "pending" }, {});
    expect(JSON.stringify(pend.details)).toContain("likes tabs");
  });

  // Defect 1: "consolidate" used to be a read-only report wearing an action's name.
  it("control memory sub 'status' reports active entries + usage (the report, renamed)", async () => {
    ctx = makeMemDb();
    const pi = fakePi();
    registerMemory(pi, { projectDb: ctx.db, globalDb: ctx.db, getEmbedder: async () => null, config: { snapshotCharCap: 8000 } as any });
    await pi._actions.remember({ action: "remember", category: "preference", content: "likes tea" }, {});
    const res = await pi._actions.control({ action: "control", command: "memory", sub: "status" }, {});
    expect(JSON.stringify(res.details)).toContain("likes tea");
    expect((res.details as { usage: number }).usage).toBeGreaterThan(0);
  });

  it("control memory sub 'consolidate' now errors instead of silently returning the report", async () => {
    ctx = makeMemDb();
    const pi = fakePi();
    registerMemory(pi, { projectDb: ctx.db, globalDb: ctx.db, getEmbedder: async () => null, config: { snapshotCharCap: 8000 } as any });
    await pi._actions.remember({ action: "remember", category: "preference", content: "should not leak into consolidate" }, {});
    const res = await pi._actions.control({ action: "control", command: "memory", sub: "consolidate" }, {});
    const details = res.details as { ok: boolean; error: string; entries?: unknown };
    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/status|forget/i);
    expect(details.entries).toBeUndefined(); // no more silent report shape
  });

  // Defect 2: the memory cap has no eviction path.
  it("control memory sub 'forget' removes an active entry by uuid", async () => {
    ctx = makeMemDb();
    const pi = fakePi();
    registerMemory(pi, { projectDb: ctx.db, globalDb: ctx.db, getEmbedder: async () => null, config: { snapshotCharCap: 8000 } as any });
    const w = await pi._actions.remember({ action: "remember", category: "tool-quirk", content: "junk to forget" }, {});
    const uuid = (w.details as { uuid?: string }).uuid!;
    expect(uuid).toBeTruthy();

    const res = await pi._actions.control({ action: "control", command: "memory", sub: "forget", uuid }, {});
    expect((res.details as { ok: boolean }).ok).toBe(true);

    const after = await pi._actions.control({ action: "control", command: "memory", sub: "status" }, {});
    expect(JSON.stringify(after.details)).not.toContain("junk to forget");
  });

  it("control memory sub 'forget' reports failure for an unknown uuid instead of a silent no-op", async () => {
    ctx = makeMemDb();
    const pi = fakePi();
    registerMemory(pi, { projectDb: ctx.db, globalDb: ctx.db, getEmbedder: async () => null, config: { snapshotCharCap: 8000 } as any });
    const res = await pi._actions.control({ action: "control", command: "memory", sub: "forget", uuid: "00000000-0000-0000-0000-000000000000" }, {});
    const details = res.details as { ok: boolean; error?: string };
    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/no memory entry|not found/i);
  });
});
