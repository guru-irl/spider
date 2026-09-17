import { afterEach, describe, expect, it, vi } from "vitest";
import { makeChildReporter, attachChildReporter } from "../child-reporter";
import { RunStore } from "../run-store";
import { openDbAt } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil";
import { freshDb } from "./helpers/testutil";

// INCIDENT-premature-run-finalization.md: `attachChildReporter` binds to a run purely
// from env vars, and `onShutdown` had no check that THIS process owns the row it is
// about to finalize. A subagent runs `npm test` as its own verification gate; vitest
// workers inherit PI_SUBAGENT_CHILD/PI_SPIDER_DB_PATH/PI_SUBAGENT_RUN_ID from the real,
// still-running parent subagent, so a vitest worker process could reach into the REAL
// worktree DB and kill a LIVE run row. The fix: `onShutdown` refuses to finalize (or
// emit a status event for) a row whose `runs.pid` does not equal this process's own
// `process.pid`.
describe("child-reporter ownership guard (INCIDENT-premature-run-finalization)", () => {
  function countTerminalStatusEvents(db: ReturnType<typeof freshDb>, runId: string): number {
    return (db
      .prepare(
        `SELECT COUNT(*) n FROM run_events WHERE run_id=? AND type='status' AND json_extract(payload,'$.status') IN ('done','failed','cancelled')`
      )
      .get(runId) as { n: number }).n;
  }

  it("a process whose pid does not match runs.pid cannot finalize a live run it does not own", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id: runId } = store.create({ sessionId: "child-sess", agent: "worker" });
    store.start(runId);
    // Simulate the row being owned by a DIFFERENT real process (e.g. the actual
    // subagent child pid, recorded by the parent) — never this test process's own pid.
    const foreignPid = process.pid + 1;
    store.setPid(runId, foreignPid, 999999);
    const rep = makeChildReporter(db, { runId, sessionId: "child-sess" });
    rep.onMessage("FINAL: looks done from here");
    rep.onShutdown("done");
    const row = store.get(runId)!;
    expect(row.status).toBe("running"); // NOT finalized
    expect(row.ended_at).toBeNull();
    expect(row.result).toBeNull();
    expect(countTerminalStatusEvents(db, runId)).toBe(0); // no terminal status event leaked either
  });

  it("the owning process (runs.pid === process.pid) still finalizes exactly as before", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id: runId } = store.create({ sessionId: "child-sess", agent: "worker" });
    store.start(runId);
    store.setPid(runId, process.pid, 999999); // this process IS the recorded owner
    const rep = makeChildReporter(db, { runId, sessionId: "child-sess" });
    rep.onMessage("FINAL: shipped for real");
    rep.onShutdown("done");
    const row = store.get(runId)!;
    expect(row.status).toBe("done");
    expect(row.result).toBe("FINAL: shipped for real");
    expect(countTerminalStatusEvents(db, runId)).toBe(1);
  });

  it("NULL-pid policy: a row with no recorded pid still self-finalizes exactly as before (accept, not refuse — see child-reporter.ts's onShutdown comment for why)", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id: runId } = store.create({ sessionId: "child-sess", agent: "worker" });
    store.start(runId); // note: no store.setPid() call — pid stays NULL, matching
    // runForeground-spawned rows (single sync mode / chain steps / parallel's
    // foreground fallback) and this suite's own sibling attach-based fixtures.
    const rep = makeChildReporter(db, { runId, sessionId: "child-sess" });
    rep.onMessage("FINAL: unattributed completion, self-finalized normally");
    rep.onShutdown("done");
    const row = store.get(runId)!;
    expect(row.status).toBe("done");
    expect(row.result).toBe("FINAL: unattributed completion, self-finalized normally");
  });

  it("does not weaken genuineCompletion: the owning process's escalation/verbatim rules still apply once ownership passes", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id: runId } = store.create({ sessionId: "child-sess", agent: "worker" });
    store.start(runId);
    store.setPid(runId, process.pid, 999999);
    const rep = makeChildReporter(db, { runId, sessionId: "child-sess" });
    rep.onMessage("ESCALATION[blocked]: need approval before deleting prod data");
    rep.onShutdown("done"); // the pre-existing genuineCompletion rule must still fail this
    expect(store.get(runId)!.status).toBe("failed");
  });

  it("a pid-mismatched process cannot rewrite step_count/model or inject run_events on a live run it does not own (guard must cover every write, not just onShutdown)", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id: runId } = store.create({ sessionId: "owner-sess", agent: "worker" });
    store.start(runId);
    // The row is owned by a DIFFERENT real process (the genuine subagent child).
    store.setPid(runId, process.pid + 1, 999999);
    store.updateProgress(runId, { stepCount: 7, model: "real/model" });

    // A FOREIGN process (this test process — its pid does NOT match runs.pid) attaches
    // and behaves like any pi session: a turn starts, tools run, a message ends. No
    // shutdown is fired — attachChildReporter itself performs no ownership check today.
    const foreign = makeChildReporter(db, { runId, sessionId: "foreign-sess" });
    foreign.onTurn(1);
    foreign.onModel("foreign/cheap-model");
    foreign.onStatus("running");
    foreign.onToolStart("read", "read /etc/passwd");
    foreign.onMessage("Now let me build the behavioural probe.", { stopReason: "stop" });

    const afterForeign = store.get(runId)!;
    expect(afterForeign.step_count).toBe(7); // unchanged — was rewritten to 1 pre-fix
    expect(afterForeign.model).toBe("real/model"); // unchanged — was rewritten pre-fix
    const evCount = (db.prepare("SELECT COUNT(*) n FROM run_events WHERE run_id=?").get(runId) as { n: number }).n;
    expect(evCount).toBe(0); // nothing injected by the foreign process

    // The genuine owner now attaches for real (this process's pid becomes the recorded
    // pid) and shuts down WITHOUT ever having reported a message of its own — exactly
    // the real child sequence (attachChildReporter calls onShutdown("done") bare).
    store.setPid(runId, process.pid, 999999);
    const owner = makeChildReporter(db, { runId, sessionId: "owner-sess" });
    owner.onShutdown("done");
    const final = store.get(runId)!;
    // Decisive: the owner must NOT hand out the foreign process's mid-stream sentence as
    // its own deliverable — the incident's exact symptom, reproduced on a row whose pid
    // is correct (C-truthfulness.md H1 / C-probe P12).
    expect(final.result).not.toBe("Now let me build the behavioural probe.");
    expect(final.status).toBe("failed"); // no genuine deliverable was ever recorded
  });

  describe("through the real attachChildReporter wiring (the leaking tests' actual path)", () => {
    const KEYS = ["PI_SUBAGENT_CHILD", "PI_SPIDER_DB_PATH", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_SESSION_ID"] as const;
    afterEach(() => {
      vi.unstubAllEnvs();
      cleanupScratch();
    });

    it("a foreign process cannot finalize a live run via the real attach + session_shutdown path", () => {
      const dbFile = scratchDbPath("child-reporter-ownership-foreign");
      const seed = openDbAt(dbFile, "project");
      const seedStore = new RunStore(seed);
      const { id: runId } = seedStore.create({ sessionId: "child-sess", agent: "worker" });
      seedStore.start(runId);
      // The row is owned by a DIFFERENT real process (the genuine subagent child) —
      // this test process is a stand-in for a vitest worker that merely INHERITED the
      // env vars, exactly as described in the incident.
      seedStore.setPid(runId, process.pid + 1, 999999);
      seed.close();

      vi.stubEnv("PI_SUBAGENT_CHILD", "1");
      vi.stubEnv("PI_SPIDER_DB_PATH", dbFile);
      vi.stubEnv("PI_SUBAGENT_RUN_ID", runId);
      vi.stubEnv("PI_SPIDER_SESSION_ID", "child-sess");

      const handlers: Record<string, (e?: unknown) => void> = {};
      const pi = { on: (evt: string, fn: (e?: unknown) => void) => { handlers[evt] = fn; return undefined; } };
      const dispose = attachChildReporter(pi as never);
      handlers["session_shutdown"]?.();
      dispose?.();

      const verify = openDbAt(dbFile, "project");
      const row = new RunStore(verify).get(runId)!;
      expect(row.status).toBe("running");
      expect(row.ended_at).toBeNull();
      verify.close();
    });

    it("the genuine owning child (runs.pid === its own process.pid) still finalizes via the real attach path", () => {
      const dbFile = scratchDbPath("child-reporter-ownership-owner");
      const seed = openDbAt(dbFile, "project");
      const seedStore = new RunStore(seed);
      const { id: runId } = seedStore.create({ sessionId: "child-sess", agent: "worker" });
      seedStore.start(runId);
      seedStore.setPid(runId, process.pid, 999999); // THIS process is the recorded owner
      seed.close();

      vi.stubEnv("PI_SUBAGENT_CHILD", "1");
      vi.stubEnv("PI_SPIDER_DB_PATH", dbFile);
      vi.stubEnv("PI_SUBAGENT_RUN_ID", runId);
      vi.stubEnv("PI_SPIDER_SESSION_ID", "child-sess");

      const handlers: Record<string, (e?: unknown) => void> = {};
      const pi = { on: (evt: string, fn: (e?: unknown) => void) => { handlers[evt] = fn; return undefined; } };
      const dispose = attachChildReporter(pi as never);
      handlers["message_end"]?.({
        message: { role: "assistant", content: [{ type: "text", text: "FINAL: genuinely finished" }], stopReason: "stop" },
      });
      handlers["session_shutdown"]?.();
      dispose?.();

      const verify = openDbAt(dbFile, "project");
      const row = new RunStore(verify).get(runId)!;
      expect(row.status).toBe("done");
      expect(row.result).toBe("FINAL: genuinely finished");
      verify.close();
    });

    it("closes the window even when the row's pid is recorded AFTER this reporter already attached (startup race) — attach time alone is not enough", () => {
      const dbFile = scratchDbPath("child-reporter-ownership-late-pid");
      const seed = openDbAt(dbFile, "project");
      const seedStore = new RunStore(seed);
      const { id: runId } = seedStore.create({ sessionId: "child-sess", agent: "worker" });
      seedStore.start(runId); // NOTE: no setPid yet — pid is NULL when this reporter attaches
      seed.close();

      vi.stubEnv("PI_SUBAGENT_CHILD", "1");
      vi.stubEnv("PI_SPIDER_DB_PATH", dbFile);
      vi.stubEnv("PI_SUBAGENT_RUN_ID", runId);
      vi.stubEnv("PI_SPIDER_SESSION_ID", "foreign-sess");

      const handlers: Record<string, (e?: unknown, c?: unknown) => void> = {};
      const pi = { on: (evt: string, fn: (e?: unknown, c?: unknown) => void) => { handlers[evt] = fn; return undefined; } };
      const dispose = attachChildReporter(pi as never);

      // First event arrives while pid is still NULL — accepted (NULL-pid policy).
      handlers["turn_start"]?.({ turnIndex: 0 }, {});

      // The PARENT now records the REAL owner's pid — a different, live process — closing
      // the race. This reporter is still attached, simulating a foreign process that got
      // in before the real pid landed.
      const mid = openDbAt(dbFile, "project");
      new RunStore(mid).setPid(runId, process.pid + 1, 999999);
      mid.close();

      // Further events from this (now-foreign) attach must be refused.
      handlers["turn_start"]?.({ turnIndex: 5 }, {});
      handlers["message_end"]?.({ message: { role: "assistant", content: [{ type: "text", text: "FOREIGN post-race text" }], stopReason: "stop" } });
      handlers["session_shutdown"]?.();
      dispose?.();

      const verify = openDbAt(dbFile, "project");
      const row = new RunStore(verify).get(runId)!;
      expect(row.step_count).toBe(1); // only the pre-race turn_start landed
      expect(row.status).toBe("running"); // never finalized by the now-foreign attach
      const n = (verify.prepare("SELECT COUNT(*) n FROM run_events WHERE run_id=?").get(runId) as { n: number }).n;
      expect(n).toBe(0); // the post-race message never got in
      verify.close();
    });
  });
});
