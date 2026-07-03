import { describe, it, expect } from "vitest";
import { waitForRuns } from "../wait.js";
import { RunStore } from "../run-store.js";
import { emitStatus } from "../run-events.js";
import { freshDb } from "./helpers/testutil.js";

describe("waitForRuns", () => {
  it("resolves immediately if the targeted run is already terminal", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "w" });
    store.start(id);
    store.finish(id, { status: "done" });
    const res = await waitForRuns({ db, store, sessionId: "s1" }, { id, timeoutMs: 500 });
    expect(res.timedOut).toBe(false);
    expect(res.finished.map((r) => r.id)).toEqual([id]);
  });

  it("first-finish (default) resolves when one of several active runs finishes", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const a = store.create({ sessionId: "s1", agent: "w" }).id; store.start(a);
    const b = store.create({ sessionId: "s1", agent: "w" }).id; store.start(b);
    const p = waitForRuns({ db, store, sessionId: "s1" }, { timeoutMs: 1000 });
    store.finish(b, { status: "done" });
    emitStatus(db, { runId: b, sessionId: "s1", status: "done" });
    const res = await p;
    expect(res.finished.map((r) => r.id)).toContain(b);
    expect(res.stillActive.map((r) => r.id)).toContain(a);
  });

  it("all=true waits for every active run", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const a = store.create({ sessionId: "s1", agent: "w" }).id; store.start(a);
    const b = store.create({ sessionId: "s1", agent: "w" }).id; store.start(b);
    const p = waitForRuns({ db, store, sessionId: "s1" }, { all: true, timeoutMs: 1000 });
    store.finish(a, { status: "done" }); emitStatus(db, { runId: a, sessionId: "s1", status: "done" });
    store.finish(b, { status: "failed" }); emitStatus(db, { runId: b, sessionId: "s1", status: "failed" });
    const res = await p;
    expect(res.finished.map((r) => r.id).sort()).toEqual([a, b].sort());
  });

  it("returns timedOut=true when nothing finishes in time", async () => {
    const db = freshDb();
    const store = new RunStore(db);
    const a = store.create({ sessionId: "s1", agent: "w" }).id; store.start(a);
    const res = await waitForRuns({ db, store, sessionId: "s1" }, { timeoutMs: 30 });
    expect(res.timedOut).toBe(true);
  });
});
