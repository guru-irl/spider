import { expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { appendRunEvent, openDbAt } from "@spider/db-core";
import { RunStore } from "../run-store";

// Break: an upward UI dependency prevents the notifier loading without the UI package.
vi.mock("@spider/ui", () => { throw Error("UI package is unavailable to subagents"); });

it("notifies completion with compaction suffixes without loading UI", async () => {
  const loaded = import("../actions/run");
  await expect(loaded).resolves.toHaveProperty("makeAsyncNotifier");
  const { makeAsyncNotifier } = await loaded;
  const path = resolve(".spider/scratch/usage-tracking-tests", `layering-${randomUUID()}.db`);
  const db = openDbAt(path, "project");
  try {
    const store = new RunStore(db);
    const run = store.create({ sessionId: "owner", agent: "worker" });
    appendRunEvent(db, { runId: run.id, sessionId: "owner", ts: 1, type: "spider_compaction", payload: { count: 2 } });
    store.finish(run.id, { status: "done", result: "fixture report" });
    const messages: any[] = [];
    makeAsyncNotifier({ db, pi: { sendMessage: (message: any) => messages.push(message) } })(store.get(run.id), "done", "fixture report");
    expect(messages[0].content.split("\n")[1]).toBe("0 tokens · $0.00 · 2 compactions");
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});
