import { expect, it } from "vitest";
import { createIntercomDeliveryObserver, receiptReleasesPayload, type MessageReceipt } from "./protocol.js";

function fixture() {
  const entries: unknown[] = [], receipts: unknown[] = [];
  const observer = createIntercomDeliveryObserver({ sessionId: "own", generation: "activation-1", entries: () => entries, receipt: value => receipts.push(value), now: () => 100 });
  return { entries, receipts, observer };
}
const entry = (id: string, generation = "activation-1") => ({ type: "custom_message", customType: "intercom_message", id: "physical-entry", details: { message: { id }, intercom: { sessionId: "own", activationEpoch: generation } } });

it("only physical entry, durable waiter or visible expiry releases payload", () => {
  const base = { messageId: "mail", timestamp: 100 };
  for (const status of ["receiver_received", "queued", "acknowledged", "cancelled", "unknown"] as const) expect(receiptReleasesPayload({ ...base, status })).toBe(false);
  expect(receiptReleasesPayload({ ...base, status: "injected" })).toBe(false);
  expect(receiptReleasesPayload({ ...base, status: "not_injected", evidence: { kind: "absence", sessionId: "own", activationEpoch: "old", excludedGeneration: "old", complete: true } })).toBe(false);
  expect(receiptReleasesPayload({ ...base, status: "injected", evidence: { kind: "entry", sessionId: "own", activationEpoch: "old", entryId: "physical" } })).toBe(true);
  expect(receiptReleasesPayload({ ...base, status: "matched_waiter", evidence: { kind: "waiter", sessionId: "own", activationEpoch: "old", entryId: "physical", askId: "ask" } })).toBe(true);
  expect(receiptReleasesPayload({ ...base, status: "expired" })).toBe(true);
  expect(receiptReleasesPayload({ ...base, status: "injected", evidence: { kind: "absence", sessionId: "own", activationEpoch: "old", excludedGeneration: "old", complete: true } } as MessageReceipt)).toBe(false);
}, 5000);

it("sendMessage return and queue removal are not injection", () => {
  const f = fixture(); f.observer.register("mail"); f.observer.accept("mail"); f.observer.observeEntries();
  expect(f.receipts).toEqual([]);
  f.entries.push({ ...entry("mail"), type: "custom" }); f.observer.observeEntries();
  expect(f.receipts).toEqual([]);
  f.entries.push(entry("mail")); f.observer.observeEntries(); f.observer.observeEntries();
  expect(f.receipts).toEqual([{ messageId: "mail", status: "injected", timestamp: 100, evidence: { kind: "entry", entryId: "physical-entry", sessionId: "own", activationEpoch: "activation-1" } }]);
}, 5000);

it("busy headless refusal emits not_injected", () => {
  const f = fixture(); f.observer.register("mail"); f.observer.refuse("mail");
  expect(f.receipts).toEqual([expect.objectContaining({ messageId: "mail", status: "not_injected" })]);
  expect(f.observer.register("mail")).toBe(true);
}, 5000);

it("acknowledgement before teardown is not consumption", () => {
  const f = fixture(); f.observer.register("mail"); f.observer.accept("mail"); f.observer.settle();
  expect(f.receipts).toEqual([expect.objectContaining({ status: "unknown" })]);
  expect(f.observer.register("mail")).toBe(false);
}, 5000);

it("busy steer reload before drain keeps payload for same-id redelivery", () => {
  const f = fixture(); f.observer.register("mail"); f.observer.accept("mail");
  f.observer.settle({ excludedGeneration: "activation-1", complete: true });
  expect(f.receipts).toEqual([expect.objectContaining({ status: "not_injected" })]);
  expect(f.observer.register("mail")).toBe(true);
  expect(f.observer.register("mail")).toBe(false);
  f.entries.push(entry("mail")); f.observer.observeEntries();
  expect(f.receipts.filter((r: any) => r.status === "injected")).toHaveLength(1);
}, 5000);

it("unavailable own-entry scan stays unknown despite generation exclusion", () => {
  const receipts: unknown[] = [];
  const observer = createIntercomDeliveryObserver({ sessionId: "own", generation: "activation-1", entries: () => { throw new Error("entries unavailable"); }, receipt: value => receipts.push(value), now: () => 100 });
  observer.register("mail"); observer.accept("mail");
  expect(() => observer.settle({ excludedGeneration: "activation-1", complete: true })).not.toThrow();
  expect(receipts).toEqual([expect.objectContaining({ status: "unknown" })]);
  expect(observer.register("mail")).toBe(false);
}, 5000);

it("abort before entry emits not_injected", () => {
  const f = fixture(); f.observer.register("mail");
  f.entries.push(entry("mail", "stale"));
  f.observer.settle({ excludedGeneration: "activation-1", complete: true });
  expect(f.receipts).toEqual([expect.objectContaining({ status: "not_injected" })]);
}, 5000);

it("only complete physical own-session entries confirm delivery", () => {
  const f = fixture(); f.observer.register("mail");
  f.entries.push({ ...entry("mail"), details: { message: { id: "mail" }, intercom: { sessionId: "foreign", activationEpoch: "activation-1" } } });
  f.observer.observeEntries(); expect(f.receipts).toEqual([]);
  f.entries.push(entry("mail")); f.observer.observeEntries(); f.observer.settle();
  expect(f.receipts).toHaveLength(1);
  expect(f.receipts[0]).toMatchObject({ status: "injected" });
}, 5000);
