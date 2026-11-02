import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import * as coordinators from "../coordinators";
import { resetSharedRegistryForTests } from "../child-registry";
import { Runner, type ChildHandle } from "../runner";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";
import { subscribeLiveRunEvents } from "../live-events";

let root: string; let db: Db; let tailer: RunEventTailer;
beforeEach(() => {
  const scratch = resolve(".spider/scratch/live-events/fixtures"); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "live-")); db = openDbAt(join(root, "project.db"), "project"); tailer = new RunEventTailer(db);
});
afterEach(() => { coordinators.teardownAll(); resetSharedRegistryForTests(); tailer.stop(); db.close(); rmSync(root, { recursive: true, force: true }); });

it("an RPC child's live events reach in-process previews of that run only, and are not persisted", () => {
  let rpcEvent!: (event: Record<string, unknown>) => void;
  const handle: ChildHandle = { wait: () => new Promise(() => {}), kill() {}, detach() {} };
  const runner = new Runner(db, "parent", root, { store: new RunStore(db), tailer, dbPath: join(root, "project.db"), scratchRoot: root,
    spawn: spec => { rpcEvent = spec.onRpcEvent!; return handle; } });
  const run = runner.runAsync({ agent: "worker", task: "fixture task", context: "fresh" });
  const seen: string[] = []; const other: string[] = [];
  const off = subscribeLiveRunEvents(run.id, event => seen.push(event.type));
  const offOther = subscribeLiveRunEvents("another-run", event => other.push(event.type));
  const before = (db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id=?").get(run.id) as { n: number }).n;
  rpcEvent({ type: "message_update", message: { role: "assistant", content: [] } });
  rpcEvent({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: {} });
  rpcEvent({ type: "queue_update", steering: [] });
  off(); offOther();
  expect(seen).toEqual(["message_update", "tool_execution_start"]);
  expect(other).toEqual([]);
  expect((db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id=? AND type IN ('message_update','tool_execution_start')").get(run.id) as { n: number }).n).toBe(0);
  expect((db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id=?").get(run.id) as { n: number }).n).toBeGreaterThanOrEqual(before);
});
