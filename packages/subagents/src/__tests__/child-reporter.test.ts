import { describe, it, expect } from "vitest";
import { makeChildReporter, attachChildReporter } from "../child-reporter";
import { RunStore } from "../run-store";
import { openDbAt } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil";
import { freshDb } from "./helpers/testutil";

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

  it("survives a throwing getSessionName in headless child mode and still emits run_events", () => {
    // Regression: getSessionName() throws under `pi -p --mode json`; the old code called it
    // unguarded, so attachChildReporter threw (silently swallowed) and NO child ever reported.
    const dbFile = scratchDbPath("child-reporter-headless");
    const KEYS = ["PI_SUBAGENT_CHILD", "PI_SPIDER_DB_PATH", "PI_SUBAGENT_RUN_ID"] as const;
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.PI_SUBAGENT_CHILD = "1";
    process.env.PI_SPIDER_DB_PATH = dbFile;
    process.env.PI_SUBAGENT_RUN_ID = "run-headless-1";
    try {
      const handlers: Record<string, (e: any) => void> = {};
      const pi = {
        getSessionName: () => { throw new Error("no session in child mode"); },
        on: (evt: string, fn: (e: any) => void) => { handlers[evt] = fn; return undefined; },
      };
      const dispose = attachChildReporter(pi as any);
      expect(dispose).toBeTypeOf("function"); // did NOT bail despite the throw
      expect(handlers["agent_start"]).toBeTypeOf("function");
      handlers["agent_start"]({}); // → onStatus("running")
      const db = openDbAt(dbFile, "project");
      const rows = db.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='status'").all("run-headless-1") as any[];
      expect(rows.some((r) => r.summary === "running")).toBe(true);
      dispose?.();
    } finally {
      for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      cleanupScratch();
    }
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
