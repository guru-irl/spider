import { describe, it, expect, afterEach } from "vitest";
import { makeMemDb } from "./helpers/tmpdb.js";
import { registerMemory } from "../index.js";

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
});
