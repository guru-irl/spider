import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, paths } from "@spider/db-core";
import { makeMessageFrame } from "../intercom-codec";
import { INTERCOM_PAYLOAD_MS } from "../intercom-contracts";
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
  const db = openDb(file); db.exec("DROP TABLE intercom_endpoint_aliases; DROP TABLE intercom_notices; DROP TABLE intercom_rejections; DROP TABLE intercom_presence_claims; UPDATE intercom_messages SET from_key=json_extract(from_key,'$[1]'); UPDATE intercom_cursors SET from_key=json_extract(from_key,'$[1]'); UPDATE intercom_resumptions SET from_key=json_extract(from_key,'$[1]'); DROP TABLE intercom_topology_audit; DROP TABLE intercom_topology_refusals; DROP TABLE intercom_topology; DROP TABLE intercom_revocation_notices; DROP TABLE intercom_pair_approvals; DROP TABLE intercom_pair_fences; DROP TABLE intercom_edge_state; UPDATE intercom_meta SET version=1 WHERE id=1;"); db.close();
  store = openIntercomStore({ file, machineId: A, clock });
  try {
    expect(store.retained("outbound", "before")).toMatchObject({ payloadRetained: true, identity: { sequence: 1 } });
    const next = store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "after", timestamp: 2, content: { text: "synthetic" } } });
    expect(next).toMatchObject({ kind: "accepted", identity: { sequence: 2 } });
    expect(store.edgeState(B, "edge-1")).toMatchObject({ inbound: { poll: 0, push: 0 }, outbound: { poll: 0, push: 0 } });
  } finally { store.close(); }
  const verify = openDb(file); try { expect(verify.prepare("SELECT version FROM intercom_meta WHERE id=1").get()).toEqual({ version: 5 }); } finally { verify.close(); }
}, 5000);

it("migrates a version-2 queue while preserving existing edge state", () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "migration-v2-")); roots.push(root);
  const file = join(root, "queue", "queue.db");
  let store = openIntercomStore({ file, machineId: A, clock });
  store.updateEdgeState(B, "edge-1", old => ({ ...old, outbound: { ...old.outbound, push: 7 } }));
  store.close();
  const db = openDb(file); db.exec("DROP TABLE intercom_endpoint_aliases; DROP TABLE intercom_notices; DROP TABLE intercom_rejections; DROP TABLE intercom_presence_claims; UPDATE intercom_messages SET from_key=json_extract(from_key,'$[1]'); UPDATE intercom_cursors SET from_key=json_extract(from_key,'$[1]'); UPDATE intercom_resumptions SET from_key=json_extract(from_key,'$[1]'); DROP TABLE intercom_topology_audit; DROP TABLE intercom_topology_refusals; DROP TABLE intercom_topology; DROP TABLE intercom_revocation_notices; DROP TABLE intercom_pair_approvals; DROP TABLE intercom_pair_fences; UPDATE intercom_meta SET version=2 WHERE id=1;"); db.close();
  store = openIntercomStore({ file, machineId: A, clock });
  try { expect(store.edgeState(B, "edge-1").outbound.push).toBe(7); expect(store.pairFence(B)).toBeNull(); }
  finally { store.close(); }
}, 5000);

it("reconstructs every origin's cursor when a shared-counter queue is upgraded", () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "migration-origins-")); roots.push(root);
  const file = join(root, "queue.db"), C = "00000000-0000-4000-8000-000000000003";
  let time = 1000, store = openIntercomStore({ file, machineId: A, clock: { now: () => time } });
  const localEndpoint = { ...endpoint, machineId: A };
  const inbound = (id: string, sequence: number) => makeMessageFrame({ from, endpoint: localEndpoint, originMachineId: C, sequence,
    message: { id, timestamp: 1, content: { text: "x" } } });
  const first = inbound("retired", 1); store.acceptInbound({ peer: C, frame: first }); store.beginDispatch({ id: "retired", endpoint: localEndpoint, readiness: "ready" });
  store.settleReceipt({ queue: "inbound", peer: C, frame: { from: localEndpoint, to: from, digest: first.identity.digest, attempt: 1,
    receipt: { messageId: "retired", status: "injected", timestamp: 1000, evidence: { kind: "entry", entryId: "physical", sessionId: to.sessionId, activationEpoch: localEndpoint.activationEpoch } } } });
  for (const receipt of store.pending({ kind: "receipts", peer: C })) store.acknowledgeReceipt({ peer: C, frame: receipt });
  time += 2 * INTERCOM_PAYLOAD_MS + 1; store.expire();
  store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "local-before", timestamp: 1, content: { text: "x" } } });
  store.acceptInbound({ peer: C, frame: inbound("remote-before", 2) }); store.close();
  const db = openDb(file);
  db.exec("DROP TABLE intercom_endpoint_aliases; DROP TABLE intercom_notices; DROP TABLE intercom_rejections; DROP TABLE intercom_presence_claims; UPDATE intercom_meta SET version=4;");
  const cursors = db.prepare("SELECT direction,json_extract(from_key,'$[1]') AS from_key,to_key,max(sequence) AS sequence FROM intercom_cursors GROUP BY direction,json_extract(from_key,'$[1]'),to_key").all() as { direction: string; from_key: string; to_key: string; sequence: number }[];
  db.exec("DELETE FROM intercom_cursors; UPDATE intercom_messages SET from_key=json_extract(from_key,'$[1]');");
  for (const row of cursors) db.prepare("INSERT INTO intercom_cursors(direction,from_key,to_key,sequence) VALUES(?,?,?,?)").run(row.direction,row.from_key,row.to_key,row.sequence);
  db.close(); store = openIntercomStore({ file, machineId: A, clock: { now: () => time } });
  try {
    expect(store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "local-after", timestamp: 1, content: { text: "x" } } })).toMatchObject({ kind: "accepted", identity: { sequence: 2 } });
    expect(store.acceptInbound({ peer: C, frame: inbound("remote-after", 3) })).toMatchObject({ kind: "accepted", identity: { sequence: 3 } });
    expect(store.retained("outbound", "local-before")).toMatchObject({ originMachineId: A, payloadRetained: true });
    expect(store.retained("inbound", "remote-before")).toMatchObject({ originMachineId: C, payloadRetained: true });
  } finally { store.close(); }
}, 5000);
