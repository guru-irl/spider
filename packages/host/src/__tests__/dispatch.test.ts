// packages/host/src/__tests__/dispatch.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { registerAction, dispatch, clearActions, type ActionCtx } from "../dispatch";

// Handlers under test only read `args`; a minimal stub ctx satisfies the type.
const ctx = {} as unknown as ActionCtx;

beforeEach(() => clearActions());

describe("action dispatch", () => {
  it("routes to a registered handler", async () => {
    registerAction("remember", async (args) => ({ ok: true, got: args.action }));
    const res = await dispatch({ action: "remember" }, ctx);
    expect(res).toEqual({ ok: true, got: "remember" });
  });

  it("returns an honest 'no registered handler' diagnostic for unregistered actions (no Phase-0 'not implemented' stub)", async () => {
    const res = await dispatch({ action: "search" }, ctx) as { error: string };
    expect(res.error).toMatch(/no registered handler/i);
    expect(res.error).toContain("search");
  });

  it("rejects an unknown action name", async () => {
    const res = await dispatch({ action: "bogus" as never }, ctx) as { error: string };
    expect(res.error).toMatch(/unknown action/i);
  });

  it("routes 'kill' action through dispatch without error", async () => {
    // Critical: 'kill' must be in SpiderAction union AND VALID set for dispatch to succeed
    registerAction("kill", async (args) => ({ ok: true, details: { killed: [], requested: args.id ?? "all" } }));
    const res = await dispatch({ action: "kill" as any, id: "all" }, ctx) as any;
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
  });
});
