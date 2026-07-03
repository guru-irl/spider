import { describe, it, expect } from "vitest";
import { makeChildReporter } from "../child-reporter.js";
import { RunStore } from "../run-store.js";
import { freshDb } from "./helpers/testutil.js";

describe("child reporter", () => {
  it("appends run_events and writes terminal run status", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id: runId } = store.create({ sessionId: "child-sess", agent: "worker" });
    store.start(runId);
    const rep = makeChildReporter(db, { runId, sessionId: "child-sess" });
    rep.onToolStart("bash", { cmd: "ls" });
    rep.onToolEnd("bash", { exit: 0 });
    rep.onShutdown("done", "finished");
    const events = db.prepare(`SELECT type FROM run_events WHERE run_id=? ORDER BY id`).all(runId) as any[];
    expect(events.map((e) => e.type)).toEqual(["tool_intent", "tool_result", "status"]);
    expect(store.get(runId)!.status).toBe("done");
    expect(store.get(runId)!.result).toBe("finished");
  });

  it("emits a terminal status run_event on shutdown so async completion bridges to the bus", () => {
    const cases: Array<["done" | "error" | "interrupted", string]> = [
      ["done", "done"],
      ["error", "failed"],
      ["interrupted", "cancelled"],
    ];
    for (const [shutdown, expected] of cases) {
      const db = freshDb();
      const store = new RunStore(db);
      const { id: runId } = store.create({ sessionId: "child-sess", agent: "worker" });
      store.start(runId);
      const rep = makeChildReporter(db, { runId, sessionId: "child-sess" });
      rep.onShutdown(shutdown, "r");
      const status = db
        .prepare(`SELECT type, payload FROM run_events WHERE run_id=? AND type='status' ORDER BY id DESC LIMIT 1`)
        .get(runId) as any;
      expect(status).toBeTruthy();
      expect(status.type).toBe("status");
      expect(JSON.parse(status.payload).status).toBe(expected);
    }
  });
});
