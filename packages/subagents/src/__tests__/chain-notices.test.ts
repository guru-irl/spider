import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendRunEvent, bus, openDbAt } from "@spider/db-core";
import { freshDb, testScratchPath } from "./helpers/testutil";
import { makeRunHandler, makeAsyncNotifier, adoptReloadedChildren } from "../actions/run";
import { detachForReload, teardownAllAsync } from "../coordinators";
import { resetSharedRegistryForTests } from "../child-registry";
import { RunStore } from "../run-store";
import { listSessionBlockers } from "../blockers";
import { makeKillHandler } from "../actions/kill";

interface Notice { message: any; options: any }
interface FakeChild {
  runId: string;
  finish(exit: { exitCode: number; result?: string }): void;
  failWait(error: Error): void;
}

const openDbs: ReturnType<typeof freshDb>[] = [];
afterEach(async () => {
  await teardownAllAsync();
  resetSharedRegistryForTests();
  for (const db of openDbs.splice(0)) db.close();
});

function fixture(withGlobal = false) {
  const db = freshDb(); openDbs.push(db);
  const globalDb = withGlobal ? openDbAt(testScratchPath(`chain-routes-${randomUUID()}.db`), "global") : undefined;
  if (globalDb) openDbs.push(globalDb);
  const sessionId = `chain-${randomUUID()}`;
  const children: FakeChild[] = [];
  const parent = () => {
    const notices: Notice[] = [];
    return { notices, pi: { sendMessage: (message: any, options: any) => notices.push({ message, options }) } };
  };
  const firstParent = parent();
  const toasts: string[] = [];
  const ctx = { db, globalDb, sessionId, cwd: process.cwd(), runDbPath: db.raw.name, pi: firstParent.pi,
    ui: { notify: (message: string) => toasts.push(message) } };
  const handler = makeRunHandler({ supervise: true, spawner: spec => {
    const supervisor = spec.supervisor!;
    mkdirSync(supervisor.directory, { recursive: true });
    appendRunEvent(db, { runId: supervisor.runId, sessionId, ts: Date.now(), type: "child_supervisor", payload: { version: 1, directory: supervisor.directory } });
    let resolve!: (exit: { exitCode: number; result?: string }) => void;
    let reject!: (error: Error) => void;
    const exit = new Promise<{ exitCode: number; result?: string }>((r, j) => { resolve = r; reject = j; });
    const finish = (outcome: { exitCode: number; result?: string }) => {
      writeFileSync(join(supervisor.directory, "exit.json"), JSON.stringify(outcome));
      resolve(outcome);
    };
    children.push({ runId: supervisor.runId, finish, failWait: reject });
    return { durable: true, wait: () => exit, kill: () => finish({ exitCode: 143 }), killAsync: async () => finish({ exitCode: 143 }), detach() {}, unbindEvents() {}, bindEvents() {} };
  } });
  return { db, globalDb, sessionId, children, firstParent, parent, ctx, handler, toasts, store: new RunStore(db) };
}

const done = (parent: ReturnType<ReturnType<typeof fixture>["parent"]>) =>
  parent.notices.filter(n => n.message.customType === "spider.subagent_done");

const chainDone = (parent: ReturnType<ReturnType<typeof fixture>["parent"]>) =>
  parent.notices.filter(n => n.message.customType === "spider.chain_done");

// Break: waiting for the whole chain before telling an idle parent about its first step.
it("wakes the parent after each successful step while the next step is still running", async () => {
  const f = fixture();
  await f.handler({ chain: [
    { name: "one", task: "first" }, { name: "two", task: "second: {previous}" },
    { name: "three", task: "third" },
  ] }, f.ctx);
  f.children[0].finish({ exitCode: 0, result: "first result" });
  await vi.waitFor(() => expect(done(f.firstParent)).toHaveLength(1));
  await vi.waitFor(() => expect(f.children).toHaveLength(2));
  expect(done(f.firstParent)[0]).toMatchObject({
    message: { details: { runId: f.children[0].runId, name: "one", status: "done", output: "first result" } },
    options: { triggerTurn: true },
  });
  expect(f.store.get(f.children[1].runId)?.task).toBe("second: first result");
  f.children[1].finish({ exitCode: 0, result: "second result" });
  await vi.waitFor(() => expect(done(f.firstParent)).toHaveLength(2));
  await vi.waitFor(() => expect(f.children).toHaveLength(3));
  expect(done(f.firstParent)[1]).toMatchObject({
    message: { details: { runId: f.children[1].runId, name: "two", status: "done", output: "second result" } },
    options: { triggerTurn: true },
  });
  expect(chainDone(f.firstParent)).toHaveLength(0);
});

// Break: a failed result is passed to the next child as if it were a successful handoff.
it("does not start a later step after a failure", async () => {
  const f = fixture();
  await f.handler({ chain: [{ name: "one", task: "fails" }, { name: "two", task: "must not start" }] }, f.ctx);
  f.children[0].finish({ exitCode: 1, result: "failed handoff" });
  await vi.waitFor(() => expect(done(f.firstParent)).toHaveLength(1));
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.children).toHaveLength(1);
});

// Break: a failed step launches the next child and the parent never hears why the chain stopped.
it.each(["blocked", "stream error"])("stops at a %s step and reports the chain outcome with that step", async failure => {
  const f = fixture();
  await f.handler({ chain: [
    { name: "one", task: "first" }, { name: "two", task: "second" }, { name: "three", task: "must not start" },
  ] }, f.ctx);
  f.children[0].finish({ exitCode: 0, result: "first result" });
  await vi.waitFor(() => expect(f.children).toHaveLength(2));
  const failed = f.children[1];
  const reason = failure === "blocked" ? "blocked by a missing input" : "provider stream ended without a terminal event";
  if (failure === "blocked") {
    bus.emit({ type: "escalation", runId: failed.runId, sessionId: f.sessionId,
      ts: Date.now(), summary: reason, payload: { severity: "blocked" } });
    expect(f.firstParent.notices.filter(n => n.message.customType === "spider.escalation")).toHaveLength(1);
    failed.finish({ exitCode: 1, result: reason });
  } else {
    appendRunEvent(f.db, { runId: failed.runId, sessionId: f.sessionId, ts: Date.now(), type: "message",
      payload: { stopReason: "error", errorMessage: reason } });
    failed.finish({ exitCode: 1 });
  }
  await vi.waitFor(() => expect(done(f.firstParent)).toHaveLength(2));
  expect(f.children).toHaveLength(2);
  expect(f.store.get(failed.runId)?.status).toBe("failed");
  expect(done(f.firstParent)[1]).toMatchObject({ message: { details: { runId: failed.runId, name: "two", status: "failed",
    chain: { outcome: "stopped", step: 2, total: 3, notStarted: ["three"] } } }, options: { triggerTurn: true } });
  expect(done(f.firstParent)[1].message.content).toContain(reason);
  expect(chainDone(f.firstParent)).toHaveLength(0);
});

// Break: a clean process exit overwrites the child's already-recorded failed result.
it("reports a persisted step failure even when the process later exits cleanly", async () => {
  const f = fixture();
  await f.handler({ chain: [{ name: "one", task: "fails" }, { name: "two", task: "must not start" }] }, f.ctx);
  const runId = f.children[0].runId;
  f.store.finish(runId, { status: "failed", result: "recorded blocker" });
  f.children[0].finish({ exitCode: 0, result: "misleading exit result" });
  await vi.waitFor(() => expect(done(f.firstParent)).toHaveLength(1));
  expect(f.children).toHaveLength(1);
  expect(done(f.firstParent)[0].message.details).toMatchObject({ runId, status: "failed", output: "recorded blocker",
    chain: { outcome: "stopped", step: 1, total: 2, notStarted: ["two"] } });
  expect(done(f.firstParent)[0].message.content).toContain("recorded blocker");
  expect(done(f.firstParent)[0].message.content).not.toContain("misleading exit result");
  expect(chainDone(f.firstParent)).toHaveLength(0);
});

// Break: a wait rejection ends the chain without a step notice or a final cause.
it("reports a rejected child wait and does not start another step", async () => {
  const f = fixture();
  await f.handler({ chain: [{ name: "one", task: "fails" }, { name: "two", task: "must not start" }] }, f.ctx);
  f.children[0].failWait(new Error("child wait lost"));
  await vi.waitFor(() => expect(done(f.firstParent)).toHaveLength(1));
  expect(f.children).toHaveLength(1);
  expect(done(f.firstParent)[0].message.content).toContain("child wait lost");
  expect(done(f.firstParent)[0].message.details).toMatchObject({ runId: f.children[0].runId, status: "failed",
    chain: { outcome: "stopped", step: 1, total: 2, notStarted: ["two"] } });
  expect(chainDone(f.firstParent)).toHaveLength(0);
});

// Break: a handover repeats an already-delivered step or calls the stale parent for the active one.
it("delivers a failed in-flight step and its chain outcome exactly once after reload", async () => {
  const f = fixture();
  await f.handler({ chain: [
    { name: "one", task: "first" }, { name: "two", task: "second" }, { name: "three", task: "must not start" },
  ] }, f.ctx);
  f.children[0].finish({ exitCode: 0, result: "first result" });
  await vi.waitFor(() => expect(done(f.firstParent)).toHaveLength(1));
  await vi.waitFor(() => expect(f.children).toHaveLength(2));
  await detachForReload(f.sessionId);
  const next = f.parent();
  const nextCtx = { ...f.ctx, pi: next.pi };
  adoptReloadedChildren(nextCtx);
  f.children[1].finish({ exitCode: 1, result: "second step failed" });
  await vi.waitFor(() => expect(done(next)).toHaveLength(1));
  adoptReloadedChildren(nextCtx);
  expect(f.children).toHaveLength(2);
  expect(done(f.firstParent)).toHaveLength(1);
  expect(chainDone(f.firstParent)).toHaveLength(0);
  expect(done(next)[0]).toMatchObject({ message: { details: { runId: f.children[1].runId, status: "failed",
    chain: { outcome: "stopped", step: 2, total: 3, notStarted: ["three"] } } }, options: { triggerTurn: true } });
  expect(done(next)).toHaveLength(1);
  expect(chainDone(next)).toHaveLength(0);
});

// Break: a final step finishes after handover without the successful chain outcome.
it("reports a successful last step and chain outcome once after an in-flight reload", async () => {
  const f = fixture(true);
  await f.handler({ chain: [{ name: "one", task: "first" }, { name: "two", task: "last" }] }, f.ctx);
  f.children[0].finish({ exitCode: 0, result: "first result" });
  await vi.waitFor(() => expect(f.children).toHaveLength(2));
  await detachForReload(f.sessionId);
  const next = f.parent(), nextCtx = { ...f.ctx, pi: next.pi };
  adoptReloadedChildren(nextCtx);
  f.children[1].finish({ exitCode: 0, result: "last result" });
  await vi.waitFor(() => expect(done(next)).toHaveLength(1));
  expect(f.firstParent.notices).toHaveLength(1);
  expect(next.notices).toHaveLength(1);
  expect(done(next)[0]).toMatchObject({ message: { details: { runId: f.children[1].runId, output: "last result",
    chain: { outcome: "complete", step: 2, total: 2, notStarted: [] } } }, options: { triggerTurn: true } });
  expect(f.globalDb!.prepare("SELECT run_id FROM run_routes WHERE run_id=?").get(f.children[1].runId)).toBeUndefined();
  await detachForReload(f.sessionId);
  const later = f.parent();
  expect(adoptReloadedChildren({ ...f.ctx, pi: later.pi }).adopted).toEqual([]);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(later.notices).toHaveLength(0);
});

// Break: an earlier reload leaves the new activation sending a chain notice to the old parent or as nextTurn.
it("uses the current parent and wakes it for a chain started after an earlier reload", async () => {
  const f = fixture();
  await f.handler({ agent: "worker", task: "single" }, f.ctx);
  await detachForReload(f.sessionId);
  const next = f.parent();
  const nextCtx = { ...f.ctx, pi: next.pi };
  adoptReloadedChildren(nextCtx);
  f.children[0].finish({ exitCode: 0, result: "single result" });
  await vi.waitFor(() => expect(done(next)).toHaveLength(1));
  await f.handler({ chain: [{ name: "one", task: "first" }, { name: "two", task: "still running" }] }, nextCtx);
  f.children[1].finish({ exitCode: 0, result: "chain result" });
  await vi.waitFor(() => expect(done(next)).toHaveLength(2));
  expect(done(f.firstParent)).toHaveLength(0);
  expect(done(next)[1]).toMatchObject({ message: { details: { runId: f.children[1].runId, status: "done" } }, options: { triggerTurn: true } });
  expect(f.children).toHaveLength(3);
});

// Break: a failed send commits the sole claim and loses the stopped outcome.
it("retries the stopped step and chain outcome together after a send throws", async () => {
  const f = fixture(true);
  let attempts = 0;
  f.firstParent.pi.sendMessage = () => { attempts++; throw new Error("step notice unavailable"); };
  await f.handler({ chain: [{ name: "one", task: "fails" }] }, f.ctx);
  f.children[0].finish({ exitCode: 1, result: "step failed" });
  await vi.waitFor(() => expect(attempts).toBe(1));
  expect(f.firstParent.notices).toHaveLength(0);
  expect(f.toasts).toHaveLength(0);
  expect(f.globalDb!.prepare("SELECT run_id FROM run_routes WHERE run_id=?").get(f.children[0].runId)).toBeDefined();
  await detachForReload(f.sessionId);
  const next = f.parent(), nextCtx = { ...f.ctx, pi: next.pi };
  adoptReloadedChildren(nextCtx);
  await vi.waitFor(() => expect(done(next)).toHaveLength(1));
  expect(done(next)[0].message.content).toContain("step failed");
  expect(done(next)[0].message.details.chain).toMatchObject({ outcome: "stopped", step: 1, total: 1, notStarted: [] });
  expect(next.notices).toHaveLength(1);
});

// Break: a repeated finalization bypasses the run's completion claim.
it("does not repeat a delivered stopped step when finalization or adoption runs again", async () => {
  const f = fixture();
  await f.handler({ chain: [{ name: "one", task: "fails" }] }, f.ctx);
  f.children[0].finish({ exitCode: 1, result: "launch failed" });
  await vi.waitFor(() => expect(done(f.firstParent)).toHaveLength(1));
  const row = f.store.get(f.children[0].runId)!;
  const notifyAgain = makeAsyncNotifier(f.ctx);
  notifyAgain(row, row.status, row.result ?? undefined);
  notifyAgain(row, row.status, row.result ?? undefined);
  expect(done(f.firstParent)[0]).toMatchObject({ message: { details: { runId: row.id, status: "failed",
    chain: { outcome: "stopped", step: 1, total: 1, notStarted: [] } } }, options: { triggerTurn: true } });
  expect(done(f.firstParent)[0].message.content).toContain("launch failed");
  expect(f.firstParent.notices).toHaveLength(1);
  await detachForReload(f.sessionId);
  const next = f.parent(), nextCtx = { ...f.ctx, pi: next.pi };
  adoptReloadedChildren(nextCtx);
  await new Promise<void>(resolve => setImmediate(resolve));
  adoptReloadedChildren(nextCtx);
  expect(next.notices).toHaveLength(0);
});

// Break: clearing the route on a failed send loses the pending step after a binding change.
it("retains the original route until a stopped step is retried in a different binding", async () => {
  const f = fixture(true);
  let attempts = 0;
  f.firstParent.pi.sendMessage = () => { attempts++; throw new Error("step notice unavailable"); };
  await f.handler({ chain: [{ name: "one", task: "fails" }] }, f.ctx);
  f.children[0].finish({ exitCode: 1, result: "failure in original binding" });
  await vi.waitFor(() => expect(attempts).toBe(1));
  const runId = f.children[0].runId;
  expect(f.globalDb!.prepare("SELECT db_path FROM run_routes WHERE run_id=?").get(runId)).toEqual({ db_path: f.db.raw.name });
  await detachForReload(f.sessionId);
  const otherDb = freshDb(); openDbs.push(otherDb);
  const next = f.parent(), nextCtx = { ...f.ctx, db: otherDb, runDbPath: otherDb.raw.name, pi: next.pi };
  adoptReloadedChildren(nextCtx);
  await vi.waitFor(() => expect(done(next)).toHaveLength(1));
  adoptReloadedChildren(nextCtx);
  expect(done(next)[0].message.content).toContain("failure in original binding");
  expect(done(next)[0].message.details.chain).toMatchObject({ outcome: "stopped", step: 1, total: 1, notStarted: [] });
  expect(f.globalDb!.prepare("SELECT db_path FROM run_routes WHERE run_id=?").get(runId)).toBeUndefined();
  expect(next.notices).toHaveLength(1);
});

// Break: the final result and chain summary are dispatched as two separate messages.
it("reports a complete chain on the last step notice without duplicating output or toast", async () => {
  const f = fixture();
  await f.handler({ chain: [{ name: "one", task: "first" }, { name: "two", task: "last" }] }, f.ctx);
  f.children[0].finish({ exitCode: 0, result: "first output" });
  await vi.waitFor(() => expect(f.children).toHaveLength(2));
  f.children[1].finish({ exitCode: 0, result: "unique final output" });
  await vi.waitFor(() => expect(done(f.firstParent)).toHaveLength(2));
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.firstParent.notices.map(n => n.message.customType)).toEqual(["spider.subagent_done", "spider.subagent_done"]);
  expect(done(f.firstParent)[0].message.details.chain).toBeUndefined();
  expect(done(f.firstParent)[1]).toMatchObject({
    message: { details: { runId: f.children[1].runId, output: "unique final output",
      chain: { outcome: "complete", step: 2, total: 2, notStarted: [] } } },
    options: { triggerTurn: true },
  });
  expect(done(f.firstParent)[1].message.content).toContain("chain complete");
  expect(done(f.firstParent)[1].message.content.match(/unique final output/g)).toHaveLength(1);
  expect(f.toasts).toHaveLength(2);
});

// Break: a failed step reports no outcome, names the wrong remaining step, or sends a second notice.
it("includes the stopped outcome and unstarted names in the failed step notice", async () => {
  const f = fixture();
  await f.handler({ chain: [
    { name: "one", task: "first" }, { name: "two", task: "fails" }, { name: 'last "quoted"', task: "not started" },
  ] }, f.ctx);
  f.children[0].finish({ exitCode: 0, result: "first output" });
  await vi.waitFor(() => expect(f.children).toHaveLength(2));
  f.children[1].finish({ exitCode: 1, result: "missing input\nmore detail" });
  await vi.waitFor(() => expect(done(f.firstParent)).toHaveLength(2));
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.children).toHaveLength(2);
  expect(f.firstParent.notices.map(n => n.message.customType)).toEqual(["spider.subagent_done", "spider.subagent_done"]);
  expect(done(f.firstParent)[1]).toMatchObject({ message: { details: { status: "failed", output: "missing input\nmore detail",
    chain: { outcome: "stopped", step: 2, total: 3, notStarted: ['last "quoted"'], cause: "missing input" } } }, options: { triggerTurn: true } });
  expect(done(f.firstParent)[1].message.content).toContain("chain stopped at step 2 of 3: missing input");
  expect(f.toasts).toHaveLength(2);
});

// Break: the header repeats an entire long single-line failure before the step output.
it("keeps a long failure in the output once and caps the header cause", async () => {
  const f = fixture();
  const failure = `${"provider failure ".repeat(30)}unique-end`;
  await f.handler({ chain: [{ name: "one", task: "fails" }] }, f.ctx);
  f.children[0].finish({ exitCode: 1, result: failure });
  await vi.waitFor(() => expect(done(f.firstParent)).toHaveLength(1));
  const message = done(f.firstParent)[0].message;
  expect(message.details.output).toBe(failure);
  expect(message.details.chain.cause.length).toBeLessThanOrEqual(160);
  expect(message.content.match(/unique-end/g)).toHaveLength(1);
  expect(f.firstParent.notices).toHaveLength(1);
});

// Break: the handover stops a successful non-final step but its notice claims the chain continues.
it("reports the unstarted steps when reload interrupts a successful chain step", async () => {
  const f = fixture();
  await f.handler({ chain: [{ name: "one", task: "first" }, { name: "two", task: "not started" }] }, f.ctx);
  await detachForReload(f.sessionId);
  const next = f.parent(), nextCtx = { ...f.ctx, pi: next.pi };
  adoptReloadedChildren(nextCtx);
  f.children[0].finish({ exitCode: 0, result: "first output" });
  await vi.waitFor(() => expect(done(next)).toHaveLength(1));
  expect(f.children).toHaveLength(1);
  expect(done(next)[0].message.details.chain).toMatchObject({ outcome: "stopped", step: 1, total: 2, notStarted: ["two"] });
  expect(done(next)[0].message.content).toContain("chain stopped at step 1 of 2: The chain stopped during /reload.");
  expect(next.notices).toHaveLength(1);
});

// Break: a shutdown cancellation wakes a dying session or omits the stopped outcome.
it("queues a shutdown-cancelled chain step with its stopped outcome", async () => {
  const f = fixture();
  await f.handler({ chain: [{ name: "one", task: "first" }, { name: "two", task: "not started" }] }, f.ctx);
  f.store.cancel(f.children[0].runId, "Session shutdown cancelled this run.");
  f.children[0].finish({ exitCode: 143 });
  await vi.waitFor(() => expect(done(f.firstParent)).toHaveLength(1));
  expect(f.children).toHaveLength(1);
  expect(f.firstParent.notices).toHaveLength(1);
  expect(done(f.firstParent)[0]).toMatchObject({ message: { details: { status: "cancelled", output: "Session shutdown cancelled this run.",
    chain: { outcome: "stopped", step: 1, total: 2, notStarted: ["two"], cause: "Session shutdown cancelled this run." } } },
    options: { triggerTurn: false, deliverAs: "nextTurn" } });
});

// Break: a user kill emits a second report after the kill action already told the parent.
it("keeps a user-killed chain silent after the earlier step notice", async () => {
  const f = fixture();
  await f.handler({ chain: [{ name: "one", task: "first" }, { name: "two", task: "cancelled" }, { name: "three", task: "not started" }] }, f.ctx);
  f.children[0].finish({ exitCode: 0, result: "first output" });
  await vi.waitFor(() => expect(f.children).toHaveLength(2));
  const killed = await makeKillHandler()({ id: f.children[1].runId }, f.ctx);
  expect(killed.details.killed).toMatchObject([{ runId: f.children[1].runId, outcome: "killed" }]);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.children).toHaveLength(2);
  expect(f.firstParent.notices.map(n => n.message.customType)).toEqual(["spider.subagent_done"]);
  expect(f.toasts).toHaveLength(1);
});

// Break: silence after a user kill hides a steer whose delivery remains uncertain.
it.each(["accepted but not confirmed", "no reply yet, delivery unknown"])("reports an unresolved steer (%s) when a user kills a chain", async delivery => {
  const f = fixture();
  await f.handler({ chain: [{ name: "one", task: "first" }, { name: "two", task: "not started" }] }, f.ctx);
  appendRunEvent(f.db, { runId: f.children[0].runId, sessionId: f.sessionId, ts: Date.now(), type: "steer_delivery",
    payload: { requestId: "pending-steer", delivery, delivered: false } });
  const killed = await makeKillHandler()({ id: f.children[0].runId }, f.ctx);
  expect(killed.details.killed).toMatchObject([{ outcome: "killed" }]);
  await vi.waitFor(() => expect(done(f.firstParent)).toHaveLength(1));
  expect(f.children).toHaveLength(1);
  expect(done(f.firstParent)[0].message.content).toContain(`1 steer(s) ${delivery}.`);
  expect(done(f.firstParent)[0].message.details.chain).toMatchObject({ outcome: "stopped", step: 1, total: 2, notStarted: ["two"] });
  expect(done(f.firstParent)[0].options).toEqual({ triggerTurn: true });
  expect(f.firstParent.notices).toHaveLength(1);
});

// Break: a stale send commits the final claim or loses the chain outcome before reload.
it("retries a successful final notice after a stale-context throw exactly once", async () => {
  const f = fixture(true);
  const send = f.firstParent.pi.sendMessage;
  let staleAttempts = 0;
  f.firstParent.pi.sendMessage = (message, options) => {
    if (message.details.name === "two") { staleAttempts++; throw new Error("stale extension context"); }
    return send(message, options);
  };
  await f.handler({ chain: [{ name: "one", task: "first" }, { name: "two", task: "last" }] }, f.ctx);
  f.children[0].finish({ exitCode: 0, result: "first output" });
  await vi.waitFor(() => expect(f.children).toHaveLength(2));
  f.children[1].finish({ exitCode: 0, result: "last output" });
  await vi.waitFor(() => expect(staleAttempts).toBeGreaterThan(0));
  const runId = f.children[1].runId;
  expect(done(f.firstParent)).toHaveLength(1);
  expect(f.globalDb!.prepare("SELECT db_path FROM run_routes WHERE run_id=?").get(runId)).toBeDefined();
  expect(listSessionBlockers(f.db, f.sessionId).map(blocker => blocker.id)).toContain(runId);
  await detachForReload(f.sessionId);
  const next = f.parent(), nextCtx = { ...f.ctx, pi: next.pi };
  expect(adoptReloadedChildren(nextCtx).adopted).toEqual([runId]);
  await vi.waitFor(() => expect(done(next)).toHaveLength(1));
  expect(next.notices).toHaveLength(1);
  expect(done(next)[0]).toMatchObject({ message: { details: { runId, output: "last output",
    chain: { outcome: "complete", step: 2, total: 2, notStarted: [] } } }, options: { triggerTurn: true } });
  expect(done(next)[0].message.content).toContain("chain complete");
  expect(f.globalDb!.prepare("SELECT db_path FROM run_routes WHERE run_id=?").get(runId)).toBeUndefined();
  expect(listSessionBlockers(f.db, f.sessionId).map(blocker => blocker.id)).not.toContain(runId);
  await detachForReload(f.sessionId);
  const later = f.parent();
  expect(adoptReloadedChildren({ ...f.ctx, pi: later.pi }).adopted).toEqual([]);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(next.notices).toHaveLength(1);
  expect(later.notices).toHaveLength(0);
});

// Break: upgrading from main redelivers an already-claimed aggregate or strands unclaimed steps.
it("adopts main-format chain records once without replaying an already claimed aggregate", async () => {
  const f = fixture(true);
  const seed = (name: string, phase: string, status: "done" | "failed", result: string, remaining?: string[], claimed = false) => {
    const { id } = f.store.create({ sessionId: f.sessionId, agent: "worker", name, phase });
    f.store.start(id);
    if (remaining) appendRunEvent(f.db, { runId: id, sessionId: f.sessionId, ts: Date.now(), type: "chain_steps", payload: { remaining } });
    const directory = testScratchPath(`legacy-chain-${id}`);
    mkdirSync(directory, { recursive: true });
    const exit = { exitCode: status === "done" ? 0 : 1, result };
    writeFileSync(join(directory, "exit.json"), JSON.stringify(exit));
    appendRunEvent(f.db, { runId: id, sessionId: f.sessionId, ts: Date.now(), type: "child_supervisor", payload: { version: 1, directory } });
    f.store.finish(id, { status, result }, { removeRoute: false });
    if (claimed) appendRunEvent(f.db, { runId: id, sessionId: f.sessionId, ts: Date.now(), type: "completion_delivered" });
    else f.globalDb!.prepare("INSERT INTO run_routes (run_id,session_id,db_path) VALUES (?,?,?)").run(id, f.sessionId, f.db.raw.name);
    return id;
  };
  // Main claimed every row of an aggregate atomically; its final step had no chain_steps event.
  const already = [seed("already-one", "step-1", "done", "old first", ['Step 2 "already-two"'], true),
    seed("already-two", "step-2", "done", "old final", undefined, true)];
  // Main could continue after failure, so this older failure cannot imply that the chain stopped.
  const pending = [seed("legacy-one", "step-1", "failed", "old failure", ['Step 2 "legacy-two"']),
    seed("legacy-two", "step-2", "done", "old final")];
  const next = f.parent(), nextCtx = { ...f.ctx, pi: next.pi };
  expect(adoptReloadedChildren(nextCtx).adopted.sort()).toEqual([...pending].sort());
  await vi.waitFor(() => expect(done(next)).toHaveLength(2), { timeout: 10000 });
  expect(done(next).map(n => n.message.details.runId).sort()).toEqual([...pending].sort());
  expect(done(next).every(n => n.message.details.chain === undefined)).toBe(true);
  expect(next.notices).toHaveLength(2);
  for (const id of [...already, ...pending]) expect(f.globalDb!.prepare("SELECT run_id FROM run_routes WHERE run_id=?").get(id)).toBeUndefined();
  await detachForReload(f.sessionId);
  const later = f.parent();
  expect(adoptReloadedChildren({ ...f.ctx, pi: later.pi }).adopted).toEqual([]);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(next.notices).toHaveLength(2);
  expect(later.notices).toHaveLength(0);
});
