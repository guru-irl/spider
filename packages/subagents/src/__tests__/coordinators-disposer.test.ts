// packages/subagents/src/__tests__/coordinators-disposer.test.ts
// IMPORTANT 3: Escalation disposer wired to dead path
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { teardownAllAsync, getCoordinators, setupEscalationNotifier, registerChild } from "../coordinators";
import { RunStore } from "../run-store";
import { openDbAt } from "@spider/db-core";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests } from "@spider/db-core";
import { bus } from "@spider/db-core";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", ".spider", "scratch", `coord-disposer-${process.pid}`);

beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
  setGlobalDbPathForTests(join(scratch, `g-${Date.now()}.db`));
});

afterEach(async () => {
  await teardownAllAsync();
  setGlobalDbPathForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

describe("IMPORTANT 3: Escalation disposer wiring", () => {
  it("teardownAllAsync must call escalation disposer", async () => {
    const projectDb = openDbAt(join(scratch, "project.db"), "worktree");
    const store = new RunStore(projectDb);
    
    let disposerCalled = false;
    const mockDisposer = () => { disposerCalled = true; };
    
    // Create a session with a tailer and escalation notifier
    const sessionId = "test-session";
    const coords = getCoordinators(sessionId, () => ({
      tailer: { stop: () => {} } as any,
      pipelines: [],
      children: new Map(),
      escalationNotifierCleanup: mockDisposer,
    }));
    
    // Verify coordinator has the disposer
    expect(coords.escalationNotifierCleanup).toBeDefined();
    
    // Call production teardown path (session_shutdown uses this)
    await teardownAllAsync({ graceMs: 10 });
    
    // Disposer MUST have been called
    expect(disposerCalled).toBe(true);
    
    projectDb.close();
  });
  
  it("getCoordinators upgrade path must preserve escalationNotifierCleanup", () => {
    const projectDb = openDbAt(join(scratch, "project.db"), "worktree");
    const store = new RunStore(projectDb);
    
    let disposerCalled = false;
    const mockDisposer = () => { disposerCalled = true; };
    
    const sessionId = "test-session";
    
    // First: registerChild creates a slot WITHOUT tailer (before first run)
    registerChild(sessionId, "run-1", { kill: () => {} } as any);
    
    // Then: first run creates full coordinator with escalation notifier
    const coords = getCoordinators(sessionId, () => ({
      tailer: { stop: () => {} } as any,
      pipelines: [],
      children: new Map(),
      escalationNotifierCleanup: mockDisposer,
    }));
    
    // The upgrade path must have preserved the escalationNotifierCleanup
    expect(coords.escalationNotifierCleanup).toBeDefined();
    
    // Call it to verify it's the right function
    coords.escalationNotifierCleanup!();
    expect(disposerCalled).toBe(true);
    
    projectDb.close();
  });
  
  it("setupEscalationNotifier must filter by sessionId", () => {
    const projectDb = openDbAt(join(scratch, "project.db"), "worktree");
    const store = new RunStore(projectDb);
    
    const messages: string[] = [];
    const ctx = {
      sessionId: "session-a",
      pi: {
        sendMessage: (msg: any) => {
          messages.push(`session-a: ${msg.content}`);
        },
      },
      ui: { notify: () => {} },
    };
    
    // Create a run in the store
    const { id: run1Id } = store.create({
      sessionId: "session-a",
      agent: "worker",
      task: "test task",
    });
    store.start(run1Id); // Make it running
    
    // Set up escalation notifier for session-a
    const cleanup = setupEscalationNotifier(ctx, store);
    
    // Emit escalation for session-a (should be delivered)
    bus.emit({
      type: "escalation",
      runId: run1Id,
      sessionId: "session-a",
      ts: Date.now(),
      summary: "Escalation from session-a",
      payload: { severity: "warning" },
    });
    
    // Emit escalation for session-b (should be IGNORED)
    bus.emit({
      type: "escalation",
      runId: run1Id,
      sessionId: "session-b",
      ts: Date.now(),
      summary: "Escalation from session-b",
      payload: { severity: "warning" },
    });
    
    // Should have received only the session-a escalation
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("session-a");
    expect(messages[0]).not.toContain("session-b");
    
    cleanup();
    projectDb.close();
  });
});
