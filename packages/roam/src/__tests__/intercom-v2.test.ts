import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createIntercomBridge } from "../intercom-bridge";
import { decodeExchange, encodeFrame } from "../intercom-codec";
import { openIntercomStore } from "../intercom-store";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
const endpoint = { address: to, machineId: B, homeEpoch: null, activationEpoch: "recipient-1" };
const peer = { machineId: A, alias: "peer.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/global" };
const roots: string[] = [], resources: Array<{ stop(): Promise<void> }> = [], stores: Array<{ close(): void }> = [];
afterEach(async () => { for (const resource of resources.splice(0)) await resource.stop(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
async function fixture() {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "v2-")); roots.push(root);
  const clock = { now: () => 1_000_000, later: () => () => {} }, source = openIntercomStore({ file: join(root, "source.db"), machineId: A, clock });
  const inbox = openIntercomStore({ file: join(root, "inbox.db"), machineId: B, clock }); stores.push(source, inbox);
  const bridge = createIntercomBridge({ machineId: B, machineAlias: "local.invalid", edges: [{ peer, edgeEpoch: "edge", initiator: false }], store: inbox, clock,
    transport: { resolve: async () => { throw new Error("offline"); }, exec: async () => { throw new Error("offline"); } } as never,
    localPresence: () => [], authoritativeHome: address => address.sessionId === from.sessionId ? { sessionId: from.sessionId, machineId: A, epoch: 1, moveId: null, updatedAt: 1 } : null }); resources.push(bridge); await bridge.start();
  return { source, inbox, bridge };
}
function request(protocol: number, frames: unknown[] = []) {
  return { version: 1, holdMs: 0, deadlineMs: 5000, exchange: { protocol, senderMachine: A, recipientMachine: B,
    generation: { edgeEpoch: "edge", channel: "push", generation: 1 }, frames, acknowledgements: [], receipts: [], controls: [], presence: [] } };
}

it("requires origin in each encoded federation message frame", async () => {
  const { source } = await fixture();
  source.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "one", timestamp: 1, content: { text: "synthetic" } } });
  const frame = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0], { originMachineId: _origin, ...missing } = frame;
  expect(frame.originMachineId).toBe(A);
  expect(() => encodeFrame(missing as never)).toThrow(/origin/i);
}, 5000);

it("refuses an older or different federation version with a named mismatch", async () => {
  const { bridge, inbox } = await fixture();
  for (const version of [1, 2, 3, 5]) {
    await expect(bridge.exchange(request(version))).rejects.toMatchObject({ code: "peer-version-mismatch" });
    expect(() => decodeExchange(Buffer.from(JSON.stringify(request(version).exchange)))).toThrow(/peer-version-mismatch/);
  }
  expect(inbox.edgeState(A, "edge").inbound.push).toBe(0);
}, 5000);

it("keeps messages queued across a version mismatch and sends them after a matching handshake", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "v2-handshake-")); roots.push(root);
  const timers: Array<{ ms: number; fn(): void; cancelled: boolean }> = [];
  const clock = { now: () => 1_000_000, later: (ms: number, fn: () => void) => { const timer = { ms, fn, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; } };
  const store = openIntercomStore({ file: join(root, "queue.db"), machineId: A, clock }); stores.push(store);
  const target = { ...peer, machineId: B, alias: "remote.invalid" }, calls: any[] = [];
  let firstDone!: () => void, delivered!: () => void; const first = new Promise<void>(done => { firstDone = done; }), done = new Promise<void>(resolveDone => { delivered = resolveDone; });
  const transport = { resolve: async (target: typeof peer, options: { timeoutMs: number; signal: AbortSignal }) => {
    if (options.timeoutMs > 20_000) return new Promise<never>((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("poll stopped")), { once: true });
    });
    return target;
  }, exec: async (_target: unknown, _argv: unknown, options: { stdinForTimeout(ms: number): Buffer }) => {
    const input = JSON.parse(options.stdinForTimeout(5000).toString()); calls.push(input.exchange);
    if (calls.length === 1) { firstDone(); return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: false, reason: "peer-version-mismatch" })); }
    if (input.exchange.frames.some((frame: any) => frame.identity.id === "queued")) delivered();
    return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true, value: { version: 1, exchange: { ...input.exchange,
      senderMachine: B, recipientMachine: A, frames: [], acknowledgements: input.exchange.frames.map((frame: any) => ({ identity: frame.identity, kind: frame.kind })), receipts: [], controls: [], presence: [] } } }));
  } };
  const bridge = createIntercomBridge({ machineId: A, machineAlias: "source.invalid", edges: [{ peer: target, edgeEpoch: "edge", initiator: true }],
    store, clock, transport: transport as never, localPresence: () => [], authoritativeHome: () => null }); resources.push(bridge);
  store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "queued", timestamp: 1, content: { text: "synthetic" } } });
  await bridge.start(); bridge.wake(B); await first;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(calls[0].protocol).toBe(4); expect(calls[0].frames).toEqual([]);
  expect(store.retained("outbound", "queued")).toMatchObject({ state: "queued", payloadRetained: true, linkAcknowledged: false });
  expect(bridge.diagnostics()).toEqual([expect.objectContaining({ peer: B, reason: "peer-version-mismatch" })]);
  const retry = timers.find(timer => timer.ms === 1000 && !timer.cancelled); expect(retry).toBeDefined(); retry!.fn();
  await done;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(calls[1].frames).toEqual([]);
  expect(calls.at(-1).frames).toMatchObject([{ originMachineId: A, identity: { id: "queued" } }]);
  expect(bridge.diagnostics()).toEqual([]);
  expect(store.retained("outbound", "queued")?.linkAcknowledged).toBe(true);
}, 5000);

it("records and rejects one origin-less frame while later pair messages advance", async () => {
  const { source, inbox, bridge } = await fixture();
  for (const id of ["bad", "good"]) source.acceptOutbound({ from, endpoint, nextHop: B, message: { id, timestamp: 1, content: { text: id === "bad" ? "private-rejected-body" : "synthetic" } } });
  const [first, second] = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 });
  const { originMachineId: _origin, ...missing } = first;
  const responsePromise = bridge.exchange(request(4, [missing, second]));
  await expect(responsePromise).resolves.toBeDefined();
  const outcome = await responsePromise;
  expect(outcome.exchange.refusals).toMatchObject([{ identity: { id: "bad" }, reason: "missing-origin" }]);
  expect(outcome.exchange.acknowledgements).toMatchObject([{ identity: { id: "good" }, kind: "message" }]);
  expect(inbox.retained("inbound", "bad")).toMatchObject({ state: "cancelled", failureReason: "missing-origin", payloadRetained: false });
  expect(inbox.pending({ kind: "inbound", address: to }).map(value => value.id)).toEqual(["good"]);
  const retry = request(4, [first]); retry.exchange.generation.generation = 2;
  const again = await bridge.exchange(retry);
  expect(again.exchange.acknowledgements).toEqual([]);
  expect(again.exchange.refusals).toMatchObject([{ identity: { id: "bad" }, reason: "missing-origin" }]);
  const events: unknown[] = [], clock = { now: () => 1_000_000, later: () => () => {} }, target = { ...peer, machineId: B };
  const sender = createIntercomBridge({ machineId: A, machineAlias: "source.invalid", edges: [{ peer: target, edgeEpoch: "edge", initiator: false }],
    store: source, clock, transport: { resolve: async () => { throw new Error("offline"); }, exec: async () => { throw new Error("offline"); } } as never,
    localPresence: () => [], authoritativeHome: () => null, onReceipt: frame => events.push(frame) });
  resources.push(sender); await sender.start();
  const response = request(4); response.exchange.senderMachine = B; response.exchange.recipientMachine = A;
  Object.assign(response.exchange, { refusals: outcome.exchange.refusals, acknowledgements: outcome.exchange.acknowledgements });
  await sender.exchange(response);
  expect(source.retained("outbound", "bad")).toMatchObject({ state: "cancelled", failureReason: "missing-origin" });
  expect(source.retained("outbound", "good")?.linkAcknowledged).toBe(true);
  expect(events).toMatchObject([{ receipt: { messageId: "bad", detail: "missing-origin" } }]);
  source.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "later", timestamp: 1, content: { text: "synthetic" } } });
  expect(source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 }).map(frame => frame.identity.id)).toContain("later");
}, 5000);
