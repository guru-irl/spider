import { expect, expectTypeOf, it } from "vitest";
import { parseConfig } from "../config";
import type { HubPorts } from "../contracts";

const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";
const peer = (machineId: string, alias: string) => ({ machineId, alias, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: "/fixture/global" });
const hub = { role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture.service" };
const box = { role: "box", machineId: BOX, hubMachineId: HUB, coreUnit: "fixture.service" };
const direct = (machineId: string, alias: string, edgeEpoch = "edge-1") => ({ kind: "direct", peer: peer(machineId, alias), edgeEpoch });
const relay = (machineId: string, alias: string) => ({ kind: "relay", peer: peer(machineId, alias), via: HUB });

it("defaults federation to disabled with separate empty routes and bounded limits", () => {
  const config = parseConfig(hub);
  expect(config.enabled).toBe(false);
  expect(config.peers).toEqual([]);
  expect(config.intercom).toEqual({ enabled: false, mode: "hub-only", machineAlias: null, protocolFeature: "federation-v1",
    routes: [], limits: { queueMessages: 256, queueBytes: 64 * 1024 * 1024 } });
}, 5000);

it("box replication peers remain empty when intercom peers are configured", () => {
  const config = parseConfig({ ...box, enabled: false, intercom: { enabled: true, mode: "peers", machineAlias: "box-1.invalid",
    routes: [direct(HUB, "hub.invalid"), direct(OTHER, "box-2.invalid")] } });
  expect(config.enabled).toBe(false);
  expect(config.peers).toEqual([]);
  expect(config.intercom.routes.map(route => route.peer.machineId)).toEqual([HUB, OTHER]);
}, 5000);

it("keeps an approved graph configured while intercom is disabled", () => {
  const config = parseConfig({ ...hub, intercom: { enabled: false, mode: "peers", machineAlias: "hub.invalid",
    routes: [direct(BOX, "box-1.invalid")] } });
  expect(config.intercom).toMatchObject({ enabled: false, mode: "peers", routes: [{ kind: "direct", peer: { machineId: BOX } }] });
}, 5000);

it("accepts explicit hub-only relay destinations without changing replication", () => {
  const config = parseConfig({ ...box, intercom: { enabled: true, mode: "hub-only", machineAlias: "box-1.invalid",
    routes: [direct(HUB, "hub.invalid"), relay(OTHER, "box-2.invalid")] } });
  expect(config.peers).toEqual([]);
  expect(config.intercom.routes).toEqual([direct(HUB, "hub.invalid"), relay(OTHER, "box-2.invalid")]);
}, 5000);

it.each([
  { enabled: true, mode: "peers", routes: [] },
  { enabled: true, mode: "other", machineAlias: "hub.invalid", routes: [] },
  { enabled: true, mode: "peers", machineAlias: "hub.invalid", protocolFeature: "unknown", routes: [] },
  { enabled: true, mode: "peers", machineAlias: "hub.invalid", routes: [direct(HUB, "self.invalid")] },
  { enabled: true, mode: "peers", machineAlias: "hub.invalid", routes: [direct(BOX, "box.invalid"), direct(BOX, "other.invalid")] },
  { enabled: true, mode: "peers", machineAlias: "hub.invalid", routes: [direct(BOX, "BOX.invalid"), direct(OTHER, "box.invalid")] },
  { enabled: true, mode: "peers", machineAlias: "hub.invalid", routes: [direct(BOX, "hub.invalid")] },
  { enabled: true, mode: "peers", machineAlias: "hub.invalid", routes: [direct(BOX, "box.invalid", "../bad")] },
  { enabled: true, mode: "peers", machineAlias: "hub.invalid", routes: [relay(OTHER, "box.invalid")] },
])("rejects malformed or ambiguous hub graph %#", intercom => {
  expect(() => parseConfig({ ...hub, intercom })).toThrow(/invalid roaming config/i);
}, 5000);

it.each([
  { routes: [direct(OTHER, "box-2.invalid")] },
  { routes: [relay(OTHER, "box-2.invalid")] },
  { routes: [direct(HUB, "hub.invalid"), { ...relay(OTHER, "box-2.invalid"), via: OTHER }] },
])("rejects hub-only box routes without their authorized hub edge %#", ({ routes }) => {
  expect(() => parseConfig({ ...box, intercom: { enabled: true, mode: "hub-only", machineAlias: "box-1.invalid", routes } })).toThrow(/invalid roaming config/i);
}, 5000);

it("allows only lower queue limits and rejects unknown limit fields", () => {
  const input = { ...hub, intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid", limits: { queueMessages: 2, queueBytes: 1024 } } };
  expect(parseConfig(input).intercom.limits).toEqual({ queueMessages: 2, queueBytes: 1024 });
  for (const limits of [{ queueMessages: 257 }, { queueBytes: 64 * 1024 * 1024 + 1 }, { queueMessages: 0 }, { unexpected: 1 }]) {
    expect(() => parseConfig({ ...input, intercom: { ...input.intercom, limits } })).toThrow(/invalid roaming config/i);
  }
}, 5000);

it("parses a machine-local connector recipe as bounded argv arrays", () => {
  const connector = { check: ["/fixture/connector", "check"], host: ["/fixture/connector", "host", "endpoint"],
    connect: ["/fixture/connector", "connect", "peer"], localPort: 23222 };
  const config = parseConfig({ ...box, intercom: { enabled: false, connector } });
  expect(config.intercom.connector).toEqual(connector);
  expect(parseConfig(box).intercom.connector).toBeUndefined();
}, 5000);

it("refuses malformed connector recipes by name without echoing their contents", () => {
  const connector = { check: ["/fixture/connector", "check"], host: ["/fixture/connector", "host"], connect: ["/fixture/connector", "connect"], localPort: 23222 };
  const invalid = [
    { ...connector, check: "fixture-secret" }, { ...connector, host: [] }, { ...connector, connect: ["relative", "arg"] },
    { ...connector, check: ["/bin/sh", "-c", "fixture-secret"] }, { ...connector, localPort: 0 }, { ...connector, localPort: 65536 },
    { check: connector.check, connect: connector.connect, localPort: 23222 }, { ...connector, extra: true },
  ];
  for (const recipe of invalid) {
    try { parseConfig({ ...box, intercom: { connector: recipe } }); throw new Error("accepted"); }
    catch (error) { expect((error as Error).message).toContain("intercom-connector-recipe-invalid"); expect(String(error)).not.toContain("fixture-secret"); }
  }
}, 5000);

it("HubPorts stays unchanged", () => {
  expectTypeOf<keyof HubPorts>().toEqualTypeOf<"config" | "sync" | "journal" | "clock" | "placement">();
}, 5000);
