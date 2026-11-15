import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendRunEvent, bus, openDbAt } from "@spider/db-core";
import { freshDb, testScratchPath } from "./helpers/testutil";
import { makeRunHandler, adoptReloadedChildren } from "../actions/run";
import { detachForReload, teardownAllAsync } from "../coordinators";
import { resetSharedRegistryForTests } from "../child-registry";
import { RunStore } from "../run-store";

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
  const ctx = { db, globalDb, sessionId, cwd: process.cwd(), runDbPath: db.raw.name, pi: firstParent.pi };
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
  return { db, globalDb, sessionId, children, firstParent, parent, ctx, handler, store: new RunStore(db) };
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
it.each(["blocked", "stream error"])("stops at a %s step and reports both the step and the final chain outcome", async failure => {
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
  await vi.waitFor(() => expect(chainDone(f.firstParent)).toHaveLength(1));
  expect(f.children).toHaveLength(2);
  expect(f.store.get(failed.runId)?.status).toBe("failed");
  expect(done(f.firstParent)).toHaveLength(2);
  expect(done(f.firstParent)[1]).toMatchObject({ message: { details: { runId: failed.runId, name: "two", status: "failed" } }, options: { triggerTurn: true } });
  expect(done(f.firstParent)[1].message.content).toContain(reason);
  expect(chainDone(f.firstParent)[0]).toMatchObject({ message: { details: { runId: failed.runId, step: 2, name: "two", status: "failed" } }, options: { triggerTurn: true } });
  expect(chainDone(f.firstParent)[0].message.content).toContain(reason);
});

// Break: a clean process exit overwrites the child's already-recorded failed result.
it("reports a persisted step failure even when the process later exits cleanly", async () => {
  const f = fixture();
  await f.handler({ chain: [{ name: "one", task: "fails" }, { name: "two", task: "must not start" }] }, f.ctx);
  const runId = f.children[0].runId;
  f.store.finish(runId, { status: "failed", result: "recorded blocker" });
  f.children[0].finish({ exitCode: 0, result: "misleading exit result" });
  await vi.waitFor(() => expect(chainDone(f.firstParent)).toHaveLength(1));
  expect(f.children).toHaveLength(1);
  expect(done(f.firstParent)[0].message.details).toMatchObject({ runId, status: "failed", output: "recorded blocker" });
  expect(chainDone(f.firstParent)[0].message.content).toContain("recorded blocker");
  expect(chainDone(f.firstParent)[0].message.content).not.toContain("misleading exit result");
});

// Break: a wait rejection ends the chain without a step notice or a final cause.
it("reports a rejected child wait and does not start another step", async () => {
  const f = fixture();
  await f.handler({ chain: [{ name: "one", task: "fails" }, { name: "two", task: "must not start" }] }, f.ctx);
  f.children[0].failWait(new Error("child wait lost"));
  await vi.waitFor(() => expect(chainDone(f.firstParent)).toHaveLength(1));
  expect(f.children).toHaveLength(1);
  expect(done(f.firstParent)).toHaveLength(1);
  expect(done(f.firstParent)[0].message.content).toContain("child wait lost");
  expect(chainDone(f.firstParent)[0].message.content).toContain("child wait lost");
  expect(chainDone(f.firstParent)[0].message.details).toMatchObject({ runId: f.children[0].runId, step: 1, status: "failed" });
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
  await vi.waitFor(() => expect(chainDone(next)).toHaveLength(1));
  adoptReloadedChildren(nextCtx);
  expect(f.children).toHaveLength(2);
  expect(done(f.firstParent)).toHaveLength(1);
  expect(chainDone(f.firstParent)).toHaveLength(0);
  expect(done(next)[0]).toMatchObject({ message: { details: { runId: f.children[1].runId, status: "failed" } }, options: { triggerTurn: true } });
  expect(chainDone(next)[0]).toMatchObject({ message: { details: { runId: f.children[1].runId, step: 2, status: "failed" } }, options: { triggerTurn: true } });
  expect(done(next)).toHaveLength(1);
  expect(chainDone(next)).toHaveLength(1);
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

// Break: one failed send suppresses the other independent notice.
it("still reports the stopped chain when the step notice cannot be sent", async () => {
  const f = fixture(true);
  const send = f.firstParent.pi.sendMessage;
  f.firstParent.pi.sendMessage = (message, options) => {
    if (message.customType === "spider.subagent_done") throw new Error("step notice unavailable");
    return send(message, options);
  };
  await f.handler({ chain: [{ name: "one", task: "fails" }] }, f.ctx);
  f.children[0].finish({ exitCode: 1, result: "step failed" });
  await vi.waitFor(() => expect(chainDone(f.firstParent)).toHaveLength(1));
  expect(done(f.firstParent)).toHaveLength(0);
  expect(chainDone(f.firstParent)[0].message.content).toContain("step failed");
  expect(f.globalDb!.prepare("SELECT run_id FROM run_routes WHERE run_id=?").get(f.children[0].runId)).toBeDefined();
  await detachForReload(f.sessionId);
  const next = f.parent(), nextCtx = { ...f.ctx, pi: next.pi };
  adoptReloadedChildren(nextCtx);
  await vi.waitFor(() => expect(done(next)).toHaveLength(1));
  expect(chainDone(next)).toHaveLength(0);
});

// Break: marking the step delivered loses a failed chain notice that could not be sent.
it("retries a failed chain notice after reload without repeating its delivered step", async () => {
  const f = fixture();
  const send = f.firstParent.pi.sendMessage;
  f.firstParent.pi.sendMessage = (message, options) => {
    if (message.customType === "spider.chain_done") throw new Error("parent temporarily unavailable");
    return send(message, options);
  };
  await f.handler({ chain: [{ name: "one", task: "fails" }] }, f.ctx);
  f.children[0].finish({ exitCode: 1, result: "launch failed" });
  await vi.waitFor(() => expect(done(f.firstParent)).toHaveLength(1));
  await detachForReload(f.sessionId);
  const next = f.parent();
  const nextCtx = { ...f.ctx, pi: next.pi };
  adoptReloadedChildren(nextCtx);
  await vi.waitFor(() => expect(chainDone(next)).toHaveLength(1));
  adoptReloadedChildren(nextCtx);
  expect(done(next)).toHaveLength(0);
  expect(chainDone(next)[0]).toMatchObject({ message: { details: { runId: f.children[0].runId, step: 1, status: "failed" } }, options: { triggerTurn: true } });
  expect(chainDone(next)[0].message.content).toContain("launch failed");
  expect(chainDone(next)).toHaveLength(1);
});

// Break: clearing the run route before both claims loses a pending chain notice after a binding change.
it("retains the original run route until a failed chain notice is retried in a different binding", async () => {
  const f = fixture(true);
  const send = f.firstParent.pi.sendMessage;
  f.firstParent.pi.sendMessage = (message, options) => {
    if (message.customType === "spider.chain_done") throw new Error("chain notice unavailable");
    return send(message, options);
  };
  await f.handler({ chain: [{ name: "one", task: "fails" }] }, f.ctx);
  f.children[0].finish({ exitCode: 1, result: "failure in original binding" });
  await vi.waitFor(() => expect(done(f.firstParent)).toHaveLength(1));
  const runId = f.children[0].runId;
  expect(f.globalDb!.prepare("SELECT db_path FROM run_routes WHERE run_id=?").get(runId)).toEqual({ db_path: f.db.raw.name });
  await detachForReload(f.sessionId);
  const otherDb = freshDb(); openDbs.push(otherDb);
  const next = f.parent(), nextCtx = { ...f.ctx, db: otherDb, runDbPath: otherDb.raw.name, pi: next.pi };
  adoptReloadedChildren(nextCtx);
  await vi.waitFor(() => expect(chainDone(next)).toHaveLength(1));
  adoptReloadedChildren(nextCtx);
  expect(done(next)).toHaveLength(0);
  expect(chainDone(next)[0].message.content).toContain("failure in original binding");
  expect(f.globalDb!.prepare("SELECT db_path FROM run_routes WHERE run_id=?").get(runId)).toBeUndefined();
  expect(chainDone(next)).toHaveLength(1);
});
