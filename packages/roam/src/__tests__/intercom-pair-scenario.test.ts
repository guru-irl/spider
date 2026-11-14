import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createProductionIntercomEnrollmentPorts } from "../intercom-production";
import { join } from "node:path";
import { createIntercomRegistry } from "../intercom-registry";
import { provisionIntercomEnrollment, revokeIntercomPair } from "../intercom-enrollment";
import { scenario, cleanupPairScenarios } from "./intercom-pair-fixture";
const B = "00000000-0000-4000-8000-000000000003";
afterEach(cleanupPairScenarios);

it("enrolls pair-owned units and revokes a live connection before removing only its reserved route", async () => {
  const f = await scenario();
  expect(await provisionIntercomEnrollment(f.request, f.enrollment)).toMatchObject({ code: 0, reason: "intercom-enrolled" });
  const secondRequest = { operation: { ...f.request.operation, id: "enroll-2" }, pairs: [{ ...f.request.pairs[0], pairId: "pair-2", source: f.otherSource, edgeEpoch: "edge-2", connector: { ...f.request.pairs[0].connector, tunnelId: "tunnel-2" } }] };
  const second = createProductionIntercomEnrollmentPorts({ root: f.root, journal: f.journal, transport: f.transport, request: secondRequest, actor: "fixture", now: () => 1000,
    present: async () => {}, approve: async () => true, notify: async () => {}, warn: async () => {} });
  expect((await provisionIntercomEnrollment(secondRequest, second)).code).toBe(0);
  const otherHost = structuredClone(f.units.get(`${B}/spider-pair-pair-2-host.service`)), otherConnect = structuredClone(f.units.get(`${f.otherSource.machineId}/spider-pair-pair-2-connect.service`)), otherRoute = structuredClone(f.otherMachines());
  const otherKey = readFileSync(join(f.locals.get(B)!.home, ".ssh", "authorized_keys"), "utf8").split("\n").find(row => row.endsWith(" spider-intercom:pair-2")); f.connect();
  expect(await revokeIntercomPair("pair-1", f.revokePorts)).toMatchObject({ code: 0, value: { cleanupReason: null } });
  expect(f.connected()).toBe(false); expect(f.machines()).toEqual([]);
  expect(f.units.get(`${B}/spider-pair-pair-2-host.service`)).toEqual(otherHost);
  expect(f.units.get(`${f.otherSource.machineId}/spider-pair-pair-2-connect.service`)).toEqual(otherConnect); expect(f.otherMachines()).toEqual(otherRoute);
  expect(readFileSync(join(f.locals.get(B)!.home, ".ssh", "authorized_keys"), "utf8").split("\n")).toContain(otherKey);
  expect(readFileSync(join(f.locals.get(B)!.home, ".ssh", "authorized_keys"), "utf8")).not.toContain("spider-intercom:pair-1");
  const stopB = f.calls.findIndex(call => call.includes("stop spider-pair-pair-1-host.service")), stopA = f.calls.findIndex(call => call.includes("stop spider-pair-pair-1-connect.service")), removed = f.calls.findIndex(call => call.includes("machine rm spider-pair-pair-1"));
  expect(stopB).toBeGreaterThan(-1); expect(stopA).toBeGreaterThan(stopB); expect(removed).toBeGreaterThan(stopA);
  expect(await createIntercomRegistry(f.source.globalRoot).get("pair-1")).toMatchObject({ state: "revoked", cleanupReason: null });
  expect(await createIntercomRegistry(f.target.globalRoot).get("pair-1")).toMatchObject({ state: "revoked", cleanupReason: null });
}, 5000);

it("a host straggler preserves the key and route until a later retry proves closure", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0); f.connect(); f.straggler(true);
  expect(await revokeIntercomPair("pair-1", f.revokePorts)).toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed" });
  expect(readFileSync(join(f.locals.get(B)!.home, ".ssh", "authorized_keys"), "utf8")).toContain("spider-intercom:pair-1"); expect(f.machines()).toHaveLength(1);
  f.straggler(false);
  expect(await revokeIntercomPair("pair-1", f.revokePorts)).toMatchObject({ code: 0, value: { cleanupReason: null } }); expect(f.machines()).toEqual([]);
}, 5000);

it.each(["live", "finished"])("any %s terminal blocks removal of the closed reserved route", async state => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0); f.terminals([{ address: "spider-pair-pair-1/t1", state }]);
  expect(await revokeIntercomPair("pair-1", f.revokePorts)).toMatchObject({ code: 0, value: { cleanupReason: "intercom-revocation-cleanup-pending" } });
  expect(f.calls.some(call => call.includes("machine rm"))).toBe(false); expect(f.machines()).toHaveLength(1);
  f.terminals([]); expect(await revokeIntercomPair("pair-1", f.revokePorts)).toMatchObject({ code: 0, value: { cleanupReason: null } });
}, 5000);

it("a terminal listing error leaves route cleanup pending", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0); f.listingError(true);
  expect(await revokeIntercomPair("pair-1", f.revokePorts)).toMatchObject({ code: 0, value: { cleanupReason: "intercom-revocation-cleanup-pending" } });
  expect(f.calls.some(call => call.includes("machine rm"))).toBe(false); expect(f.machines()).toHaveLength(1);
}, 5000);

it("never removes a reserved route whose recorded configuration changed", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0); f.mismatch();
  expect(await revokeIntercomPair("pair-1", f.revokePorts)).toMatchObject({ code: 0, value: { cleanupReason: "intercom-revocation-cleanup-pending" } });
  expect(f.calls.some(call => call.includes("machine rm"))).toBe(false); expect(f.machines()).toHaveLength(1);
}, 5000);

it("a changed target core stays unconfirmed without touching the recorded host or key", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0); f.connect();
  const pin = f.transport.pinIntercomPeer; f.transport.pinIntercomPeer = async peer => { const value = await pin(peer); return peer.machineId === B ? { ...value, coreId: "changed-core" } : value; };
  expect(await revokeIntercomPair("pair-1", f.revokePorts)).toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed" });
  expect(f.connected()).toBe(true); expect(f.calls.some(call => call.includes("stop spider-pair-pair-1-host.service"))).toBe(false);
  expect(readFileSync(join(f.locals.get(B)!.home, ".ssh", "authorized_keys"), "utf8")).toContain("spider-intercom:pair-1");
}, 5000);

it("unreachable B leaves revocation unconfirmed without removing access", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0); f.offline(true);
  expect(await revokeIntercomPair("pair-1", f.revokePorts)).toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed" });
  expect(f.calls.some(call => call.includes(" stop ") || call.includes("machine rm"))).toBe(false); expect(f.machines()).toHaveLength(1);
}, 5000);
