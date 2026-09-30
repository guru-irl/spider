import { describe, it, expect, vi } from "vitest";
import { makeAsyncNotifier } from "../actions/run";
import { appendRunEvent } from "@spider/db-core";
import { freshDb } from "./helpers/testutil";

describe("makeAsyncNotifier", () => {
  it("still queues shutdown when the optional diagnostic DB is already closed", () => {
    const db = freshDb(); db.close();
    const sendMessage = vi.fn();
    makeAsyncNotifier({ db, pi: { sendMessage } })({ id: "closed", agent: "worker" }, "cancelled", "Session shutdown cancelled this run.");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0].details.output).toBe("Session shutdown cancelled this run.");
    expect(sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
  });

  it("sends the child's real final output to the parent on completion", () => {
    const db = freshDb();
    appendRunEvent(db, { runId: "r1", sessionId: "s", ts: 1, type: "message", summary: "early" });
    appendRunEvent(db, { runId: "r1", sessionId: "s", ts: 2, type: "message", summary: "FINAL OUTPUT: 3 TODOs" });
    const sendMessage = vi.fn();
    const notify = makeAsyncNotifier({ db, pi: { sendMessage }, ui: { notify: () => {} } });
    notify({ id: "r1", name: "todo-hunt", agent: "worker" }, "done");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendMessage.mock.calls[0];
    expect(msg.customType).toBe("spider.subagent_done");
    expect(msg.content).toContain("FINAL OUTPUT: 3 TODOs");
    expect(msg.details.output).toBe("FINAL OUTPUT: 3 TODOs");
    // Wake the idle main agent to respond NOW (matches pi's file-trigger pattern). A passive
    // deliverAs:"nextTurn" would only surface on the user's next message — that was the bug.
    expect(opts.triggerTurn).toBe(true);
    expect(opts.deliverAs).toBeUndefined();
  });

  it("falls back to the result arg when the run produced no message events", () => {
    const db = freshDb();
    const sendMessage = vi.fn();
    const notify = makeAsyncNotifier({ db, pi: { sendMessage } });
    notify({ id: "none", name: "x", agent: "worker" }, "failed", "crash trace");
    expect(sendMessage.mock.calls[0][0].content).toContain("crash trace");
  });

  it("notifies a cancelled run with its real cause", () => {
    const sendMessage = vi.fn();
    const notify = vi.fn();
    const ctx: any = { db: freshDb(), pi: { sendMessage }, ui: { notify } };
    const notifier = makeAsyncNotifier(ctx);
    notifier({ id: "r1", name: "alpha", agent: "worker" } as any, "cancelled", "Session shutdown cancelled this run.");
    expect(sendMessage.mock.calls[0][0].details).toMatchObject({ status: "cancelled", output: "Session shutdown cancelled this run." });
    expect(notify).toHaveBeenCalled();
  });

  it("still notifies for a failed run", () => {
    const sendMessage = vi.fn();
    const notify = vi.fn();
    const ctx: any = { db: freshDb(), pi: { sendMessage }, ui: { notify } };
    const notifier = makeAsyncNotifier(ctx);
    notifier({ id: "r2", name: "beta", agent: "worker" } as any, "failed", undefined);
    expect(sendMessage).toHaveBeenCalled();
  });
});
