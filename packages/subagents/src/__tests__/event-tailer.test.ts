import { describe, it, expect } from "vitest";
import { bus } from "@spider/db-core";
import { RunEventTailer } from "../event-tailer";
import { freshDb } from "./helpers/testutil";

describe("RunEventTailer", () => {
  it("re-emits only new rows for tracked runs on poll", () => {
    const db = freshDb();
    const tailer = new RunEventTailer(db, { intervalMs: 5 });
    tailer.track("async1");
    db.prepare(`INSERT INTO run_events (run_id, session_id, ts, type, summary) VALUES ('async1','s1',1,'status','a')`).run();
    db.prepare(`INSERT INTO run_events (run_id, session_id, ts, type, summary) VALUES ('other','s1',2,'status','b')`).run();
    const seen: any[] = [];
    const off = bus.on((e) => seen.push(e));
    tailer.poll();
    off();
    expect(seen.map((e) => e.summary)).toEqual(["a"]);
    const seen2: any[] = [];
    const off2 = bus.on((e) => seen2.push(e));
    tailer.poll();
    off2();
    expect(seen2).toEqual([]);
  });
});
