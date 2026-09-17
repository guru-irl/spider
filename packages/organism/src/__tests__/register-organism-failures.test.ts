import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import { emitLog } from "@spider/subagents";
import { registerOrganism } from "../index.js";

// G1a/G1b: today, `pi.on` throwing at registration and a deps resolver throwing
// before a worker exists are both swallowed by bare `catch {}` blocks — nothing
// observes them and nothing is ever recorded. These tests exercise the real
// `registerOrganism(..., onSetupError)` contract, not a synthetic stand-in.

const scratch = resolve(".spider/scratch/register-organism-failures");
const roots: string[] = [];
const handles: Db[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureDb(): { dir: string; db: Db } {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "case-"));
  roots.push(dir);
  const db = openDbAt(join(dir, "worktree.db"), "worktree");
  handles.push(db);
  return { dir, db };
}

describe("registerOrganism — setup/registration failure surfacing (G1a/G1b)", () => {
  it("a pi whose on() throws surfaces onSetupError('register', ...) instead of vanishing silently", () => {
    const events: Array<{ phase: string; error: unknown }> = [];
    const throwingPi = {
      on: () => {
        throw new Error("registration boom");
      },
    };
    registerOrganism(
      throwingPi,
      throwingPi,
      () => {
        throw new Error("deps never called — registration itself failed first");
      },
      (phase, error) => {
        events.push({ phase, error });
      },
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.phase === "register")).toBe(true);
    expect(String((events[0].error as Error)?.message ?? events[0].error)).toContain("registration boom");
  });

  it("a deps resolver that throws during shutdown still resolves the lifecycle, and the callback can persist a real failed-setup receipt", async () => {
    const { db } = fixtureDb();
    db.prepare("INSERT INTO sessions(id, started_at) VALUES ('sess-1', 1)").run();
    const handlers: Record<string, (event: unknown, ctx?: unknown) => unknown> = {};
    const pi = {
      on: (name: string, fn: (event: unknown, ctx?: unknown) => unknown) => {
        handlers[name] = fn;
      },
    };
    registerOrganism(
      pi,
      pi,
      () => {
        throw new Error("resolver boom");
      },
      (phase, error) => {
        // A real host would call HostOrganismRuntime.recordSetupFailure here;
        // this test double proves the contract with a real DB write.
        try {
          emitLog(db, {
            sessionId: "sess-1",
            summary: "organism drain (shutdown): failed (setup)",
            payload: {
              kind: "organism-drain",
              sessionId: "sess-1",
              reason: "shutdown",
              status: "failed",
              startedAt: Date.now(),
              finishedAt: Date.now(),
              modelCalls: 0,
              memoryStaged: 0,
              todosAdded: 0,
              skillsStaged: 0,
              dropped: 0,
              rejected: 0,
              inputs: { messages: 0, runs: 0, runEvents: 0, events: 0, completedTodos: 0 },
              errors: [{ phase: "setup", message: `(${phase}) ${String((error as Error)?.message ?? error)}` }],
            },
          });
        } catch {
          /* the setup-error callback must never itself break shutdown */
        }
      },
    );

    const ctx = {
      sessionManager: {
        getSessionId: () => "sess-1",
        getBranch: () => [],
        getSessionFile: () => undefined,
      },
    };
    await expect(
      (handlers.session_shutdown as (e: unknown, c?: unknown) => Promise<unknown>)({ type: "session_shutdown" }, ctx),
    ).resolves.toBeUndefined();

    const row = db
      .prepare("SELECT payload FROM run_events WHERE session_id='sess-1' AND type='log' ORDER BY id DESC LIMIT 1")
      .get() as { payload: string } | undefined;
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload) as { status: string; errors: Array<{ phase: string }> };
    expect(payload.status).toBe("failed");
    expect(payload.errors[0]?.phase).toBe("setup");
  });

  it("session_before_compact with no resolvable context/session id reports a 'context' phase failure, never silently", () => {
    const events: Array<{ phase: string }> = [];
    const handlers: Record<string, (event: unknown, ctx?: unknown) => unknown> = {};
    const pi = {
      on: (name: string, fn: (event: unknown, ctx?: unknown) => unknown) => {
        handlers[name] = fn;
      },
    };
    registerOrganism(
      pi,
      pi,
      () => {
        throw new Error("never called — no context resolved");
      },
      (phase) => events.push({ phase }),
    );
    const result = handlers.session_before_compact({ type: "session_before_compact" }, undefined);
    expect(result).toBeUndefined();
    expect(events.some((e) => e.phase === "context")).toBe(true);
  });
});
