import { describe, it, expect } from "vitest";
import { bus } from "@spider/db-core";
import { emitStatus, emitHandoff, emitToolResult, emitEscalation } from "../run-events";
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

  it("emitEscalation lands with type='escalation' and is queryable by that type (mutation: change the literal 'escalation' to anything else → this must fail)", () => {
    const db = freshDb();
    emitEscalation(db, {
      runId: "r1",
      sessionId: "s1",
      severity: "blocked",
      summary: "Child blocked on resource",
    });
    // Query the database to verify it was stored
    const row = db.prepare(`SELECT type FROM run_events WHERE run_id='r1' ORDER BY id DESC LIMIT 1`).get() as { type: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.type).toBe("escalation");
  });

  it("emitEscalation includes severity in the decoded payload (mutation: drop severity from the payload → must fail)", () => {
    const db = freshDb();
    emitEscalation(db, {
      runId: "r2",
      sessionId: "s2",
      severity: "warning",
      summary: "Child warning",
    });
    // Query the database to verify severity is in the stored payload
    const row = db.prepare(`SELECT payload FROM run_events WHERE run_id='r2' ORDER BY id DESC LIMIT 1`).get() as { payload: string } | undefined;
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload);
    expect(payload.severity).toBe("warning");
  });

  it("emitEscalation merges extra payload object alongside severity, not replacing it (mutation: overwrite instead of merge → must fail)", () => {
    const db = freshDb();
    emitEscalation(db, {
      runId: "r3",
      sessionId: "s3",
      severity: "question",
      summary: "Child question",
      payload: { context: "user input", code: 42 },
    });
    // Query the database to verify both severity and extra fields are present
    const row = db.prepare(`SELECT payload FROM run_events WHERE run_id='r3' ORDER BY id DESC LIMIT 1`).get() as { payload: string } | undefined;
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload);
    expect(payload.severity).toBe("question");
    expect(payload.context).toBe("user input");
    expect(payload.code).toBe(42);
  });
});
