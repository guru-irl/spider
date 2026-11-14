import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { createReplica } from "@spider/db-core/testutil";
import { INTERCOM_HOST_EVENT } from "@spider/intercom/protocol";
import { createHostIntercomPorts, registerRoamIntercom } from "../intercom";
import { probeIntercomProcess, type NativeProcess } from "@spider/roam/intercom-exclusion";
import { createIntercomBridge } from "@spider/roam/intercom-bridge";
import { createHostIntercomDelivery } from "@spider/roam/intercom-delivery";
import { openIntercomStore } from "@spider/roam/intercom-store";
import { join } from "node:path";

const A = "00000000-0000-4000-8000-000000000001", owner = { address: { sessionId: "own", scopeId: "scope" }, machineId: A, homeEpoch: 1, activationEpoch: "old" };
const replicas: Array<{ close(): void }> = [], children: ChildProcess[] = [];
afterEach(async () => { for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); } for (const replica of replicas.splice(0)) replica.close(); });
function context(entries: unknown[]) { return { sessionManager: { getSessionId: () => "own", getSessionFile: () => "/fixture/own.jsonl", getEntries: () => entries } } as any; }
async function start(db: any, generation: string, pid: number, probe: (pid: number) => NativeProcess, entries: unknown[] = [], root?: string) {
  const events = new EventEmitter(), handlers = new Map<string, any>();
  const pi = { on: (name: string, fn: any) => handlers.set(name, fn), events: { on: (name: string, fn: any) => { events.on(name, fn); return () => events.off(name, fn); } } };
  const gate = { inspect: () => ({ kind: "ordinary", home: { sessionId: "own", machineId: A, epoch: 1, moveId: null, updatedAt: 1 }, blockers: [] }) } as any;
  const ports = createHostIntercomPorts(gate, { db, root, pid, probe }); registerRoamIntercom(pi as any, ports);
  await handlers.get("session_start")({}, context(entries));
  const request: any = { sessionId: "own", scopeId: "scope", activationEpoch: generation }; events.emit(INTERCOM_HOST_EVENT, request);
  expect(request.endpoint).toMatchObject({ activationEpoch: generation }); return request;
}
function db() { const replica = createReplica("global", A); replicas.push(replica); return replica.db; }

it("a crashed owned process gives production-path absence proof", async () => {
  const global = db(), child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); children.push(child);
  if (!child.pid) throw new Error("fixture child did not start"); await once(child, "spawn");
  await start(global, "old", child.pid, probeIntercomProcess);
  child.kill("SIGKILL"); await once(child, "exit");
  const current = await start(global, "new", process.pid, probeIntercomProcess);
  expect(await current.reconcile("message", owner)).toMatchObject({ messageId: "message", status: "not_injected", evidence: { kind: "absence", excludedGeneration: "old", complete: true } });
}, 5000);

it("reconciles an exited owner and redelivers the same durable ID to the new generation", async () => {
  const replica = createReplica("global", A); replicas.push(replica);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); children.push(child);
  if (!child.pid) throw new Error("fixture child did not start"); await once(child, "spawn");
  await start(replica.db, "old", child.pid, probeIntercomProcess);
  const clock = { now: () => 1000, later: () => () => {} }, store = openIntercomStore({ file: join(replica.root, "roam", "intercom", "queue.db"), machineId: A, clock });
  let endpoint = owner; const delivered: string[] = [], receipts: unknown[] = [];
  const broker = { async deliver(_from: unknown, _to: unknown, message: { id: string }) { delivered.push(message.id); return { delivery: "socket_delivered", retryable: false, outcomeKnown: true, acceptance: { accepted: true, durable: false } } as const; },
    deliverReceipt(_from: unknown, _to: unknown, receipt: unknown) { receipts.push(receipt); }, deliverControl() {} };
  let bridge: ReturnType<typeof createIntercomBridge>;
  const delivery = createHostIntercomDelivery({ store, broker: broker as never, endpoint: () => endpoint, sender: () => null, wake: peer => bridge.wake(peer), now: clock.now });
  bridge = createIntercomBridge({ machineId: A, machineAlias: "local.invalid", edges: [], store, clock, transport: {} as never, localPresence: () => [], authoritativeHome: () => null,
    onReceipt: frame => delivery.onReceipt(frame) });
  try {
    await bridge.start();
    const from = { sessionId: "sender", scopeId: "scope" };
    store.acceptLocal({ from, endpoint: owner, message: { id: "same-id", timestamp: 1, content: { text: "synthetic" } } });
    await delivery.ready(owner.address, "old-ready"); expect(delivered).toEqual(["same-id"]);
    child.kill("SIGKILL"); await once(child, "exit");
    const current = await start(replica.db, "new", process.pid, probeIntercomProcess, [], replica.root);
    expect(await current.pendingOwn()).toMatchObject([{ messageId: "same-id", owner }]);
    const proof = await current.reconcile("same-id", owner); expect(proof.status).toBe("not_injected");
    bridge.receipt(owner.address, proof); endpoint = { ...owner, activationEpoch: "new" };
    await delivery.ready(owner.address, "new-ready");
    expect(delivered).toEqual(["same-id", "same-id"]);
    expect(receipts).toMatchObject([{ messageId: "same-id", status: "not_injected" }]);
  } finally { await bridge.stop(); await delivery.stop(); store.close(); }
}, 5000);

it("same-process reload and an unchanged pid identity remain unknown", async () => {
  const global = db(); await start(global, "old", process.pid, probeIntercomProcess);
  const current = await start(global, "new", process.pid, probeIntercomProcess);
  expect(await current.reconcile("message", owner)).toMatchObject({ status: "unknown" });
}, 5000);

it("pid reuse with a different native start identity excludes the old generation", async () => {
  const global = db(), fakePid = 12345;
  await start(global, "old", fakePid, () => ({ kind: "live", startIdentity: "posix:old" }));
  const current = await start(global, "new", process.pid, pid => pid === fakePid ? { kind: "live", startIdentity: "posix:new" } : { kind: "live", startIdentity: "posix:current" });
  expect(await current.reconcile("message", owner)).toMatchObject({ status: "not_injected", evidence: { excludedGeneration: "old" } });
}, 5000);
