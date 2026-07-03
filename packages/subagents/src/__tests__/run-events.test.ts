import { describe, it, expect } from "vitest";
import { bus } from "@spider/db-core";
import { emitStatus, emitHandoff, emitToolResult } from "../run-events";
import { freshDb } from "./helpers/testutil";

describe("run-events emit helpers", () => {
  it("emitStatus appends a status run_event and emits it on the bus", () => {
    const db = freshDb();
    const seen: unknown[] = [];
    const off = bus.on((e) => seen.push(e));
    try {
      emitStatus(db, { runId: "r1", sessionId: "s1", status: "running" });
    } finally {
      off();
    }
    expect(seen.length).toBe(1);
    const e = seen[0] as { type: string; runId?: string; sessionId: string; payload?: unknown };
    expect(e.type).toBe("status");
    expect(e.runId).toBe("r1");
    expect(e.sessionId).toBe("s1");
    expect((e.payload as { status: string }).status).toBe("running");
  });

  it("emitHandoff sets payload.toRunId", () => {
    const db = freshDb();
    const seen: unknown[] = [];
    const off = bus.on((e) => seen.push(e));
    try {
      emitHandoff(db, { runId: "a", sessionId: "s1", toRunId: "b", phase: "review" });
    } finally {
      off();
    }
    expect(seen.length).toBe(1);
    const e = seen[0] as { type: string; payload?: { toRunId?: string } };
    expect(e.type).toBe("handoff");
    expect(e.payload?.toRunId).toBe("b");
  });

  it("emitToolResult carries tool name and payload.exit", () => {
    const db = freshDb();
    const seen: unknown[] = [];
    const off = bus.on((e) => seen.push(e));
    try {
      emitToolResult(db, { runId: "r1", sessionId: "s1", tool: "bash", payload: { exit: 0 } });
    } finally {
      off();
    }
    expect(seen.length).toBe(1);
    const e = seen[0] as { type: string; tool?: string; payload?: { exit?: number } };
    expect(e.type).toBe("tool_result");
    expect(e.tool).toBe("bash");
    expect(e.payload?.exit).toBe(0);
  });
});
