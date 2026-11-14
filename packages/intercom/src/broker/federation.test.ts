import { expect, it, vi } from "vitest";
import { createFederation } from "./federation.js";
import { FEDERATION_FEATURE, type FederationBridge, type RemoteSessionInfo, type SessionAddress } from "../protocol.js";

const address: SessionAddress = { sessionId: "sender", scopeId: null };
const remote: RemoteSessionInfo = { remote: true, id: "recipient", address: { sessionId: "recipient", scopeId: null }, machineId: "machine-2", machineAlias: "box-1.invalid", homeEpoch: 2, activationEpoch: "activation-2", endpointEpoch: "activation-2", name: "helper", cwd: "/workspace", model: "fixture", startedAt: 1, lastActivity: 1 };
function fixture() {
  const dispatch = vi.fn<FederationBridge["dispatch"]>().mockResolvedValue({ delivery: "queued", retryable: false, outcomeKnown: true, acceptance: { accepted: true, durable: true, location: "source" } });
  const bridge: FederationBridge = { dispatch, receipt: vi.fn(), control: vi.fn() };
  const federation = createFederation({ agentDir: "/fixture/agent", locals: () => [address], now: () => 100 });
  const registration = { feature: FEDERATION_FEATURE, agentDir: "/fixture/agent", machineId: "machine-1", machineAlias: "local.invalid" };
  federation.registerBridge(registration, bridge);
  return { federation, bridge, dispatch, registration };
}

it("one privileged bridge registers", () => {
  const f = fixture();
  expect(() => f.federation.registerBridge(f.registration, f.bridge)).toThrow(/bridge-already-registered/);
  const other = createFederation({ agentDir: "/fixture/agent", locals: () => [], now: () => 100 });
  expect(() => other.registerBridge({ ...f.registration, agentDir: "/wrong/agent" }, f.bridge)).toThrow(/agent-directory/);
  expect(() => other.registerBridge({ ...f.registration, feature: "legacy" }, f.bridge)).toThrow(/feature/);
}, 5000);

it("old bridge teardown cannot detach its replacement or erase route evidence", () => {
  const federation = createFederation({ agentDir: "/fixture/agent", locals: () => [], now: () => 100 });
  const f = fixture();
  const release = federation.registerBridge(f.registration, f.bridge);
  federation.publishPresence([remote]); release();
  expect(federation.roster(null)).toEqual([expect.objectContaining({ id: "recipient", stale: true, reachability: "unknown" })]);
  const replacement = federation.registerBridge(f.registration, f.bridge); release();
  expect(federation.connected()).toBe(true); replacement();
}, 5000);

it("remote identities cannot shadow local sessions", () => {
  const f = fixture();
  expect(() => f.federation.publishPresence([{ ...remote, id: "sender", address }])).toThrow(/shadow/);
  expect(() => f.federation.publishPresence([{ ...remote, pid: 123 } as unknown as RemoteSessionInfo])).toThrow(/local-handle/);
  expect(() => f.federation.publishPresence([{ ...remote, terminalId: "untrusted" } as unknown as RemoteSessionInfo])).toThrow(/presence|handle/);
  expect(f.federation.roster(null)).toEqual([]);
}, 5000);

it("all send producers route through federation", async () => {
  const f = fixture(); f.federation.publishPresence([remote]);
  for (const id of ["tool", "relay", "outbox"]) {
    const result = await f.federation.dispatch(address, remote, { id, timestamp: 1, content: { text: "synthetic", attachments: [{ type: "snippet", name: "sample", content: "attachment" }] } });
    expect(result).toMatchObject({ delivery: "queued", acceptance: { accepted: true, durable: true } });
  }
  expect(f.dispatch.mock.calls.map(([frame]) => frame.from)).toEqual([address, address, address]);
  expect(f.dispatch.mock.calls[0]![0].message.content.attachments).toHaveLength(1);
}, 5000);

it("broker blocker inspection never reads durable bridge state", () => {
  const f = fixture();
  Object.assign(f.bridge, { inspectBlockers: () => { throw new Error("external state must be queried separately"); } });
  expect(f.federation.inspectBlockers(address)).toEqual({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] });
}, 5000);

it("remote mail never enters broker memory queues", async () => {
  const f = fixture(); f.federation.publishPresence([remote]);
  await f.federation.dispatch(address, remote, { id: "mail", timestamp: 1, content: { text: "synthetic" } });
  expect(f.federation.inspectBlockers(address)).toEqual({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: ["mail"] });
  f.federation.receipt(remote.address, { messageId: "mail", status: "acknowledged", timestamp: 2 });
  expect(f.federation.inspectBlockers(address).unobservedReceipts).toEqual(["mail"]);
  f.federation.receipt(remote.address, { messageId: "mail", status: "injected", timestamp: 3, evidence: { kind: "entry", entryId: "entry", sessionId: "recipient", activationEpoch: "activation-2" } });
  expect(f.federation.inspectBlockers(address).unobservedReceipts).toEqual([]);
}, 5000);

it("ambiguous names send nothing", () => {
  const f = fixture(); f.federation.publishPresence([remote, { ...remote, id: "other", address: { ...remote.address, sessionId: "other" } }]);
  expect(() => f.federation.resolve("helper", null, [])).toThrow(/ambiguous/);
  expect(() => f.federation.resolve("box-1.invalid/helper", null, [])).toThrow(/ambiguous/);
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.federation.resolve("recipient", null, [])).toEqual(remote);
  expect(f.federation.roster("other-scope")).toEqual([]);
}, 5000);

it("one outbound ask and mutual waiting are fenced in both directions", async () => {
  const f = fixture(); f.federation.publishPresence([remote]);
  await f.federation.dispatch(address, structuredClone(remote), { id: "ask", expectsReply: true, remainingMs: 1000, timestamp: 1, content: { text: "question" } });
  await expect(f.federation.dispatch(address, remote, { id: "other", expectsReply: true, remainingMs: 1000, timestamp: 1, content: { text: "question" } })).rejects.toThrow(/one-outbound-ask/);
  expect(() => f.federation.observeInbound(remote.address, address, "activation-1", { id: "reverse", expectsReply: true, timestamp: 1, content: { text: "question" } })).toThrow(/mutual-ask/);
  f.federation.receipt(remote.address, { messageId: "ask", timestamp: 2, status: "not_injected", evidence: { kind: "absence", sessionId: "recipient", activationEpoch: "activation-2", excludedGeneration: "activation-2", complete: true } });
  expect(f.federation.inspectBlockers(address).asks.map(edge => edge.id)).toEqual(["ask"]);
  const inspected = f.federation.inspectBlockers(address);
  (inspected.asks[0]!.to as { sessionId: string }).sessionId = "forged";
  expect(f.federation.inspectBlockers(address).asks[0]?.to).toEqual(remote.address);
  f.federation.control(address, remote.address, { action: "cancel", messageId: "ask", timestamp: 3 });
  expect(f.federation.inspectBlockers(address).asks).toEqual([]);
}, 5000);

it("visible expiry clears a consumed question's remaining ask edge", async () => {
  const f = fixture(); f.federation.publishPresence([remote]);
  await f.federation.dispatch(address, remote, { id: "consumed-question", expectsReply: true, remainingMs: 1000, timestamp: 1, content: { text: "question" } });
  f.federation.receipt(remote.address, { messageId: "consumed-question", status: "injected", timestamp: 2, evidence: { kind: "entry", entryId: "physical", sessionId: "recipient", activationEpoch: "activation-2" } });
  expect(f.federation.inspectBlockers(address)).toMatchObject({ unobservedReceipts: [], asks: [{ id: "consumed-question" }] });
  f.federation.receipt(remote.address, { messageId: "consumed-question", status: "expired", timestamp: 3 });
  expect(f.federation.inspectBlockers(address).asks).toEqual([]);
}, 5000);

it("incoming receipts and controls settle without reflecting to the bridge", () => {
  const f = fixture();
  f.federation.observeInbound(remote.address, address, "activation-1", { id: "ask", expectsReply: true, timestamp: 1, content: { text: "question" } });
  f.federation.observeControl(remote.address, address, { messageId: "ask", action: "cancel", timestamp: 2 });
  expect(f.federation.inspectBlockers(address).asks).toEqual([]);
  f.federation.observeReceipt(address, { messageId: "ask", status: "injected", timestamp: 3, evidence: { kind: "entry", entryId: "physical", sessionId: "sender", activationEpoch: "activation-1" } });
  expect(f.federation.inspectBlockers(address).unobservedReceipts).toEqual([]);
  expect(f.bridge.receipt).not.toHaveBeenCalled(); expect(f.bridge.control).not.toHaveBeenCalled();
}, 5000);

it("stale generations cannot receive and scoped names stay isolated", async () => {
  const f = fixture(); f.federation.publishPresence([remote]);
  await expect(f.federation.dispatch(address, { ...remote, activationEpoch: "old" }, { id: "mail", timestamp: 1, content: { text: "synthetic" } })).rejects.toThrow(/endpoint/);
  await expect(f.federation.dispatch({ ...address, scopeId: "different" }, remote, { id: "mail", timestamp: 1, content: { text: "synthetic" } })).rejects.toThrow(/scope/);
  expect(f.dispatch).not.toHaveBeenCalled();
}, 5000);
