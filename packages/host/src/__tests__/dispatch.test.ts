// packages/host/src/__tests__/dispatch.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { registerAction, dispatch, clearActions, type ActionCtx } from "../dispatch.js";

// Handlers under test only read `args`; a minimal stub ctx satisfies the type.
const ctx = {} as unknown as ActionCtx;

beforeEach(() => clearActions());

describe("action dispatch", () => {
  it("routes to a registered handler", async () => {
    registerAction("remember", async (args) => ({ ok: true, got: args.action }));
    const res = await dispatch({ action: "remember" }, ctx);
    expect(res).toEqual({ ok: true, got: "remember" });
  });

  it("returns a not-implemented stub for unregistered actions", async () => {
    const res = await dispatch({ action: "search" }, ctx) as { error: string };
    expect(res.error).toMatch(/not.*implemented/i);
    expect(res.error).toContain("search");
  });

  it("rejects an unknown action name", async () => {
    const res = await dispatch({ action: "bogus" as never }, ctx) as { error: string };
    expect(res.error).toMatch(/unknown action/i);
  });
});
