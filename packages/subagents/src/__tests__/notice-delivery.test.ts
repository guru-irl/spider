import { describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers/testutil";
import { RunStore } from "../run-store";
import { emitEscalation } from "../run-events";
import { setupEscalationNotifier } from "../coordinators";
import { makeAsyncNotifier } from "../actions/run";

describe("subagent notice delivery", () => {
  it.each(["blocked", "question", "warning"] as const)("shows one interactive card for an escalation: %s", (severity) => {
    const db = freshDb();
    const store = new RunStore(db);
    const run = store.create({ sessionId: "owner", agent: "worker", task: "task" });
    const sendMessage = vi.fn(), notify = vi.fn();
    const cleanup = setupEscalationNotifier({ sessionId: "owner", mode: "tui", pi: { sendMessage }, ui: { notify } }, store);
    try {
      emitEscalation(db, { sessionId: "owner", runId: run.id, severity, summary: "Needs attention" });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][0]).toMatchObject({ customType: "spider.escalation", display: true, details: { severity, summary: "Needs attention" } });
      expect(notify).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it("keeps RPC escalation notifications for clients without custom renderers", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const run = store.create({ sessionId: "owner", agent: "worker", task: "task" });
    const sendMessage = vi.fn(), notify = vi.fn();
    const cleanup = setupEscalationNotifier({ sessionId: "owner", mode: "rpc", pi: { sendMessage }, ui: { notify } }, store);
    try {
      emitEscalation(db, { sessionId: "owner", runId: run.id, severity: "warning", summary: "Needs attention" });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith("Needs attention", "warning");
    } finally { cleanup(); }
  });

  it("keeps the warning if no card delivery API is available", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const run = store.create({ sessionId: "owner", agent: "worker", task: "task" });
    const notify = vi.fn();
    const cleanup = setupEscalationNotifier({ sessionId: "owner", mode: "tui", ui: { notify } }, store);
    try {
      emitEscalation(db, { sessionId: "owner", runId: run.id, severity: "blocked", summary: "Needs attention" });
      expect(notify).toHaveBeenCalledWith("Needs attention", "error");
    } finally { cleanup(); }
  });

  it.each(["done", "failed"])("shows one interactive card for completion: %s", (status) => {
    const db = freshDb();
    const store = new RunStore(db);
    const run = store.create({ sessionId: "owner", agent: "worker", task: "task" });
    const sendMessage = vi.fn(), notify = vi.fn();
    makeAsyncNotifier({ db, mode: "tui", pi: { sendMessage }, ui: { notify } })(run, status, "Finished");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toMatchObject({ customType: "spider.subagent_done", display: true, details: { status } });
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps RPC completion notifications for clients without custom renderers", () => {
    const db = freshDb();
    const run = new RunStore(db).create({ sessionId: "owner", agent: "worker", name: "worker", task: "task" });
    const sendMessage = vi.fn(), notify = vi.fn();
    makeAsyncNotifier({ db, mode: "rpc", pi: { sendMessage }, ui: { notify } })(run, "failed", "Failed");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('subagent "worker" failed', "error");
  });
});
