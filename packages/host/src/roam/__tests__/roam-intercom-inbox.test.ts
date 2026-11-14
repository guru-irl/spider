import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openIntercomStore } from "@spider/roam/intercom-store";
import { createHostIntercomDelivery } from "../intercom";
const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const from = { sessionId: "sender", scopeId: null }, to = { sessionId: "recipient", scopeId: null };
const endpoint = { address: to, machineId: B, homeEpoch: 1, activationEpoch: "recipient-generation" };
const sender = { remote: true as const, id: "sender", address: from, machineId: A, machineAlias: "box-1.invalid", homeEpoch: null, activationEpoch: "sender-generation", endpointEpoch: "sender-generation", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const scratch = resolve(".spider/scratch/3.6d"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "inbox-")); cleanups.push(() => rmSync(root, { force: true, recursive: true }));
  const source = openIntercomStore({ file: join(root, "source", "queue.db"), machineId: A, clock: { now: Date.now } });
  const store = openIntercomStore({ file: join(root, "inbox", "queue.db"), machineId: B, clock: { now: Date.now } });
  cleanups.push(() => source.close(), () => store.close());
  source.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "mail", timestamp: 1, content: { text: "synthetic", attachments: [{ type: "snippet", name: "sample", content: "synthetic attachment" }] } } });
  const frame = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 1 })[0]; store.acceptInbound({ peer: A, frame });
  const delivered: any[] = [], receipts: any[] = [], failures: string[] = [];
  const delivery = createHostIntercomDelivery({ store, endpoint: () => endpoint, sender: () => sender, wake() {}, now: Date.now,
    broker: { deliver: async (...args: any[]) => { delivered.push(args); return { delivery: "socket_delivered" as const, retryable: false, outcomeKnown: true, acceptance: { accepted: true as const, durable: false as const } }; }, deliverReceipt: (...args: any[]) => receipts.push(args), deliverControl() {} }, onError: (reason: string) => failures.push(reason) });
  return { store, delivery, delivered, receipts, failures, frame };
}
it("bridge socket acceptance never deletes the durable inbox payload", async () => {
  const f = fixture(); await f.delivery.ready(to, "ready-1");
  expect(f.delivered).toHaveLength(1); expect(f.delivered[0][2]).toMatchObject({ id: "mail", content: { attachments: [{ content: "synthetic attachment" }] } });
  expect(f.store.retained("inbound", "mail")).toMatchObject({ state: "unknown", payloadRetained: true, latestAttempt: 1 });
  await f.delivery.ready(to, "ready-1"); expect(f.delivered).toHaveLength(1);
}, 5000);
it("proved non-injection clears its blocker and retries only on new readiness", async () => {
  const f = fixture(); await f.delivery.ready(to, "ready-1");
  await f.delivery.reconcile([{ owner: endpoint, receipt: { messageId: "mail", status: "not_injected", timestamp: 2, evidence: { kind: "absence", sessionId: to.sessionId, activationEpoch: endpoint.activationEpoch, excludedGeneration: endpoint.activationEpoch, complete: true } } }]);
  expect(f.store.inspectBlockers(to).unknownOutcomes).toEqual([]);
  await f.delivery.ready(to, "ready-1"); expect(f.delivered).toHaveLength(1);
  await f.delivery.ready(to, "ready-2"); expect(f.delivered).toHaveLength(2); expect(f.delivered.map(args => args[2].id)).toEqual(["mail", "mail"]);
}, 5000);
it("only observed own-entry reconciliation releases the payload", async () => {
  const f = fixture(); await f.delivery.ready(to, "ready");
  await f.delivery.reconcile([{ owner: endpoint, receipt: { messageId: "mail", status: "injected", timestamp: 2, evidence: { kind: "entry", entryId: "physical", sessionId: to.sessionId, activationEpoch: endpoint.activationEpoch } } }]);
  expect(f.store.retained("inbound", "mail")).toMatchObject({ state: "injected", payloadRetained: false });
  expect(f.failures).toEqual([]);
}, 5000);

it("an entry receipt for a late reply tells its replier the asker no longer waits", async () => {
  const f = fixture(), destination = { address: from, machineId: A, homeEpoch: null, activationEpoch: "sender-generation" };
  const accepted = f.store.acceptOutbound({ from: to, endpoint: destination, nextHop: A, message: { id: "late-reply", replyTo: "old-ask", timestamp: 1, content: { text: "synthetic reply" } } });
  if (accepted.kind === "refused") throw new Error("fixture acceptance refused");
  f.delivery.onReceipt({ attempt: 1, from: destination, to, digest: accepted.identity.digest, receipt: { messageId: "late-reply", status: "injected", timestamp: 2, evidence: { kind: "entry", entryId: "late-entry", sessionId: from.sessionId, activationEpoch: destination.activationEpoch } } });
  expect(f.receipts[0]?.[2]).toMatchObject({ messageId: "late-reply", detail: "asker-no-longer-waiting" });
}, 5000);

it("at-least-once failure and expiry callbacks have one effect per message", () => {
  const f = fixture(), event = { id: "mail", from: to, to: from };
  f.delivery.onAskFailed({ ...event, reason: "link-down" }); f.delivery.onAskFailed({ ...event, reason: "link-down" });
  f.delivery.onExpiry(event); f.delivery.onExpiry(event);
  expect(f.receipts.map(args => args[2].status)).toEqual(["unknown", "expired"]);
}, 5000);
