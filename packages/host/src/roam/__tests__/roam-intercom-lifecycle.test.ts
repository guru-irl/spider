import { expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { queryObjects } from "node:v8";
import { registerRoamIntercom, inspectIntercomBlockers, reconcileOwnIntercom } from "../intercom";
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
it("releases a retired context even when its reconciliation callback is retained", async () => {
  class SessionContext {
    sessionManager = {
      getSessionId: () => "own",
      getSessionFile: () => "fixture.jsonl",
      getEntries: () => [{ type: "custom_message", customType: "intercom_message", id: "entry", details: { message: { id: "message" }, intercom: { sessionId: "own", activationEpoch: "old" } } }],
    };
  }
  const events = new EventEmitter(), hooks = new Map<string, any>();
  const pi = { on: (name: string, handler: any) => hooks.set(name, handler), events: { on: (name: string, handler: any) => { events.on(name, handler); return () => events.off(name, handler); } } };
  const owner = { address: { sessionId: "own", scopeId: "scope" }, machineId: "machine", homeEpoch: 4, activationEpoch: "old" };
  const ports = { admission: () => ({ kind: "ordinary", home: { sessionId: "own", machineId: "machine", epoch: 4, moveId: null, updatedAt: 1 }, blockers: [] }), machineId: async () => "machine", home: () => null, reconcile: reconcileOwnIntercom };
  registerRoamIntercom(pi as any, ports as any);
  const request: any = { activationEpoch: "new", scopeId: "scope", sessionId: "own" };
  await (async () => {
    const ctx = new SessionContext();
    await hooks.get("session_start")({}, ctx);
    events.emit(INTERCOM_HOST_EVENT, request);
    expect(await request.reconcile("message", owner)).toMatchObject({ status: "injected", evidence: { entryId: "entry" } });
    await hooks.get("session_shutdown")({ reason: "reload" }, ctx);
  })();
  expect(queryObjects(SessionContext)).toBe(0);
  await expect(request.reconcile("message", owner)).rejects.toThrow();
}, 5000);

it("does not reconcile an old request against a replacement session", async () => {
  const events = new EventEmitter(), hooks = new Map<string, any>();
  const pi = { on: (name: string, handler: any) => hooks.set(name, handler), events: { on: (name: string, handler: any) => { events.on(name, handler); return () => events.off(name, handler); } } };
  const ports = { admission: () => ({ kind: "ordinary", home: { sessionId: "own", machineId: "machine", epoch: 4, moveId: null, updatedAt: 1 }, blockers: [] }), machineId: async () => "machine", home: () => null, reconcile: reconcileOwnIntercom };
  const makeContext = (entries: unknown[]) => ({ sessionManager: { getSessionId: () => "own", getSessionFile: () => "fixture.jsonl", getEntries: () => entries } });
  const owner = { address: { sessionId: "own", scopeId: "scope" }, machineId: "machine", homeEpoch: 4, activationEpoch: "old" };
  const disposable = registerRoamIntercom(pi as any, ports as any);
  await hooks.get("session_start")({}, makeContext([{ type: "custom_message", customType: "intercom_message", id: "old-entry", details: { message: { id: "message" }, intercom: { sessionId: "own", activationEpoch: "old" } } }]));
  const oldRequest: any = { activationEpoch: "first", scopeId: "scope", sessionId: "own" }; events.emit(INTERCOM_HOST_EVENT, oldRequest);
  await hooks.get("session_start")({}, makeContext([]));
  const currentRequest: any = { activationEpoch: "second", scopeId: "scope", sessionId: "own" }; events.emit(INTERCOM_HOST_EVENT, currentRequest);
  await expect(oldRequest.reconcile("message", owner)).rejects.toThrow();
  expect(await currentRequest.reconcile("message", owner)).toMatchObject({ status: "unknown" });
  disposable.dispose();
}, 5000);

it("combines broker and bridge blocker ids without authored content", async () => {
  const address = { sessionId: "own", scopeId: null };
  const blockers = await inspectIntercomBlockers(address, { broker: async () => ({ asks: [{ id: "ask", from: address, to: { sessionId: "other", scopeId: null } }], pendingDispatch: ["mail"], unknownOutcomes: ["unknown"], unobservedReceipts: [] }), bridge: () => ({ asks: [], pendingDispatch: ["mail"], unknownOutcomes: [], unobservedReceipts: ["receipt"] }) });
  expect(blockers.map(b => [b.kind, b.id])).toEqual([["intercom-ask", "ask"], ["intercom-dispatch", "mail"], ["intercom-unknown", "unknown"], ["intercom-receipt", "receipt"]]);
  expect(JSON.stringify(blockers)).not.toContain("body");
}, 5000);
