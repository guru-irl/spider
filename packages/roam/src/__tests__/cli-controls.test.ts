import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { main } from "../cli";
import { startHubControl, type HubControlReply, type HubControlRequest } from "../control-socket";
import * as productionHub from "../production-hub";
import * as localRuntime from "../runtime";
import * as agent from "../agent";
import * as transportModule from "../transport";
import * as hosting from "../production-supervisor";
import * as appModule from "@spider/herdr/client/app";
import * as hcModule from "@spider/herdr/client/hc";
import { createClientFixture } from "../../../herdr/src/__tests__/testutil";

const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
const sockets: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close();
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(identity = HUB, reply?: HubControlReply) {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "r26-")); roots.push(root);
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: identity }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB,
    hubMachineId: HUB, peers: [{ machineId: BOX, alias: "-box-1.invalid", node: "/fixture/node", pi: "/fixture/pi",
      cli: "/fixture/spider", core: "/fixture/core", globalRoot: "/fixture/global" }], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  const calls: HubControlRequest[] = [];
  const socket = await startHubControl(join(root, "roam", "hub.sock"), async request => {
    calls.push(request);
    return reply ?? { code: 0, reason: "Synchronization complete", value: { outcomes: [] } };
  });
  sockets.push(socket);
  const out: string[] = [], err: string[] = [];
  return { root, calls, out, err, invoke: (args: string[]) => main(args, { out: text => out.push(text), err: text => err.push(text) }) };
}

it.each(["stop", "resume"])("%s sends a hub-issued operation to the current box home", async action => {
  const f = await fixture();
  const db = { prepare() { return { get() { return { machine_id: BOX, epoch: 3 }; } }; } };
  vi.spyOn(localRuntime, "openLocalCore").mockReturnValue({ root: f.root, db, config: localRuntime.readLocalIdentity(f.root), close() {} } as never);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  const operations: any[] = [];
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: any) { return peer; }, async exec(peer: any, argv: string[]) {
    const operation = JSON.parse(argv[2]); operations.push(operation);
    expect(peer.machineId).toBe(BOX);
    return Buffer.from(JSON.stringify({ code: 0, reason: "intent-updated", operationId: operation.id, home: null, epoch: 3, repairCommand: null, value: null }));
  } } as never);
  expect(await f.invoke(["roam", action, "s-1"])).toBe(0);
  expect(operations).toEqual([expect.objectContaining({ kind: `session-${action}`, machineId: BOX, expectedEpoch: 3, args: { sourceMachine: HUB, sessionId: "s-1" } })]);
}, 5000);

it.each(["0", false, null])("refuses a control reply with nonnumeric code %s", async code => {
  const f = await fixture(), db = { prepare() { return { get() { return { machine_id: BOX, epoch: 3 }; } }; } };
  vi.spyOn(localRuntime, "openLocalCore").mockReturnValue({ root: f.root, db, config: localRuntime.readLocalIdentity(f.root), close() {} } as never);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    const operation = JSON.parse(argv[2]); return Buffer.from(JSON.stringify({ code, reason: "forged success", operationId: operation.id }));
  } } as never);
  expect(await f.invoke(["roam", "stop", "s-1"])).toBe(1);
  expect(f.out).toEqual([]); expect(f.err.join("")).toContain("Participant control is unavailable");
  expect(f.err.join("")).not.toContain("forged success");
}, 5000);

it("private hosting observation invokes the producer with the explicit root", async () => {
  const f = await fixture();
  const producer = vi.spyOn(hosting, "observeLocalHosting").mockResolvedValue({ readiness: [], suspensions: [{ sessionId: "s-1", epoch: 2 }] });
  expect(await f.invoke(["roam", "observe", "hosting"])).toBe(0);
  expect(producer).toHaveBeenCalledWith(f.root);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ version: 1, machineId: HUB, kind: "hosting", value: { suspensions: [{ sessionId: "s-1", epoch: 2 }] } });
}, 5000);

it.each([
  ["agent", ["roam", "agent", "{}"]],
  ["artifact receiver", ["roam", "artifact", "receive", "{}"]],
])("the private %s never writes an outcome when cleanup fails", async (_kind, argv) => {
  const f = await fixture();
  vi.spyOn(localRuntime, "openLocalRuntime").mockReturnValue({
    agent: {}, config: { role: "box", hubMachineId: HUB, limits: {} }, close() { throw new Error("cleanup failed"); },
  } as never);
  vi.spyOn(agent, "handleAgentOperation").mockResolvedValue({ code: 0, reason: "complete" } as never);
  vi.spyOn(agent, "dispatchArtifactCommand").mockResolvedValue(Buffer.from('{"code":0}'));
  expect(await f.invoke(argv)).toBe(1);
  expect(f.out).toEqual([]);
  expect(f.err.join("")).toContain("Local roaming agent is unavailable");
}, 5000);

it("sync prints a named peer process failure from the hub outcome", async () => {
  const f = await fixture(HUB, { code: 1, reason: "Synchronization needs attention", value: {
    outcomes: [{ code: 1, reason: "Peer command failed (spawn_failed)" }],
  } });
  expect(await f.invoke(["roam", "sync", "--", "-box-1.invalid"])).toBe(1);
  expect(f.err.join("")).toContain("spawn_failed");
}, 5000);

it("remote doctor reports a failed peer process rather than a generic unavailable message", async () => {
  const f = await fixture(), hc = await createClientFixture();
  try {
    for (const key of ["HC_SESSION", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SOCKET", "HERDR_FAKE_ROOT"] as const)
      vi.stubEnv(key, hc.localEnv[key]!);
    vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: hc.hcBinary } } as never);
    const alias = "-box-1.invalid";
    await hc.configure({ machines: [{ id: "remote-core", name: alias, host: "box-1.invalid", target: "box-1.invalid", via: false }],
      roamFixture: { execReplyBase64: Buffer.from('{"version":1}').toString("base64"), execExitCode: 1 } });
    await hc.writeRoamFile(alias, "/fixture/global/roam/machine.json", Buffer.from(JSON.stringify({ machineId: BOX })));
    expect(await f.invoke(["roam", "doctor", "--", alias])).toBe(1);
    expect(f.err.join("")).toContain("Peer command failed (exit 1)");
  } finally { await hc.close(); }
}, 5000);

it("the Mac hub refuses core-only mode before starting placement", async () => {
  const f = await fixture(), close = vi.fn(), app = vi.spyOn(appModule, "createAppClient");
  const hc = vi.spyOn(hcModule, "createHcClient").mockImplementation(() => { throw new Error("core started before mode check"); });
  mkdirSync(join(f.root, "herdr"), { recursive: true });
  writeFileSync(join(f.root, "herdr", "config.json"), JSON.stringify({ mode: "core-only", core: { binary: "/fixture/hc", config: "/fixture/core" }, agentDirectory: "/fixture/agent", globalRoot: f.root, shellRc: "/fixture/rc", machines: [] }));
  vi.spyOn(localRuntime, "openLocalCore").mockReturnValue({ config: { enabled: true, role: "hub" }, close } as never);
  await expect(productionHub.startProductionHub(f.root)).rejects.toThrow("This view is available on the Mac.");
  expect(app.mock.calls.length).toBe(0);
  expect(hc.mock.calls.length).toBe(0);
  expect(close).toHaveBeenCalledOnce();
}, 5000);

it("sync accepts a leading-dash alias after the end-of-options marker", async () => {
  const f = await fixture();
  expect(await f.invoke(["roam", "sync", "--", "-box-1.invalid"])).toBe(0);
  expect(f.calls).toEqual([{ op: "sync", machine: BOX }]);
  expect(f.err).toEqual([]);
}, 5000);

it("sync accepts a leading-dash alias as the explicit machine value", async () => {
  const f = await fixture();
  expect(await f.invoke(["roam", "sync", "--machine", "-box-1.invalid"])).toBe(0);
  expect(f.calls).toEqual([{ op: "sync", machine: BOX }]);
  expect(f.err).toEqual([]);
}, 5000);

it("sync refuses a mismatched local identity before socket dispatch", async () => {
  const f = await fixture(BOX);
  expect(await f.invoke(["roam", "sync", "--", "-box-1.invalid"])).toBe(1);
  expect(f.calls).toEqual([]);
}, 5000);

it("unknown machines and malformed options cannot dispatch a sync", async () => {
  const f = await fixture();
  expect(await f.invoke(["roam", "sync", "--machine", "missing.invalid"])).toBe(2);
  expect(await f.invoke(["roam", "sync", "--machine"])).toBe(2);
  expect(await f.invoke(["roam", "sync", "--bogus"])).toBe(2);
  expect(await f.invoke(["roam", "sync", "--", "-box-1.invalid", "extra"])).toBe(2);
  expect(f.calls).toEqual([]);
}, 5000);
