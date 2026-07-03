import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDbAt, paths, bus } from "@spider/db-core";
import { PipelineCoordinator } from "../pipeline";
import { RunStore } from "../run-store";
import { freshDb } from "./helpers/testutil";

function freshGlobal() {
  return openDbAt(join(paths.scratch("global"), `pg-${randomUUID()}.db`), "global");
}

function fakePi() {
  const h: Record<string, Function[]> = {};
  return {
    events: {
      on: (n: string, f: Function) => ((h[n] ??= []).push(f), () => {}),
      emit: (n: string, p: any) => {
        (h[n] ?? []).forEach((f) => f(p));
        if (n === "subagent:result-intercom") (h["subagent:result-intercom-delivery"] ?? []).forEach((f) => f({ requestId: p.requestId, delivered: true }));
      },
    },
  } as any;
}

describe("PipelineCoordinator", () => {
  it("advances stage-by-stage, records handoff edges, and wakes via intercom (no blocking wait)", async () => {
    const db = freshDb();
    const globalDb = freshGlobal();
    const store = new RunStore(db);
    const runner: any = {
      runAsync(opts: any) {
        const { id } = store.create({ sessionId: "s1", agent: opts.agent, role: opts.role, task: opts.task, parentRunId: opts.parentRunId });
        store.start(id);
        store.finish(id, { status: "done", result: `${opts.agent}-out` });
        setTimeout(() => bus.emit({ runId: id, sessionId: "s1", ts: Date.now(), type: "status", payload: { status: "done" } }), 0);
        return store.get(id);
      },
    };
    const pi = fakePi();
    const coord = new PipelineCoordinator({ db, globalDb, store, runner, pi, sessionId: "s1" });
    coord.start({ pipeline: [{ agent: "worker", role: "impl" }, { agent: "worker", role: "reviewer", task: "review {previous}" }], handoff: "intercom" });
    await new Promise((r) => setTimeout(r, 40));
    const handoffs = db.prepare(`SELECT * FROM run_events WHERE type='handoff'`).all() as any[];
    expect(handoffs.length).toBe(1);
    const mirror = globalDb.prepare(`SELECT * FROM message_mirror WHERE kind='handoff'`).all() as any[];
    expect(mirror.length).toBe(1);
    const reviewer = store.listForSession("s1").find((r) => r.role === "reviewer")!;
    expect(reviewer.task).toContain("worker-out");
    coord.dispose();
  });
});
