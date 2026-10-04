import { afterEach, describe, expect, it, vi } from "vitest";
import { openDbAt } from "@spider/db-core";
import { makeGlobalMemDb, makeMemDb } from "./helpers/tmpdb";

const hook = vi.hoisted(() => ({ fn: undefined as undefined | (() => void) }));
vi.mock("../store", async importOriginal => {
  const orig = await importOriginal<typeof import("../store")>();
  return {
    ...orig,
    // Run a competing writer between approvePending's cap check and its activation.
    setStatus: (...args: Parameters<typeof orig.setStatus>) => {
      const fn = hook.fn; hook.fn = undefined; fn?.();
      return orig.setStatus(...args);
    },
  };
});

import { approvePending, stageWrite } from "../staging";
import { addMemory } from "../store";
import { activeCharTotal } from "../internal";
import { getMemory } from "../store";

let ctx: { db: import("@spider/db-core").Db; cleanup(): void } | undefined;
afterEach(() => { hook.fn = undefined; ctx?.cleanup(); ctx = undefined; });

describe("approvePending cap race", () => {
  it.each(["repo", "global"] as const)("does not exceed the %s cap when another connection writes between check and activation", scope => {
    ctx = scope === "repo" ? makeMemDb() : makeGlobalMemDb();
    stageWrite(ctx.db, scope, { category: "convention", content: "x".repeat(7800), source: "user" });
    const staged = stageWrite(ctx.db, scope, { category: "convention", content: "s".repeat(150), source: "user" }, { autoStage: true });
    expect(staged.status).toBe("staged");
    const other = openDbAt(ctx.db.raw.name, scope);
    other.raw.pragma("busy_timeout = 50");
    let competing: unknown = "not run";
    hook.fn = () => {
      try { addMemory(other, scope, { category: "convention", content: "y".repeat(100) }); competing = "committed"; }
      catch (e) { competing = e; }
    };
    let approveError: unknown;
    try {
      try { approvePending(ctx.db, scope, staged.uuid!); } catch (e) { approveError = e; }
    } finally { other.close(); }
    // Either the competitor is blocked, or approval is rejected; the cap must hold.
    expect(activeCharTotal(ctx.db, scope)).toBeLessThanOrEqual(8000);
    expect(activeCharTotal(ctx.db, scope)).toBe(7950);
    expect(getMemory(ctx.db, scope, staged.uuid!)?.status).toBe("active");
    expect(approveError).toBeUndefined();
    expect(String(competing)).toMatch(/locked/);
  });
});
