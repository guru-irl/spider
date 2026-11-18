import { expect, it } from "vitest";
import { HerdrError } from "@spider/herdr/client/parse";
import { DEFAULT_LIMITS } from "../contracts";
import type { Journal, Peer, Transport } from "../contracts";
import type { DoctorPorts, Inventory } from "../provision-contracts";
import * as inventoryModule from "../inventory";
import * as doctorModule from "../resource-doctor";
import { intercomReadinessDiagnostics } from "../intercom-readiness";
import { bootstrapPeer, healthyInventory } from "./bootstrap-fixture";

type InventoryFn = (peer: Peer, transport: Transport) => Promise<Inventory>;
type DoctorFn = (peer: Peer, ports: DoctorPorts) => Promise<readonly import("../contracts").Diagnostic[]>;

function fixture(value: Inventory = healthyInventory()) {
  const adminRepairCalls: readonly string[][] = [], probeCalls: string[] = [], probeOptions: unknown[] = [];
  const transport: Transport = {
    async resolve(peer) { probeCalls.push("resolve"); return peer; },
    async bootstrapProbe(_peer, kind, options) { probeCalls.push(kind); probeOptions.push(options); return structuredClone(value); },
    async exec() { throw new Error("unexpected command"); },
    async run() { throw new Error("unexpected launch"); },
    async read() { throw new Error("unexpected read"); },
    async write() { throw new Error("unexpected write"); },
  };
  const journal: Journal = {
    begin() { throw new Error("unexpected journal"); }, record() { throw new Error("unexpected journal"); }, read() { throw new Error("unexpected journal"); },
  };
  const ports: DoctorPorts = {
    transport, journal, limits: DEFAULT_LIMITS,
    async confirm() { throw new Error("unexpected confirmation"); },
    systemd: { unitDir: "/fixture/units", async systemctl(argv) { (adminRepairCalls as string[][]).push([...argv]); } },
    async resources() { throw new Error("local resource probe is forbidden"); },
    async bootId() { throw new Error("boot probe is forbidden"); },
    release: { pi: "1.2.0", intercom: "spider-owned", spiderSha256: "a".repeat(64), nodeRange: "22.23.4 || 26.4.0" },
  };
  return { ports, adminRepairCalls, probeCalls, probeOptions };
}

it("inventory refuses missing prerequisites without sudo", async () => {
  const inventory = (inventoryModule as { inventory?: InventoryFn }).inventory;
  expect(typeof inventory).toBe("function");
  const cases: Inventory[] = [
    { ...healthyInventory(), platform: "darwin" },
    { ...healthyInventory(), gitVersion: null },
    { ...healthyInventory(), systemdUser: false },
    { ...healthyInventory(), core: { unit: null, unitExists: false, unitOwned: false, transient: null, socketExists: false, socketOwned: false } },
    { ...healthyInventory(), nodeVersion: "22.18.0" },
    { ...healthyInventory(), nodeVersion: "26.4.1" },
  ];
  for (const value of cases) {
    const test = fixture(value);
    await expect(inventory!(bootstrapPeer, test.ports.transport)).rejects.toMatchObject({ code: "missing-prerequisite" });
    expect(test.adminRepairCalls).toEqual([]);
    expect(test.probeCalls).toEqual(["inventory"]);
  }
}, 5000);

it("does not run enrolled roaming resolution while taking inventory", async () => {
  const inventory = (inventoryModule as { inventory?: InventoryFn }).inventory;
  expect(typeof inventory).toBe("function");
  const test = fixture(healthyInventory());
  test.ports.transport.resolve = async () => { throw new Error("must not resolve roaming identity"); };
  await expect(inventory!(bootstrapPeer, test.ports.transport)).resolves.toEqual(healthyInventory());
  expect(test.probeCalls).toEqual(["inventory"]);
}, 5000);

it("sanitizes a bootstrap failure before it reaches inventory callers", async () => {
  const inventory = (inventoryModule as { inventory?: InventoryFn }).inventory;
  expect(typeof inventory).toBe("function");
  const test = fixture(healthyInventory());
  test.ports.transport.bootstrapProbe = async () => { throw new HerdrError("cli-exit", "fixture-secret", { stderr: "fixture-secret" }); };
  const error = await inventory!(bootstrapPeer, test.ports.transport).catch(value => value);
  expect(error).toMatchObject({ code: "cli-exit" });
  expect(String(error)).not.toContain("fixture-secret");
  expect(JSON.stringify(error)).not.toContain("fixture-secret");
}, 5000);

it("doctor reports low resources and missing CLI auth", async () => {
  const doctor = (doctorModule as { doctorPeer?: DoctorFn }).doctorPeer;
  expect(typeof doctor).toBe("function");
  const value = healthyInventory();
  value.softNofile = 1024; value.hardNofile = 2048; value.inotifyInstances = 128; value.inotifyWatches = 4096;
  value.auth.gh = { present: false, readable: false, modeSafe: false }; value.auth.ghSignedIn = false;
  const test = fixture(value);
  const report = await doctor!(bootstrapPeer, test.ports);
  const lowHardLimit = report.find(item => /hard.*open.file/i.test(item.reason));
  expect(lowHardLimit?.severity).toBe("warning");
  expect(lowHardLimit?.reason).toMatch(/core restart.*terminals/i);
  expect(lowHardLimit?.repairCommand).toContain("herdr-core.service");
  expect(report.some(item => item.severity === "warning" && /inotify.*instances/i.test(item.reason) && item.repairCommand?.includes("max_user_instances"))).toBe(true);
  expect(report.some(item => item.severity === "warning" && /inotify.*watches/i.test(item.reason) && item.repairCommand?.includes("max_user_watches"))).toBe(true);
  expect(report.some(item => item.severity === "warning" && /gh.*auth/i.test(item.reason))).toBe(true);
  expect(test.adminRepairCalls).toEqual([]);
}, 5000);

it("absolute pi path is recorded for minimal PATH", async () => {
  const inventory = (inventoryModule as { inventory?: InventoryFn }).inventory;
  expect(typeof inventory).toBe("function");
  const test = fixture();
  const result = await inventory!(bootstrapPeer, test.ports.transport);
  expect(result.pi).toBe(bootstrapPeer.pi);
  expect(result.pi!.startsWith("/")).toBe(true);
  expect(result.piVersion).toBe("1.2.0");
  expect(test.probeCalls).toEqual(["inventory"]);
}, 5000);

it.each([
  ["missing pi", (value: Inventory) => { value.pi = null; value.piVersion = null; }, /pi executable.*unavailable/i],
  ["wrong pi version", (value: Inventory) => { value.piVersion = "1.1.0"; }, /pi executable.*required version/i],
  ["missing spider", (value: Inventory) => { value.spider = { installed: false, version: null, nativeModuleReady: false }; }, /spider release.*not installed/i],
  ["unavailable native module", (value: Inventory) => { value.spider.nativeModuleReady = false; }, /native SQLite module.*unavailable/i],
])("blocks hosting for %s", async (_name, change, reason) => {
  const doctor = (doctorModule as { doctorPeer?: DoctorFn }).doctorPeer;
  expect(typeof doctor).toBe("function");
  const value = healthyInventory(); change(value);
  const test = fixture(value);
  const report = await doctor!(bootstrapPeer, test.ports);
  expect(report.some(item => item.severity === "block" && reason.test(item.reason))).toBe(true);
  expect(test.adminRepairCalls).toEqual([]);
}, 5000);

it("reports disabled lingering without enabling it", async () => {
  const doctor = (doctorModule as { doctorPeer?: DoctorFn }).doctorPeer;
  expect(typeof doctor).toBe("function");
  const value = healthyInventory(); value.linger = false;
  const test = fixture(value), report = await doctor!(bootstrapPeer, test.ports);
  expect(report.some(item => item.severity === "warning" && /lingering.*disabled/i.test(item.reason) && item.repairCommand === "loginctl enable-linger")).toBe(true);
  expect(test.adminRepairCalls).toEqual([]);
}, 5000);

it("blocks missing pi auth but only warns about missing tool auth", async () => {
  const doctor = (doctorModule as { doctorPeer?: DoctorFn }).doctorPeer;
  expect(typeof doctor).toBe("function");
  const value = healthyInventory();
  value.auth.pi = { present: true, readable: true, modeSafe: false };
  value.auth.gh = { present: false, readable: false, modeSafe: false }; value.auth.ghSignedIn = false;
  const report = await doctor!(bootstrapPeer, fixture(value).ports);
  expect(report.some(item => item.severity === "block" && /pi auth file.*unsafe/i.test(item.reason))).toBe(true);
  expect(report.some(item => item.severity === "warning" && /gh.*auth/i.test(item.reason))).toBe(true);
}, 5000);

it("reports configured CLI and auth status without exposing their paths", async () => {
  const doctor = (doctorModule as { doctorPeer?: DoctorFn }).doctorPeer;
  expect(typeof doctor).toBe("function");
  const value = healthyInventory();
  value.cli.configured = [{ executable: { present: true, readable: true, modeSafe: false, executable: true }, auth: { present: false, readable: false, modeSafe: false } }];
  const test = fixture(value);
  test.ports.configuredClis = [{ name: "tool", executable: "/home/fixture/.local/bin/tool", authFile: "/home/fixture/.config/tool/auth.json" }];
  const report = await doctor!(bootstrapPeer, test.ports);
  expect(report.some(item => item.severity === "warning" && /tool.*CLI.*unsafe/i.test(item.reason))).toBe(true);
  expect(report.some(item => item.severity === "warning" && /tool.*auth/i.test(item.reason))).toBe(true);
  expect(JSON.stringify(report)).not.toContain("/home/fixture");
  expect(test.probeOptions[0]).toMatchObject({ configuredClis: test.ports.configuredClis });
  expect(test.adminRepairCalls).toEqual([]);
}, 5000);

it("does not treat safe auth-file metadata as proof of pi sign-in", async () => {
  const doctor = (doctorModule as { doctorPeer?: DoctorFn }).doctorPeer;
  expect(typeof doctor).toBe("function");
  const report = await doctor!(bootstrapPeer, fixture().ports);
  expect(report.some(item => item.severity === "block" && /pi.*sign.in.*unverified/i.test(item.reason))).toBe(true);
}, 5000);

it("treats unlimited limits as sufficient and unknown measurements as warnings", async () => {
  const doctor = (doctorModule as { doctorPeer?: DoctorFn }).doctorPeer;
  expect(typeof doctor).toBe("function");
  const unlimited: Inventory = { ...healthyInventory(), softNofile: "unlimited", hardNofile: "unlimited" };
  const known = await doctor!(bootstrapPeer, fixture(unlimited).ports);
  expect(known.some(item => /open.file/i.test(item.reason))).toBe(false);
  const unknown: Inventory = { ...healthyInventory(), softNofile: null, hardNofile: null, inotifyInstances: null, inotifyWatches: null, linger: null };
  const missing = await doctor!(bootstrapPeer, fixture(unknown).ports);
  expect(missing.filter(item => item.severity === "warning" && /unknown|could not/i.test(item.reason)).length).toBeGreaterThanOrEqual(4);
}, 5000);

it("reports a named transport failure without copying stderr", async () => {
  const doctor = (doctorModule as { doctorPeer?: DoctorFn }).doctorPeer;
  expect(typeof doctor).toBe("function");
  const test = fixture();
  test.ports.transport.bootstrapProbe = async () => { throw new HerdrError("needs_login", "fixture-secret"); };
  const report = await doctor!(bootstrapPeer, test.ports);
  expect(report).toEqual([expect.objectContaining({ severity: "block", reason: expect.stringContaining("needs_login") })]);
  expect(JSON.stringify(report)).not.toContain("fixture-secret");
}, 5000);

it("blocks an unsafe roaming root and an unreadable existing identity", async () => {
  const doctor = (doctorModule as { doctorPeer?: DoctorFn }).doctorPeer;
  expect(typeof doctor).toBe("function");
  const unsafe = healthyInventory();
  unsafe.roaming = { rootExists: true, rootSafe: false, identityExists: true, machineId: null };
  const first = fixture(unsafe), report = await doctor!(bootstrapPeer, first.ports);
  expect(report.some(item => item.severity === "block" && /roaming.*unsafe/i.test(item.reason))).toBe(true);
  expect(first.adminRepairCalls).toEqual([]);
  const malformed = healthyInventory();
  malformed.roaming = { rootExists: true, rootSafe: true, identityExists: true, machineId: null };
  const second = fixture(malformed), report2 = await doctor!(bootstrapPeer, second.ports);
  expect(report2.some(item => item.severity === "block" && /machine identity.*invalid/i.test(item.reason))).toBe(true);
  expect(second.adminRepairCalls).toEqual([]);
}, 5000);

it("warns about a missing diagnostic core unit when the owned core socket exists", async () => {
  const doctor = (doctorModule as { doctorPeer?: DoctorFn }).doctorPeer;
  expect(typeof doctor).toBe("function");
  const value = healthyInventory();
  value.core = { unit: null, unitExists: false, unitOwned: false, transient: null, socketExists: true, socketOwned: true };
  const test = fixture(value); test.ports.coreUnit = "session-host.service";
  const report = await doctor!(bootstrapPeer, test.ports);
  expect(report.some(item => item.severity === "warning" && /core unit.*missing/i.test(item.reason))).toBe(true);
  expect(test.adminRepairCalls).toEqual([]);
}, 5000);

it("inventory does not require the recorded diagnostic unit to survive a core restart", async () => {
  const value = healthyInventory();
  value.core = { unit: null, unitExists: false, unitOwned: false, transient: null, socketExists: true, socketOwned: true };
  const test = fixture(value);
  await expect(inventoryModule.inventory(bootstrapPeer, test.ports.transport, { timeoutMs: 1000, maxBytes: 65536, coreUnit: "stale.service" })).resolves.toEqual(value);
  expect(test.adminRepairCalls).toEqual([]);
});

it.each([true, false])("doctor reports the current core unit and transient=%s", async transient => {
  const value = healthyInventory(); value.core.transient = transient;
  const report = await doctorModule.doctorPeer(bootstrapPeer, fixture(value).ports);
  expect(report).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringMatching(transient ? /herdr-core\.service.*transient/ : /herdr-core\.service.*persistent/) })]));
});

it("does not suggest editing a transient unit to repair startup limits", async () => {
  const value = healthyInventory(); value.core.transient = true; value.hardNofile = 2048; value.softNofile = 1024;
  const report = await doctorModule.doctorPeer(bootstrapPeer, fixture(value).ports);
  expect(report.find(item => /hard.*open.file/i.test(item.reason))?.repairCommand).toBeNull();
});

it("doctor never installs or logs in and reports named intercom problems", async () => {
  const test = fixture();
  const effects: string[] = [];
  test.ports.inspectIntercom = async () => ({
    connector: "missing", login: "required", tunnel: "unhosted", peerPort: "unreachable", hostKey: "changed",
    key: "unsafe", route: "missing", extension: "duplicate", broker: "legacy", feature: "missing", link: "down",
    pendingRevocations: [{ pairId: "pair-1", reason: "intercom-revocation-peer-unreachable" }],
  });
  const report = await doctorModule.doctorPeer(bootstrapPeer, test.ports);
  for (const reason of ["intercom-connector-missing", "intercom-connector-sign-in-required", "intercom-tunnel-unhosted", "intercom-peer-port-unreachable", "host-key-changed", "intercom-key-unsafe", "intercom-route-missing",
    "intercom-extension-duplicate", "intercom-legacy-broker", "intercom-feature-missing", "intercom-link-down", "intercom-revocation-peer-unreachable"]) {
    expect(report.some(item => item.reason.includes(reason)), reason).toBe(true);
  }
  expect(report.find(item => item.reason.includes("intercom-revocation-peer-unreachable"))?.reason).toContain("pair-1");
  expect(report.find(item => item.reason.includes("host-key-changed"))?.reason).toMatch(/re.enroll/i);
  expect(report.find(item => item.reason.includes("intercom-connector-sign-in-required"))?.reason).toMatch(/sign in/i);
  expect(test.adminRepairCalls).toEqual([]); expect(test.probeCalls).toEqual(["inventory"]); expect(effects).toEqual([]);
}, 5000);

it("accepts intercom hosting readiness only when all three checks are proved", async () => {
  const test = fixture();
  test.ports.verifyPeer = async () => ({ piSignedIn: true, nativeSqlite: true, extensionLoaded: true, exactSession: true, privateModes: true,
    bundledIntercom: true, intercomUnique: true, legacyDrained: true, federation: true,
    intercomEvidence: { settings: "settings-unique", legacy: "legacy-drained-private-agent", federation: "federation-v1", otherExtensions: ["ordinary-extension"] } });
  const report = await doctorModule.doctorPeer(bootstrapPeer, test.ports);
  expect(report.filter(item => item.severity === "block")).toEqual([]);
  expect(report.some(item => item.reason.includes("global settings only; project-local settings are not checked"))).toBe(true);
  expect(report.some(item => item.reason.includes("only known intercom implementation") && item.reason.includes("other extensions are not classified"))).toBe(true);
  expect(report.some(item => item.reason.includes("ordinary-extension") && item.severity === "warning")).toBe(true);
});

it.each([
  ["intercomUnique", "intercom-settings-unique"],
  ["legacyDrained", "intercom-legacy-drained"],
  ["federation", "intercom-federation"],
] as const)("names %s when it alone is unproved", async (key, reason) => {
  // A truth-table test of the diagnostics, not a fake broker observation. In the real protocol,
  // missing federation also makes legacy-drained unprovable because it uses the same health reply.
  const blocks = intercomReadinessDiagnostics({ intercomUnique: true, legacyDrained: true, federation: true, [key]: false,
    intercomEvidence: { settings: "settings-unique", legacy: "legacy-drained-private-agent", federation: "federation-v1", otherExtensions: [] } })
    .filter(item => item.severity === "block");
  expect(blocks).toHaveLength(1);
  expect(blocks[0].reason).toContain(`${reason}:`);
});

it("refuses an unowned core without modifying its service", async () => {
  const doctor = (doctorModule as { doctorPeer?: DoctorFn }).doctorPeer;
  expect(typeof doctor).toBe("function");
  const value = healthyInventory(); value.core.unitOwned = false; value.core.socketOwned = false;
  const test = fixture(value);
  const report = await doctor!(bootstrapPeer, test.ports);
  expect(report.some(item => item.severity === "block" && /core.*owned/i.test(item.reason))).toBe(true);
  expect(test.adminRepairCalls).toEqual([]);
}, 5000);
