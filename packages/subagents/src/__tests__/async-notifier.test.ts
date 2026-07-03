import { describe, it, expect, vi } from "vitest";
import { makeAsyncNotifier } from "../actions/run";
import { appendRunEvent } from "@spider/db-core";
import { freshDb } from "./helpers/testutil";

describe("makeAsyncNotifier", () => {
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
    expect(opts.deliverAs).toBe("nextTurn");
  });

  it("falls back to the result arg when the run produced no message events", () => {
    const db = freshDb();
    const sendMessage = vi.fn();
    const notify = makeAsyncNotifier({ db, pi: { sendMessage } });
    notify({ id: "none", name: "x", agent: "worker" }, "failed", "crash trace");
    expect(sendMessage.mock.calls[0][0].content).toContain("crash trace");
  });
});
