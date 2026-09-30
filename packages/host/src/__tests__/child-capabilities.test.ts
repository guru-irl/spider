import { afterEach, describe, expect, it, vi } from "vitest";
import { clearActions, dispatch, registerAction, type ActionCtx } from "../dispatch";
import { commandEnv } from "@spider/db-core";
import { registerSubagentActions, RunStore } from "@spider/subagents";
import { freshDb } from "../../../subagents/src/__tests__/helpers/testutil";

afterEach(() => { clearActions(); vi.unstubAllEnvs(); });

describe("child capability diagnostics", () => {
  it("nested activation keeps child restrictions without reporter writes", async () => {
    const db = freshDb();
    try {
      const store = new RunStore(db); const { id } = store.create({ sessionId: "owner", agent: "worker" }); store.start(id);
      const env = commandEnv({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_RUN_ID: id, PI_SPIDER_DB_PATH: "fixture.db", PI_SPIDER_SESSION_ID: "owner" });
      for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_DB_PATH", "PI_SPIDER_SESSION_ID"]) vi.stubEnv(key, env[key]);
      const hooks = new Map<string, ((e: any) => void)[]>();
      registerSubagentActions({ registerAction }, { on(name: string, fn: (e: any) => void) { hooks.set(name, [...hooks.get(name) ?? [], fn]); } });
      for (const name of ["agent_start", "turn_start", "message_end", "session_shutdown"]) for (const fn of hooks.get(name) ?? []) fn({ message: { role: "assistant", content: [{ type: "text", text: "foreign report" }], stopReason: "stop" } });
      expect(db.prepare("SELECT id FROM run_events WHERE run_id=?").all(id)).toEqual([]);
      expect(store.get(id)?.status).toBe("running");
      expect(hooks.size).toBe(0);
      expect(await dispatch({ action: "run", agent: "worker", task: "must refuse" }, { db } as ActionCtx)).toMatchObject({ code: "unavailable_in_child" });
    } finally { db.close(); }
  });
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
    const result = await dispatch({ action: "message" }, {} as ActionCtx) as { error: string; code?: string };
    expect(result.code).not.toBe("unavailable_in_child");
    expect(result.error).toMatch(/registered|implemented/);
  });
});
