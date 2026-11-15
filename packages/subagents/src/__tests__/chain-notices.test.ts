import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendRunEvent, bus } from "@spider/db-core";
import { freshDb } from "./helpers/testutil";
import { makeRunHandler, adoptReloadedChildren } from "../actions/run";
import { detachForReload, teardownAllAsync } from "../coordinators";
import { resetSharedRegistryForTests } from "../child-registry";
import { RunStore } from "../run-store";

interface Notice { message: any; options: any }
interface FakeChild {
  runId: string;
  finish(exit: { exitCode: number; result?: string }): void;
}

const openDbs: ReturnType<typeof freshDb>[] = [];
afterEach(async () => {
  await teardownAllAsync();
  resetSharedRegistryForTests();
  for (const db of openDbs.splice(0)) db.close();
});

function fixture() {
  const db = freshDb(); openDbs.push(db);
  const sessionId = `chain-${randomUUID()}`;
  const children: FakeChild[] = [];
  const parent = () => {
    const notices: Notice[] = [];
    return { notices, pi: { sendMessage: (message: any, options: any) => notices.push({ message, options }) } };
  };
  const firstParent = parent();
  const ctx = { db, sessionId, cwd: process.cwd(), runDbPath: db.raw.name, pi: firstParent.pi };
  const handler = makeRunHandler({ supervise: true, spawner: spec => {
    const supervisor = spec.supervisor!;
    mkdirSync(supervisor.directory, { recursive: true });
    appendRunEvent(db, { runId: supervisor.runId, sessionId, ts: Date.now(), type: "child_supervisor", payload: { version: 1, directory: supervisor.directory } });
    let resolve!: (exit: { exitCode: number; result?: string }) => void;
    const exit = new Promise<{ exitCode: number; result?: string }>(r => { resolve = r; });
    const finish = (outcome: { exitCode: number; result?: string }) => {
      writeFileSync(join(supervisor.directory, "exit.json"), JSON.stringify(outcome));
      resolve(outcome);
    };
    children.push({ runId: supervisor.runId, finish });
    return { durable: true, wait: () => exit, kill: () => finish({ exitCode: 143 }), killAsync: async () => finish({ exitCode: 143 }), detach() {}, unbindEvents() {}, bindEvents() {} };
  } });
  return { db, sessionId, children, firstParent, parent, ctx, handler, store: new RunStore(db) };
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
