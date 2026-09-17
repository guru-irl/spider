import { describe, it, expect } from "vitest";
import { makeChildReporter, attachChildReporter, summarizeToolArgs } from "../child-reporter";
import { RunStore } from "../run-store";
import { openDbAt } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil";
import { freshDb } from "./helpers/testutil";
import { latestRunOutput } from "../completion-output";

describe("child reporter", () => {
  it("appends run_events and writes terminal run status", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id: runId } = store.create({ sessionId: "child-sess", agent: "worker" });
    store.start(runId);
    const rep = makeChildReporter(db, { runId, sessionId: "child-sess" });
    rep.onToolStart("bash", "bash ls", { cmd: "ls" });
    rep.onToolEnd("bash", "✓ bash", { exit: 0 });
    rep.onShutdown("done", "finished");
    const events = db.prepare(`SELECT type, summary FROM run_events WHERE run_id=? ORDER BY id`).all(runId) as any[];
    expect(events.map((e) => e.type)).toEqual(["tool_intent", "tool_result", "status"]);
    expect(events[0].summary).toBe("bash ls");
    expect(store.get(runId)!.status).toBe("done");
    expect(store.get(runId)!.result).toBe("finished");
  });

  it("records assistant prose as message events (conversation capture)", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id: runId } = store.create({ sessionId: "child-sess", agent: "worker" });
    const rep = makeChildReporter(db, { runId, sessionId: "child-sess" });
    rep.onMessage("Analyzing the ui package now.");
    const events = db.prepare(`SELECT type, summary FROM run_events WHERE run_id=? ORDER BY id`).all(runId) as any[];
    expect(events).toEqual([{ type: "message", summary: "Analyzing the ui package now." }]);
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

  describe("attachChildReporter — the child itself must not claim done regardless of provider errors/abort", () => {
    const KEYS = ["PI_SUBAGENT_CHILD", "PI_SPIDER_DB_PATH", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_SESSION_ID"] as const;

    function withChildEnv(dbFile: string, runId: string, fn: (handlers: Record<string, (e?: any) => void>, dispose: (() => void) | undefined) => void) {
      const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
      process.env.PI_SUBAGENT_CHILD = "1";
      process.env.PI_SPIDER_DB_PATH = dbFile;
      process.env.PI_SUBAGENT_RUN_ID = runId;
      process.env.PI_SPIDER_SESSION_ID = "child-sess";
      try {
        const handlers: Record<string, (e?: any) => void> = {};
        const pi = { on: (evt: string, fn2: (e?: any) => void) => { handlers[evt] = fn2; return undefined; } };
        const dispose = attachChildReporter(pi as any);
        fn(handlers, dispose);
      } finally {
        for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        cleanupScratch();
      }
    }

    // Genuine repro for the reported bug: "a child itself currently calls
    // onShutdown('done') regardless of provider errors/escalation". `stopReason` is the
    // documented, structural field on the finalized assistant message (session-format.md)
    // — not a natural-language guess — so this exercises the REAL event shape pi emits.
    it("a provider error on the last turn is reported failed even though session_shutdown fires cleanly", () => {
      const dbFile = scratchDbPath("child-reporter-provider-error");
      const seed = openDbAt(dbFile, "project");
      const seedStore = new RunStore(seed);
      const { id: runId } = seedStore.create({ sessionId: "child-sess", agent: "worker" });
      seedStore.start(runId);
      seed.close();

      withChildEnv(dbFile, runId, (handlers) => {
        handlers["message_end"]({ message: { role: "assistant", stopReason: "error", errorMessage: "rate limited by provider", content: [] } });
        handlers["session_shutdown"]();
        const verify = openDbAt(dbFile, "project");
        const row = new RunStore(verify).get(runId)!;
        expect(row.status).not.toBe("done");
        expect(row.status).toBe("failed");
        verify.close();
      });
    });

    it("an aborted last turn is reported failed, not done, on clean process exit", () => {
      const dbFile = scratchDbPath("child-reporter-provider-aborted");
      const seed = openDbAt(dbFile, "project");
      const seedStore = new RunStore(seed);
      const { id: runId } = seedStore.create({ sessionId: "child-sess", agent: "worker" });
      seedStore.start(runId);
      seed.close();

      withChildEnv(dbFile, runId, (handlers) => {
        handlers["message_end"]({ message: { role: "assistant", stopReason: "aborted", content: [] } });
        handlers["session_shutdown"]();
        const verify = openDbAt(dbFile, "project");
        expect(new RunStore(verify).get(runId)!.status).toBe("failed");
        verify.close();
      });
    });

    it("a transient error/abort followed by a successful continuation still reports done (only the LAST turn decides)", () => {
      const dbFile = scratchDbPath("child-reporter-provider-recovered");
      const seed = openDbAt(dbFile, "project");
      const seedStore = new RunStore(seed);
      const { id: runId } = seedStore.create({ sessionId: "child-sess", agent: "worker" });
      seedStore.start(runId);
      seed.close();

      withChildEnv(dbFile, runId, (handlers) => {
        handlers["message_end"]({ message: { role: "assistant", stopReason: "error", errorMessage: "transient", content: [] } });
        handlers["message_end"]({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "FINAL: recovered and finished" }] } });
        handlers["session_shutdown"]();
        const verify = openDbAt(dbFile, "project");
        const row = new RunStore(verify).get(runId)!;
        expect(row.status).toBe("done");
        expect(row.result).toBe("FINAL: recovered and finished");
        verify.close();
      });
    });
  });

  describe("summarizeToolArgs — the /agents detail view can only show what this records", () => {
    // Root cause: spider is one mega-tool (`{action, language, code}` / `{action, commands}`).
    // The old pick list (path/file/filePath/command/pattern/query/url/name/action) has no
    // `code` field, so it always fell through to `a.action` — every spider exec call recorded
    // the literal, useless string "spider exec", no matter what command actually ran.

    it("summarises a spider exec call with the actual command, not just the action", () => {
      const summary = summarizeToolArgs("spider", { action: "exec", language: "shell", code: "echo hello world" });
      expect(summary).toBe("spider exec: echo hello world");
    });

    it("summarises a spider batch call with the first command plus a count", () => {
      const summary = summarizeToolArgs("spider", {
        action: "batch",
        commands: [
          { language: "shell", code: "echo one" },
          { language: "shell", code: "echo two" },
          { language: "shell", code: "echo three" },
        ],
      });
      expect(summary).toBe("spider batch: echo one (3 commands)");
    });

    it("keeps showing the path for exec_file", () => {
      const summary = summarizeToolArgs("spider", { action: "exec_file", path: "/tmp/script.sh" });
      expect(summary).toBe("spider exec_file: /tmp/script.sh");
    });

    it("degrades to the bare tool name when a tool has none of the known fields", () => {
      const summary = summarizeToolArgs("mystery_tool", { foo: "bar" });
      expect(summary).toBe("mystery_tool");
    });

    it("clamps a very long script to the existing 100-char summary budget", () => {
      const longCode = "x".repeat(500);
      const summary = summarizeToolArgs("spider", { action: "exec", code: longCode });
      expect(summary).toBe(`spider exec: ${"x".repeat(100)}`);
    });

    it("strips a trivial leading 'cd <path> &&' so the real command survives", () => {
      const summary = summarizeToolArgs("spider", { action: "exec", code: "cd /Users/guru/src/spider && npm test" });
      expect(summary).toBe("spider exec: npm test");
    });

    it("leaves non-spider tool summaries unaffected (write keeps tool + path)", () => {
      expect(summarizeToolArgs("write", { path: "/tmp/out.txt" })).toBe("write /tmp/out.txt");
    });
  });

  // C1's actual production shape: the real child sequence (message(s), then a BARE
  // onShutdown("done") — attachChildReporter never passes a `result` argument at all,
  // see the wiring below). No fake stands in for a hand-written final result here.
  describe("onShutdown — a clean shutdown signal is necessary but not sufficient for done", () => {
    it("backfills a blank result from the real final message run_event (canonical result survives)", () => {
      const db = freshDb();
      const store = new RunStore(db);
      const { id: runId } = store.create({ sessionId: "child-sess", agent: "worker" });
      store.start(runId);
      const rep = makeChildReporter(db, { runId, sessionId: "child-sess" });
      rep.onMessage("FINAL: 3 TODOs found");
      rep.onShutdown("done"); // no result arg — the real child sequence
      const row = store.get(runId)!;
      expect(row.status).toBe("done");
      expect(row.result).toBe("FINAL: 3 TODOs found");
    });

    it("does NOT report done when the last signal is an unresolved BLOCKED escalation with no further message", () => {
      const db = freshDb();
      const store = new RunStore(db);
      const { id: runId } = store.create({ sessionId: "child-sess", agent: "worker" });
      store.start(runId);
      const rep = makeChildReporter(db, { runId, sessionId: "child-sess" });
      rep.onMessage("ESCALATION[blocked]: need approval before deleting prod data");
      rep.onShutdown("done"); // the buggy old code recorded this "done" with result=null
      const row = store.get(runId)!;
      expect(row.status).not.toBe("done");
      expect(row.status).toBe("failed");
    });

    it("does NOT report done when the last signal is an unresolved QUESTION escalation", () => {
      const db = freshDb();
      const store = new RunStore(db);
      const { id: runId } = store.create({ sessionId: "child-sess", agent: "worker" });
      store.start(runId);
      const rep = makeChildReporter(db, { runId, sessionId: "child-sess" });
      rep.onMessage("ESCALATION[question]: which environment should I target?");
      rep.onShutdown("done");
      expect(store.get(runId)!.status).toBe("failed");
    });

    it("a WARNING-only escalation does not falsely fail a valid completion", () => {
      const db = freshDb();
      const store = new RunStore(db);
      const { id: runId } = store.create({ sessionId: "child-sess", agent: "worker" });
      store.start(runId);
      const rep = makeChildReporter(db, { runId, sessionId: "child-sess" });
      rep.onMessage("FINAL: shipped the thing");
      rep.onMessage("ESCALATION[warning]: minor formatting nit in the output");
      rep.onShutdown("done");
      const row = store.get(runId)!;
      expect(row.status).toBe("done");
      expect(row.result).toBe("FINAL: shipped the thing");
    });

    it("a headless child that never calls onShutdown leaves the row non-terminal for the parent to finalize (sibling of the backfill case)", () => {
      const db = freshDb();
      const store = new RunStore(db);
      const { id: runId } = store.create({ sessionId: "child-sess", agent: "worker" });
      store.start(runId);
      const rep = makeChildReporter(db, { runId, sessionId: "child-sess" });
      rep.onMessage("FINAL: did the work");
      // No onShutdown call — simulates headless/killed: session_shutdown never fires.
      expect(store.get(runId)!.status).toBe("running");
      // But the real deliverable is already sitting in run_events for the parent's
      // fallback finalize (runner.ts) to pick up — it must not be reported as missing.
      expect(latestRunOutput(db, runId)).toBe("FINAL: did the work");
    });
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
