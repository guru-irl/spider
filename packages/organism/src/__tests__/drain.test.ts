import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { drainSession } from "../drain.js";

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());

describe("drainSession", () => {
  it("collects runs, run_events, events, todos for the session", () => {
    ctx = makeOrgDb();
    const { db } = ctx;
    db.prepare(`INSERT INTO sessions (id, reason, started_at, name) VALUES ('s1','startup',1,'auth-refactor')`).run();
    db.prepare(`INSERT INTO runs (id, session_id, agent, status, step_count, token_count) VALUES ('r1','s1','worker','done',3,10)`).run();
    db.prepare(`INSERT INTO run_events (run_id, session_id, ts, type, tool, summary) VALUES ('r1','s1',2,'tool_result','bash','ran tests')`).run();
    db.prepare(`INSERT INTO events (session_id, ts, phase, tool, description) VALUES ('s1',3,'after','edit','patched auth.ts')`).run();
    db.prepare(`INSERT INTO todos (session_id, seq, text, done, created_at) VALUES ('s1',1,'ship it',1,4)`).run();
    const bundle = drainSession(db, "s1", "shutdown");
    expect(bundle.runs).toHaveLength(1);
    expect(bundle.runEvents.map((e) => e.summary)).toContain("ran tests");
    expect(bundle.events.map((e) => e.description)).toContain("patched auth.ts");
    expect(bundle.todos[0].text).toBe("ship it");
    expect(bundle.sessionName).toBe("auth-refactor");
    expect(bundle.transcript).toEqual([]);
  });

  it("scopes strictly to the session (no cross-session leakage)", () => {
    ctx = makeOrgDb();
    const { db } = ctx;
    db.prepare(`INSERT INTO events (session_id, ts, phase, tool) VALUES ('s2',1,'after','ls')`).run();
    expect(drainSession(db, "s1", "shutdown").events).toHaveLength(0);
  });
});
