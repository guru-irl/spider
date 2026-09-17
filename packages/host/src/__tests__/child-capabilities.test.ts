import { afterEach, describe, expect, it, vi } from "vitest";
import { clearActions, dispatch, type ActionCtx } from "../dispatch";

afterEach(() => { clearActions(); vi.unstubAllEnvs(); });

describe("child capability diagnostics", () => {
  it.each(["run", "message", "kill"] as const)("explains why %s is unavailable in a one-shot child", async action => {
    clearActions();
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    const result = await dispatch({ action }, {} as ActionCtx) as { error: string; code?: string };
    expect(result.code).toBe("unavailable_in_child");
    expect(result.error).toMatch(/parent|orchestrator/);
    expect(result.error).not.toMatch(/stub|not yet implemented/i);
  });

  it("does not misdiagnose an ordinary parent registration failure as a child restriction", async () => {
    clearActions();
    vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
    const result = await dispatch({ action: "message" }, {} as ActionCtx) as { error: string; code?: string };
    expect(result.code).not.toBe("unavailable_in_child");
    expect(result.error).toMatch(/registered|implemented/);
  });
});
