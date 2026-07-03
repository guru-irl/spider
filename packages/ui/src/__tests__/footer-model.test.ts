import { describe, it, expect } from "vitest";
import { buildFooterModel } from "../agents/footer-model";
import type { AgentSnapshot, AgentStatus } from "../agents/types";

function a(runId: string, status: AgentStatus, endedAt?: number): AgentSnapshot {
  return { runId, name: runId, agent: "worker", status, stepCount: 0, tokenCount: 0, recentActivity: [], endedAt };
}

describe("buildFooterModel", () => {
  it("no overflow when within maxVisible", () => {
    const m = buildFooterModel([a("1","running"), a("2","done",1)], 4);
    expect(m.visible).toHaveLength(2);
    expect(m.overflow).toBeUndefined();
  });
  it("prioritizes running over done", () => {
    const m = buildFooterModel([a("d","done",1), a("r","running")], 4);
    expect(m.visible[0].runId).toBe("r");
  });
  it("aggregates overflow beyond maxVisible", () => {
    const agents = [
      a("1","running"), a("2","running"), a("3","running"), a("4","running"),
      a("5","done",2), a("6","done",3), a("7","failed",4),
    ];
    const m = buildFooterModel(agents, 4);
    expect(m.visible).toHaveLength(4);
    expect(m.overflow).toMatchObject({ running: 4, done: 2, failed: 1, hidden: 3 });
  });
});
