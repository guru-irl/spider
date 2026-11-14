import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, paths } from "@spider/db-core";
import { openIntercomStore } from "../intercom-store";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "receiver", scopeId: "scope" };
const endpoint = { address: to, machineId: B, homeEpoch: 1, activationEpoch: "activation" };
const clock = { now: () => 1000 };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("migrates a version-1 queue without losing payload or pair ordering", () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "migration-")); roots.push(root);
  const file = join(root, "queue", "queue.db");
  let store = openIntercomStore({ file, machineId: A, clock });
  store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "before", timestamp: 1, content: { text: "synthetic" } } });
  store.close();
  const db = openDb(file); db.exec("DROP TABLE intercom_edge_state; UPDATE intercom_meta SET version=1 WHERE id=1;"); db.close();
  store = openIntercomStore({ file, machineId: A, clock });
  try {
    expect(store.retained("outbound", "before")).toMatchObject({ payloadRetained: true, identity: { sequence: 1 } });
    const next = store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "after", timestamp: 2, content: { text: "synthetic" } } });
    expect(next).toMatchObject({ kind: "accepted", identity: { sequence: 2 } });
    expect(store.edgeState(B, "edge-1")).toMatchObject({ inbound: { poll: 0, push: 0 }, outbound: { poll: 0, push: 0 } });
  } finally { store.close(); }
  const verify = openDb(file); try { expect(verify.prepare("SELECT version FROM intercom_meta WHERE id=1").get()).toEqual({ version: 2 }); } finally { verify.close(); }
});
