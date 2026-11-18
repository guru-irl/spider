import { expect, it } from "vitest";
import { parseConfig } from "../config";
import { bootstrapPeer } from "./bootstrap-fixture";

const hub = { role: "hub", machineId: "00000000-0000-4000-8000-000000000002", hubMachineId: "00000000-0000-4000-8000-000000000002", coreUnit: "hub-core.service" };

it("keeps the hub and peer core units separate and permits discovery when omitted", () => {
  expect(parseConfig({ ...hub, peers: [{ ...bootstrapPeer, coreUnit: "hc-serve-0a1b2c3d.service" }] })).toMatchObject({
    coreUnit: "hub-core.service", peers: [{ coreUnit: "hc-serve-0a1b2c3d.service" }],
  });
  expect(parseConfig({ ...hub, peers: [bootstrapPeer] }).peers[0].coreUnit).toBeUndefined();
});

it.each([null, "", " hc.service", "../hc.service", "hc.service\n", "hc", "a".repeat(256) + ".service", "hc@.service", "herdr-core@.service"])("rejects unsafe peer core unit %j", coreUnit => {
  expect(() => parseConfig({ ...hub, peers: [{ ...bootstrapPeer, coreUnit }] })).toThrow(/invalid roaming config/i);
});
