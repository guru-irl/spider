import { expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { registerRoamIntercom, inspectIntercomBlockers } from "../intercom";
import { INTERCOM_HOST_EVENT } from "@spider/intercom/protocol";
it("publishes current admitted epochs and detaches callbacks idempotently", async () => {
  const events = new EventEmitter(), hooks = new Map<string, any>();
  const pi = { on: (name: string, handler: any) => hooks.set(name, handler), events: { on: (name: string, handler: any) => { events.on(name, handler); return () => events.off(name, handler); }, emit: (name: string, p: unknown) => events.emit(name, p) } };
  let identityReads = 0;
  const ports = { admission: () => ({ kind: "ordinary", home: { sessionId: "own", machineId: "machine", epoch: 4, moveId: null, updatedAt: 1 }, blockers: [] }), machineId: async () => { identityReads++; return "machine"; }, home: () => null };
  const disposable = registerRoamIntercom(pi as any, ports as any);
  await hooks.get("session_start")({}, { sessionManager: { getSessionId: () => "own" } });
  const request: any = { activationEpoch: "activation", scopeId: "scope", sessionId: "own" }; events.emit(INTERCOM_HOST_EVENT, request);
  expect(request.endpoint).toEqual({ address: { sessionId: "own", scopeId: "scope" }, machineId: "machine", homeEpoch: 4, activationEpoch: "activation" });
  disposable.dispose(); disposable.dispose(); expect(events.listenerCount(INTERCOM_HOST_EVENT)).toBe(0);
  await hooks.get("session_start")({}, { sessionManager: { getSessionId: () => "own" } });
  expect(identityReads).toBe(1);
}, 5000);
it("combines broker and bridge blocker ids without authored content", async () => {
  const address = { sessionId: "own", scopeId: null };
  const blockers = await inspectIntercomBlockers(address, { broker: async () => ({ asks: [{ id: "ask", from: address, to: { sessionId: "other", scopeId: null } }], pendingDispatch: ["mail"], unknownOutcomes: ["unknown"], unobservedReceipts: [] }), bridge: () => ({ asks: [], pendingDispatch: ["mail"], unknownOutcomes: [], unobservedReceipts: ["receipt"] }) });
  expect(blockers.map(b => [b.kind, b.id])).toEqual([["intercom-ask", "ask"], ["intercom-dispatch", "mail"], ["intercom-unknown", "unknown"], ["intercom-receipt", "receipt"]]);
  expect(JSON.stringify(blockers)).not.toContain("body");
}, 5000);
