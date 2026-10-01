import { afterEach, describe, expect, it, vi } from "vitest";
import { bus } from "@spider/db-core";
import { RunEventTailer } from "../event-tailer";
import { PipelineCoordinator } from "../pipeline";
import { RunStore } from "../run-store";
import { detachForReload, teardownAll } from "../coordinators";
import { getCoordinators } from "../coordinators";
import { resetSharedRegistryForTests, sharedRegistry } from "../child-registry";
import { freshDb } from "./helpers/testutil";

afterEach(() => { teardownAll(); resetSharedRegistryForTests(); });

describe("reload details", () => {
  it("a tailer resumed from a saved cursor replays events written in the gap", () => {
    const db = freshDb();
    const first = new RunEventTailer(db);
    first.track("r1");
    const cursor = first.cursor;
    db.prepare(`INSERT INTO run_events (run_id, session_id, ts, type, summary) VALUES ('r1','s',1,'escalation','needs help')`).run();
    const seen: any[] = [];
    const off = bus.on(e => seen.push(e));
    const second = new RunEventTailer(db, { sinceId: cursor });
    second.track("r1");
    second.poll();
    off();
    expect(seen.map(e => e.summary)).toEqual(["needs help"]);
    // Without the cursor the gap event would be skipped.
    const fresh = new RunEventTailer(db);
    fresh.track("r1");
    const seen2: any[] = [];
    const off2 = bus.on(e => seen2.push(e));
    fresh.poll(); off2();
    expect(seen2).toEqual([]);
  });

  it("a cursor ahead of the DB is clamped, never skipping future events", () => {
    const db = freshDb();
    expect(new RunEventTailer(db, { sinceId: 9999 }).cursor).toBe(0);
  });

  it("detachForReload stores each session's tailer cursor and stops its tailer", async () => {
    const db = freshDb();
    const tailer = new RunEventTailer(db);
    const stop = vi.spyOn(tailer, "stop");
    getCoordinators("s1", () => ({ tailer, pipelines: [], children: new Map() }));
    db.prepare(`INSERT INTO run_events (run_id, session_id, ts, type, summary) VALUES ('r','s1',1,'status','x')`).run();
    tailer.track("r"); tailer.poll();
    await detachForReload("s1");
    expect(stop).toHaveBeenCalled();
    expect(sharedRegistry().tailCursors.get("s1")).toBe(tailer.cursor);
  });

  it("reload tells an in-flight pipeline stage that later stages will not start", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const runner: any = { runAsync: (o: any) => { const { id } = store.create({ sessionId: "s1", agent: o.agent, task: o.task }); store.start(id); return store.get(id); } };
    const coord = new PipelineCoordinator({ db, globalDb: db, store, runner, pi: {}, sessionId: "s1" });
    const { firstRunId } = coord.start({ pipeline: [{ agent: "worker", task: "a" }, { agent: "reviewer", task: "{previous}" }], handoff: "intercom", async: true } as any);
    coord.abandonForReload();
    const warnings = db.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='warning'").all(firstRunId) as any[];
    expect(warnings.map(w => w.summary).join()).toMatch(/remaining stages were not started/);
  });

  it("a single-stage pipeline gets no misleading warning", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const runner: any = { runAsync: (o: any) => { const { id } = store.create({ sessionId: "s1", agent: o.agent, task: o.task }); store.start(id); return store.get(id); } };
    const coord = new PipelineCoordinator({ db, globalDb: db, store, runner, pi: {}, sessionId: "s1" });
    const { firstRunId } = coord.start({ pipeline: [{ agent: "worker", task: "a" }], handoff: "intercom", async: true } as any);
    coord.abandonForReload();
    expect(db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type='warning'").all(firstRunId)).toEqual([]);
  });
});
