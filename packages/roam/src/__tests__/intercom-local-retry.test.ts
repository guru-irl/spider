import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { IntercomFederationClient } from "@spider/intercom/broker/client";
import type { SessionEndpoint } from "@spider/intercom/protocol";
import { createHostIntercomDelivery, type HostIntercomDeliveryPorts } from "../intercom-delivery";
import { openIntercomStore } from "../intercom-store";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
const releases: Array<() => void> = [], deliveries: Array<{ stop(): Promise<void> }> = [], stores: Array<{ close(): void }> = [], roots: string[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const delivery of deliveries.splice(0)) await delivery.stop();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
function fixture(deliver: HostIntercomDeliveryPorts["broker"]["deliver"], options: { empty?: boolean; onStart?(): void } = {}) {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "local-retry-")); roots.push(root);
  const clock = { now: () => 1000 }, source = openIntercomStore({ file: join(root, "s.db"), machineId: A, clock }), inbox = openIntercomStore({ file: join(root, "i.db"), machineId: B, clock });
  stores.push(source, inbox);
  let endpoint: SessionEndpoint = { address: to, machineId: B, homeEpoch: null, activationEpoch: "original" }, starts = 0;
  const enqueue = (id: string) => {
    source.acceptOutbound({ from, endpoint, nextHop: B, message: { id, timestamp: 1, content: { text: "x" } } });
    inbox.acceptInbound({ peer: A, frame: source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 }).find(frame => frame.identity.id === id)! });
  };
  if (!options.empty) enqueue("local-retry");
  const errors: string[] = [], delivery = createHostIntercomDelivery({ store: inbox, broker: { deliver, deliverReceipt() {}, deliverControl() {} },
    endpoint: () => { starts++; options.onStart?.(); return endpoint; }, sender: () => null, wake() {}, now: clock.now, onError: reason => errors.push(reason) });
  deliveries.push(delivery);
  return { inbox, delivery, errors, enqueue, starts: () => starts, setEndpoint(value: SessionEndpoint) { endpoint = value; }, endpoint: () => endpoint };
}
const handedOff = { delivery: "socket_delivered", retryable: false, outcomeKnown: true, acceptance: { accepted: true, durable: false } } as const;

it("coalesces two same-transition callers into one promise and one underlying run", async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }); releases.push(() => release());
  const f = fixture(async () => { calls++; await gate; return handedOff; });
  const first = f.delivery.ready(to, "ready"), second = f.delivery.ready(to, "ready");
  expect(second).toBe(first); release(); await Promise.all([first, second]);
  expect(calls).toBe(1); expect(f.starts()).toBe(1); expect(f.errors).toEqual([]);
}, 5000);

it("coalesces concurrent later transitions and drains the latest readiness once", async () => {
  let entered!: () => void, release!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); releases.push(() => release());
  const f = fixture(async () => { calls++; entered(); await gate; return handedOff; });
  const first = f.delivery.ready(to, "first"); await started;
  const second = f.delivery.ready(to, "later"), third = f.delivery.ready(to, "later");
  expect(second).toBe(first); expect(third).toBe(first); release(); await Promise.all([first, second, third]);
  expect(calls).toBe(1); expect(f.starts()).toBe(2); expect(f.errors).toEqual([]);
}, 5000);

it.each([false, true])("retries a broker request proved never sent, activation changes=%s", async changed => {
  const client = new IntercomFederationClient(); let healthy = false, calls = 0;
  const received: string[] = [];
  const f = fixture(async (sender, endpoint, message) => {
    calls++;
    if (!healthy) {
      if (calls > 3) throw new Error("unexpected repeated attempt");
      return client.deliver(sender, endpoint, message);
    }
    received.push(message.id);
    return { ...handedOff, consumption: { messageId: message.id, status: "injected", timestamp: 1000,
      evidence: { kind: "entry", entryId: "physical", sessionId: to.sessionId, activationEpoch: endpoint.activationEpoch } } };
  });
  await f.delivery.ready(to, "disconnected");
  expect(calls).toBe(1); expect(f.inbox.retained("inbound", "local-retry")).toMatchObject({ state: "queued", payloadRetained: true });
  healthy = true;
  if (changed) f.setEndpoint({ ...f.endpoint(), activationEpoch: "replacement" });
  await f.delivery.ready(to, "connected"); await f.delivery.ready(to, "again");
  expect(calls).toBe(2); expect(received).toEqual(["local-retry"]);
  expect(f.inbox.retained("inbound", "local-retry")).toMatchObject({ state: "injected", payloadRetained: false, latestAttempt: changed ? 1 : 2 });
}, 5000);

it("never retries an unknown-send error even if its message says disconnected", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error("federation-disconnected"); });
  await f.delivery.ready(to, "first"); await f.delivery.ready(to, "later");
  expect(calls).toBe(1);
  expect(f.inbox.retained("inbound", "local-retry")).toMatchObject({ state: "unknown", payloadRetained: true, latestAttempt: 1 });
}, 5000);

it("does not requeue a different dispatch attempt or endpoint as never sent", async () => {
  const f = fixture(async () => handedOff); await f.delivery.ready(to, "ready");
  expect(() => f.inbox.retryKnownNotSent({ id: "local-retry", endpoint: f.endpoint(), attempt: 2 })).toThrow(/does not match dispatch/);
  expect(() => f.inbox.retryKnownNotSent({ id: "local-retry", endpoint: { ...f.endpoint(), activationEpoch: "other" }, attempt: 1 })).toThrow(/does not match dispatch/);
  expect(f.inbox.retained("inbound", "local-retry")).toMatchObject({ state: "unknown", latestAttempt: 1 });
}, 5000);

it("reruns when inbound mail arrives as an empty drain is completing", async () => {
  const received: string[] = []; let scheduled = false;
  const f = fixture(async (_sender, _endpoint, message) => { received.push(message.id); return handedOff; }, {
    empty: true, onStart() {
      if (!scheduled) { scheduled = true; queueMicrotask(() => { f.enqueue("arrived"); f.delivery.onInbound({ id: "arrived", to }); }); }
    },
  });
  await f.delivery.ready(to, "ready");
  expect(received).toEqual(["arrived"]); expect(f.errors).toEqual([]);
}, 5000);
