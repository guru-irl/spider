import { afterEach, describe, expect, it, vi } from "vitest";
import { bus } from "@spider/db-core";
import { RunEventTailer } from "../event-tailer.js";
import { RunStore } from "../run-store.js";
import { freshDb } from "./helpers/testutil.js";

let db: ReturnType<typeof freshDb>;
const offs: (() => void)[] = [];
afterEach(() => { for (const off of offs.splice(0)) off(); vi.restoreAllMocks(); db?.close(); });

describe("tailer replay allocation", () => {
  it("pages the cursor without materializing unrelated payloads or losing tracked events", () => {
    db = freshDb();
    const { id } = new RunStore(db).create({ sessionId: "s1", agent: "worker" });
    const tailer = new RunEventTailer(db);
    tailer.track(id);
    const insert = db.prepare("INSERT INTO run_events(run_id,session_id,ts,type,summary,payload) VALUES (?,'s1',?,'message',?,?)");
    db.transaction(() => {
      for (let i = 0; i < 501; i++) insert.run(i % 250 === 0 ? id : "untracked", i, `message-${i}`, JSON.stringify({ text: `exact payload ${i}` }));
    })();
    let unrelatedBytes = 0;
    db.raw.function("observe_payload", (runId: string, value: string) => {
      if (runId !== id) unrelatedBytes += Buffer.byteLength(value);
      return value;
    });
    db.raw.exec(`ALTER TABLE run_events RENAME TO fixture_events;
      CREATE VIEW run_events AS SELECT id,run_id,session_id,ts,type,tool,summary,
        observe_payload(run_id,payload) AS payload FROM fixture_events`);
    const seen: unknown[] = [];
    offs.push(bus.on(event => { if (event.runId === id) seen.push(event.payload); }));

    tailer.poll();
    expect(tailer.cursor).toBeGreaterThan(0);
    expect(tailer.cursor).toBe(501);
    for (let i = 0; i < 5; i++) tailer.poll();
    expect(tailer.cursor).toBe(501);
    expect(seen).toEqual([{ text: "exact payload 0" }, { text: "exact payload 250" }, { text: "exact payload 500" }]);
    expect(unrelatedBytes).toBe(0);
    tailer.poll();
    expect(seen).toHaveLength(3);
  });

  it("keeps tracking a run restored after a failed cancellation", () => {
    db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker" });
    store.start(id);
    const tailer = new RunEventTailer(db);
    tailer.track(id);
    const insert = db.prepare("INSERT INTO run_events(run_id,session_id,ts,type,payload) VALUES (?,'s1',1,?,?)");
    insert.run(id, "status", JSON.stringify({ status: "cancelled" }));
    insert.run(id, "status", JSON.stringify({ status: "running" }));
    const seen: string[] = [];
    offs.push(bus.on(event => {
      if (event.runId === id && (event.type === "escalation" || (event.payload as any)?.status === "done")) {
        seen.push(`${event.type}:${(event.payload as any)?.status ?? ""}`);
      }
    }));
    tailer.poll();
    insert.run(id, "escalation", JSON.stringify({ severity: "blocked" }));
    db.prepare("UPDATE runs SET status='done' WHERE id=?").run(id);
    insert.run(id, "status", JSON.stringify({ status: "done" }));
    tailer.poll();
    expect(seen).toEqual(["escalation:", "status:done"]);
  });

  it("replays a newly tracked run in one poll without reading the unrelated backlog", () => {
    db = freshDb();
    const store = new RunStore(db), tailer = new RunEventTailer(db);
    const first = store.create({ sessionId: "s1", agent: "worker" }).id;
    const insert = db.prepare("INSERT INTO run_events(run_id,session_id,ts,type,payload) VALUES (?,'s1',1,'status',?)");
    tailer.track(first);
    db.prepare("UPDATE runs SET status='done' WHERE id=?").run(first);
    insert.run(first, JSON.stringify({ status: "done" }));
    tailer.poll();
    db.transaction(() => { for (let i = 0; i < 20_000; i++) insert.run("foreign", "{}"); })();
    const next = store.create({ sessionId: "s1", agent: "worker" }).id;
    tailer.track(next);
    db.prepare("UPDATE runs SET status='done' WHERE id=?").run(next);
    insert.run(next, JSON.stringify({ status: "done" }));

    let rowsRead = 0;
    db.raw.function("observe_event_id", (id: number) => { rowsRead++; return id; });
    db.raw.exec(`ALTER TABLE run_events RENAME TO fixture_events;
      CREATE VIEW run_events AS SELECT observe_event_id(id) AS id,run_id,session_id,ts,type,tool,summary,payload FROM fixture_events`);
    const seen: string[] = [];
    offs.push(bus.on(event => { if (event.runId === next) seen.push(event.type); }));
    tailer.poll();
    expect.soft(seen).toEqual(["status"]);
    expect(rowsRead).toBeLessThanOrEqual(10);
  });

  it("stops polling when every tracked run has emitted a terminal event", () => {
    db = freshDb();
    const store = new RunStore(db), tailer = new RunEventTailer(db);
    const insert = db.prepare("INSERT INTO run_events(run_id,session_id,ts,type,payload) VALUES (?,'s1',1,'status',?)");
    for (const status of ["done", "failed", "cancelled"] as const) {
      const { id } = store.create({ sessionId: "s1", agent: "worker" });
      tailer.track(id);
      db.prepare("UPDATE runs SET status=? WHERE id=?").run(status, id);
      insert.run(id, JSON.stringify({ status }));
    }
    const terminal: string[] = [];
    offs.push(bus.on(event => { if (event.type === "status") terminal.push((event.payload as { status: string }).status); }));
    tailer.poll();
    expect(terminal).toEqual(["done", "failed", "cancelled"]);
    const prepare = vi.spyOn(db, "prepare");
    for (let i = 0; i < 5; i++) tailer.poll();
    expect(prepare).not.toHaveBeenCalled();
  });
});
