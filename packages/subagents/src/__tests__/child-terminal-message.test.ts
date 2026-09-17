import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import { attachChildReporter } from "../child-reporter";
import { RunStore } from "../run-store";
import { makeAsyncNotifier } from "../actions/run";

const scratch = resolve(".spider/scratch/child-terminal-message");
const roots: string[] = [];
const dbs: Db[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllEnvs();
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-")); roots.push(root);
  const path = join(root, "worktree.db");
  const db = openDbAt(path, "worktree"); dbs.push(db);
  const store = new RunStore(db);
  const { id } = store.create({ sessionId: "parent", agent: "worker", task: "Produce a verified report" });
  store.start(id);
  for (const [key, value] of Object.entries({ PI_SUBAGENT_CHILD: "1", PI_SPIDER_DB_PATH: path, PI_SUBAGENT_RUN_ID: id, PI_SPIDER_SESSION_ID: "parent" })) vi.stubEnv(key, value);
  const handlers = new Map<string, (event: unknown) => void>();
  attachChildReporter({ on: (name: string, handler: (event: unknown) => void) => { handlers.set(name, handler); } });
  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" });
  };
  cleanups.push(shutdown);
  const message = (text: string, stopReason: string, errorMessage?: string) => handlers.get("message_end")!({
    type: "message_end", message: {
      role: "assistant", api: "anthropic-messages", provider: "fixture", model: "fixture", timestamp: Date.now(),
      content: text ? [{ type: "text", text }] : [], stopReason, ...(errorMessage ? { errorMessage } : {}),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  });
  return { db, store, id, message, shutdown };
}

describe("terminal assistant output, not progress prose", () => {
  it("does not turn a tool-call preamble into a successful final report", () => {
    const f = setup();
    f.message("I will inspect the files now.", "toolUse");
    f.shutdown();
    expect(f.store.get(f.id)?.status).toBe("failed");
    expect(f.store.get(f.id)?.result).not.toBe("I will inspect the files now.");
  });

  it("preserves the full terminal report even when it contains a warning escalation", () => {
    const f = setup();
    f.message("I will inspect the files now.", "toolUse");
    const final = "Report complete: the regression is verified.\nESCALATION[warning]: Integration still needs a full build.";
    f.message(final, "stop");
    f.shutdown();
    expect(f.store.get(f.id)).toMatchObject({ status: "done", result: final });
  });

  it("does not treat later progress prose as resolving a blocked escalation", () => {
    const f = setup();
    f.message("ESCALATION[blocked]: Need approval for the dependency change.", "toolUse");
    f.message("I will record that blocker before finishing.", "toolUse");
    f.shutdown();
    expect(f.store.get(f.id)?.status).toBe("failed");
    expect(f.store.get(f.id)?.result).toContain("approval");
  });

  it("does not resurrect an old preamble after an empty terminal response", () => {
    const f = setup();
    f.message("Starting work.", "toolUse");
    f.message("", "stop");
    f.shutdown();
    expect(f.store.get(f.id)?.status).toBe("failed");
  });

  it("notifies the actual terminal failure rather than stale progress text", () => {
    const f = setup();
    f.message("Starting work.", "toolUse");
    f.message("", "error", "Provider rejected the request");
    f.shutdown();
    const sent: any[] = [];
    const run = f.store.get(f.id)!;
    makeAsyncNotifier({ db: f.db, pi: { sendMessage: (m: unknown) => sent.push(m) } })(run, run.status, run.result ?? undefined);
    expect(sent[0].details.output).toContain("Provider rejected the request");
    expect(sent[0].details.output).not.toBe("Starting work.");
  });

  it("does not emit a done event when cancellation already won the finalization race", () => {
    const f = setup();
    f.message("Completed report.", "stop");
    f.store.cancel(f.id, "Cancelled by parent");
    f.shutdown();
    expect(f.store.get(f.id)?.status).toBe("cancelled");
    expect(f.db.prepare("SELECT COUNT(*) n FROM run_events WHERE run_id=? AND type='status' AND json_extract(payload,'$.status')='done'").get(f.id)).toEqual({ n: 0 });
  });
});
