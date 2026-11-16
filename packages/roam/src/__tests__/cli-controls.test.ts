import { migrate, openDb } from "@spider/db-core";
import * as remoteObservations from "../remote-observations";
import * as diagnostics from "../diagnostics";
import * as launchd from "../launchd";
import { peerEnabledDiagnostics } from "../peer-enabled";
import { openJournal } from "../journal";
import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { main } from "../cli";
import { startHubControl, type HubControlReply, type HubControlRequest } from "../control-socket";
import * as productionHub from "../production-hub";
import * as localRuntime from "../runtime";
import * as agent from "../agent";
import * as transportModule from "../transport";
import * as hosting from "../production-supervisor";
import * as hubRuntime from "../hub";
import * as intercomRuntime from "../intercom-runtime";
import * as localDiagnostics from "../local-diagnostics";
import * as appModule from "@spider/herdr/client/app";
import * as hcModule from "@spider/herdr/client/hc";
import { createClientFixture } from "../../../herdr/src/__tests__/testutil";

const unavailableMove = async (): Promise<never> => { throw new Error("intercom-move-unavailable"); };
const movePort = { bridge: unavailableMove, settlement: unavailableMove, endpoint: unavailableMove, releaseRollbackFence: unavailableMove,
  intake: { close: unavailableMove, drain: unavailableMove, inspect: unavailableMove, checkGeneration: unavailableMove, abort: unavailableMove, ready: unavailableMove } };
const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
const sockets: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close();
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(identity = HUB, reply?: HubControlReply, withSocket = true) {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "r26-")); roots.push(root);
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: identity }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB,
    hubMachineId: HUB, peers: [{ machineId: BOX, alias: "-box-1.invalid", node: "/fixture/node", pi: "/fixture/pi",
      cli: "/fixture/spider", core: "/fixture/core", globalRoot: "/fixture/global" }], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  const calls: HubControlRequest[] = [];
  if (withSocket) {
    const socket = await startHubControl(join(root, "roam", "hub.sock"), async request => {
      calls.push(request);
      return reply ?? { code: 0, reason: "Synchronization complete", value: { outcomes: [] } };
    });
    sockets.push(socket);
  }
  const out: string[] = [], err: string[] = [];
  return { root, calls, out, err, invoke: (args: string[]) => main(args, { out: text => out.push(text), err: text => err.push(text) }) };
}

it("help explains recovery, JSON, non-interactive consent and the forget warning", async () => {
  const f = await fixture(HUB, undefined, false);
  expect(await f.invoke(["--help"])).toBe(0);
  const help = f.out.join("");
  for (const word of ["recover", "cancel", "forget", "claim", "--json", "--yes --consent copilot-auth"]) expect(help).toContain(word);
  expect(help).toMatch(/shell access/i); expect(help).toMatch(/two copies can run/i); expect(help).toMatch(/last mirror/i);
  expect(help).toMatch(/disabled.*not.*(hosting|enable)/i);
}, 5000);

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

it("disabled stop controls only a session and does not permit resume", async () => {
  const f = await fixture(), file = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(file, "utf8"));
  config.enabled = false; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const db = { prepare() { return { get(id: string) { return id === "session-a" ? { machine_id: BOX, epoch: 3 } : undefined; } }; } };
  vi.spyOn(localRuntime, "openLocalCore").mockReturnValue({ root: f.root, db, config: localRuntime.readLocalIdentity(f.root), close() {} } as never);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  const operations: any[] = [];
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    const op = JSON.parse(argv[2]); operations.push(op);
    return Buffer.from(JSON.stringify({ code: 0, reason: "stopped", operationId: op.id, home: null, epoch: 3, repairCommand: null, value: null }));
  } } as never);
  expect(await f.invoke(["roam", "stop", "session-a"])).toBe(0);
  expect(await f.invoke(["roam", "resume", "session-a"])).toBe(1);
  expect(await f.invoke(["roam", "stop", BOX])).toBe(1);
  expect(operations).toEqual([expect.objectContaining({ kind: "session-stop", args: { sourceMachine: HUB, sessionId: "session-a" } })]);
}, 5000);

it("stop JSON returns the production participant refusal and its actual home and epoch", async () => {
  const f = await fixture(), db = { prepare() { return { get() { return { machine_id: BOX, epoch: 3 }; } }; } };
  vi.spyOn(localRuntime, "openLocalCore").mockReturnValue({ root: f.root, db, config: localRuntime.readLocalIdentity(f.root), close() {} } as never);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  const home = { sessionId: "s-1", machineId: BOX, epoch: 5, moveId: null, updatedAt: 123 };
  let operationId = "";
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    operationId = JSON.parse(argv[2]).id;
    return Buffer.from(JSON.stringify({ code: 1, reason: "participant-home-mismatch", operationId, home, epoch: 5, repairCommand: "spider roam doctor", value: null }));
  } } as never);
  expect(await f.invoke(["roam", "stop", "s-1", "--json"])).toBe(1);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ code: 1, reason: "participant-home-mismatch", operationId, home, epoch: 5, repairCommand: "spider roam doctor" });
  expect(operationId).not.toBe("");
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

it("prints and serializes the exact validated blockers and explanation from a real move refusal", async () => {
  const refusal = { code: 1, reason: "move-preflight-blocked", operationId: "move-a", home: null, epoch: null, repairCommand: null, value: null,
    refusal: { code: "move-preflight-blocked", blockers: ["outbound-ask:a8f3", "receipt:abc"], message: "Unsettled work blocks this move." } };
  const f = await fixture(HUB, refusal as HubControlReply);
  expect(await f.invoke(["move", "session-a", "box-1.invalid", "--json"])).toBe(1);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ reason: refusal.reason, operationId: "move-a", refusal: refusal.refusal });
  f.out.length = 0; f.err.length = 0;
  expect(await f.invoke(["move", "session-a", "box-1.invalid"])).toBe(1);
  expect(f.err.join("")).toContain("Unsettled work blocks this move.");
  expect(f.err.join("")).toContain("outbound-ask:a8f3"); expect(f.err.join("")).toContain("receipt:abc");
}, 5000);

it("retains safe worktree adjustments and redacted key names without leaking arbitrary warning text", async () => {
  const reply: HubControlReply = { code: 0, reason: "moved", operationId: "move-a", home: null, epoch: null, repairCommand: null,
    value: { terminal: "terminal-a", intercomAddress: "session-a@box.invalid", warnings: ["tool-auth-unverified", "user.name", "http.<redacted>.extraheader",
      "sparse-cone-defaulted-to-false", "SECRET SENTINEL", "raw:conversation-body"] } };
  const f = await fixture(HUB, reply);
  expect(await f.invoke(["move", "session-a", "box-1.invalid", "--json"])).toBe(0);
  const result = JSON.parse(f.out.join(""));
  expect(result.value.warnings).toEqual(["tool-auth-unverified", "user.name", "http.<redacted>.extraheader", "sparse-cone-defaulted-to-false"]);
  expect(f.out.join("")).not.toContain("SECRET SENTINEL"); expect(f.out.join("")).not.toContain("raw:conversation-body");
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

it("sync JSON retains the real per-peer typed outcomes and receipts", async () => {
  const receipt = { batchId: "batch-a", stream: "stream-a", through: 7, sha256: "a".repeat(64), applyMs: 42 };
  const rows = [
    { code: 0, reason: "pushed", operationId: "push-a", home: null, epoch: null, repairCommand: null, value: receipt },
    { code: 1, reason: "Peer store is quarantined", operationId: "pull-a", home: null, epoch: null, repairCommand: null, value: null },
  ];
  const f = await fixture(HUB, { code: 1, reason: "Synchronization needs attention", value: { outcomes: rows } });
  expect(await f.invoke(["roam", "sync", "--json"])).toBe(1);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ reason: "Synchronization needs attention", value: { outcomes: rows } });
}, 5000);

it("enabled forget JSON includes the recovered homes and presentation status", async () => {
  const home = { sessionId: "s-1", machineId: HUB, epoch: 4, moveId: null, updatedAt: 123 };
  const f = await fixture(HUB, { code: 0, reason: "destroyed-machine-recovered", operationId: "forget-a", home: null, epoch: null, repairCommand: null,
    value: { presentation: "pending", homes: [home] } });
  expect(await f.invoke(["roam", "forget", BOX, "--confirm", `destroyed ${BOX}`, "--json"])).toBe(0);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ reason: "destroyed-machine-recovered", operationId: "forget-a", value: { presentation: "pending", homes: [home] } });
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

it("production hub composes intercom independently from replication peers", async () => {
  const f = await fixture(), agentDir = join(f.root, "agent"); mkdirSync(agentDir, { mode: 0o700 });
  const config = localRuntime.readLocalIdentity(f.root), other = { ...config.peers[0], machineId: "00000000-0000-4000-8000-000000000003", alias: "other.invalid" };
  config.intercom = { enabled: true, mode: "peers", machineAlias: "hub.invalid", protocolFeature: "federation-v1",
    routes: [{ kind: "direct", peer: other, edgeEpoch: "edge-1" }], limits: { queueMessages: 500, queueBytes: 5242880 } };
  const order: string[] = [], bridge = { async start() { order.push("bridge-start"); }, async stop() { order.push("bridge-stop"); },
    diagnostics() { return []; }, move: movePort, readiness() { return { state: "ready" as const, reason: null }; } };
  const factory = vi.spyOn(intercomRuntime, "createMachineIntercom").mockReturnValue(bridge);
  vi.spyOn(localRuntime, "openLocalCore").mockReturnValue({ root: f.root, config, db: {}, close() { order.push("core-close"); } } as never);
  mkdirSync(join(f.root, "herdr"), { mode: 0o700 });
  writeFileSync(join(f.root, "herdr", "config.json"), JSON.stringify({ mode: "full", agentDirectory: agentDir, globalRoot: f.root,
    core: { binary: "/fixture/hc", config: "/fixture/core" }, app: { binary: "/fixture/app", home: "/fixture/home" }, shellRc: "/fixture/rc", spaces: [], machines: [] }), { mode: 0o600 });
  vi.spyOn(localDiagnostics, "createLocalDiagnosticPorts").mockReturnValue({ async probeProcess() { return { kind: "live", startIdentity: "fixture-process" }; } } as never);
  vi.spyOn(hcModule, "createHcClient").mockReturnValue({ async dispose() {} } as never);
  const app = vi.spyOn(appModule, "createAppClient").mockReturnValue({} as never);
  const transport = vi.spyOn(transportModule, "createTransport").mockReturnValue({} as never);
  const hub = vi.spyOn(hubRuntime, "runStandaloneHub").mockImplementation(async ports => {
    await ports.intercom?.start();
    return { async stop() { await ports.intercom?.stop(); }, agentPorts: {} as never };
  });
  const service = await productionHub.startProductionHub(f.root);
  try {
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0][0]).toMatchObject({ root: f.root, agentDir, config: { machineId: HUB } });
    const roamingEnabled = factory.mock.calls[0][0].roamingEnabled;
    expect(roamingEnabled).toBeTypeOf("function");
    expect(roamingEnabled?.()).toBe(true);
    const configFile = join(f.root, "roam/config.json"), raw = JSON.parse(readFileSync(configFile, "utf8"));
    writeFileSync(configFile, JSON.stringify({ ...raw, enabled: false }), { mode: 0o600 });
    expect(roamingEnabled?.()).toBe(false);
    expect(transport.mock.calls.map(([input]) => input.enrolled.map(peer => peer.machineId))).toEqual([[BOX], [other.machineId]]);
    expect(hub.mock.calls[0][0].intercom).toMatchObject({ move: bridge.move });
    expect(hub.mock.calls[0][0].intercom?.readiness?.()).toEqual(bridge.readiness?.());
    expect(app).toHaveBeenCalledOnce();
    expect(order).toEqual(["bridge-start"]);
  } finally { await service.stop(); }
  expect(order).toEqual(["bridge-start", "bridge-stop", "core-close"]);
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

it("disabled local doctor prints one line without inspecting move bindings", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = false; config.peers = [];
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const doctor = vi.spyOn(localDiagnostics, "runLocalDoctor");
  expect(await f.invoke(["roam", "doctor"])).toBe(0);
  expect(f.out.join("")).toBe("Roaming is disabled.\n"); expect(f.err).toEqual([]);
  expect(doctor).not.toHaveBeenCalled();
}, 5000);

it("disabled local doctor adds only real peer flag mismatches", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = false; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createTransport").mockReturnValue({} as never);
  vi.spyOn(remoteObservations, "remoteDoctor").mockResolvedValue({ enabled: true, diagnostics: [], consumers: [] });
  expect(await f.invoke(["roam", "doctor"])).toBe(0);
  expect(f.out.join("").trim().split("\n")).toEqual(["Roaming is disabled.", `peer-enabled-mismatch:${BOX}`]);
  expect(f.out.join("")).not.toContain("adapter-unbound");
}, 5000);

it("enabled doctor summarizes an absent move-binding inventory once", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.peers = [];
  config.intercom = { enabled: true, mode: "hub-only", machineAlias: "hub.invalid", protocolFeature: "federation-v1", routes: [] };
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  expect(localRuntime.readLocalIdentity(f.root).intercom.enabled).toBe(true);
  vi.spyOn(localDiagnostics, "runLocalDoctor").mockResolvedValue({ enabled: true, diagnostics: [], consumers: [] });
  const code = await f.invoke(["roam", "doctor"]);
  expect(code, `stdout: ${f.out.join("")} stderr: ${f.err.join("")}`).toBe(0);
  expect(f.out.join("")).toContain("move-binding-inventory-unavailable");
  expect(f.out.join("")).not.toContain("adapter-unbound:");
}, 5000);

it("enabled doctor does not claim intercom move readiness when federation is disabled", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.peers = []; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  vi.spyOn(localDiagnostics, "runLocalDoctor").mockResolvedValue({ enabled: true, diagnostics: [], consumers: [] });
  expect(await f.invoke(["roam", "doctor"])).toBe(1);
  expect(f.out.join("")).toContain("intercom-move-port-unavailable");
}, 5000);

it("doctor JSON returns its real report rows instead of scraping selected stdout lines", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.peers = [];
  config.intercom = { enabled: true, mode: "hub-only", machineAlias: "hub.invalid", protocolFeature: "federation-v1", routes: [] };
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const diagnostic = { reason: "pi-auth-missing: Pi sign-in is unverified.", severity: "block" as const, repairCommand: null };
  vi.spyOn(localDiagnostics, "runLocalDoctor").mockResolvedValue({ enabled: true, diagnostics: [diagnostic], consumers: [] });
  expect(await f.invoke(["roam", "doctor", "--json"])).toBe(1);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ code: 1, value: { enabled: true, diagnostics: [diagnostic,
    { reason: "move-binding-inventory-unavailable", severity: "warning", repairCommand: "spider roam doctor" }] } });
}, 5000);

it.each([["roam", "forget", "box-1.invalid"], ["roam", "forget", "box-1.invalid", "--confirm", "destroyed wrong"]])
("forget warns before rejecting missing or wrong confirmation: %j", async (...args) => {
  const f = await fixture(HUB, undefined, true), file = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(file, "utf8"));
  config.peers[0].alias = "box-1.invalid"; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  expect(await f.invoke(args)).toBe(2);
  expect(f.err.join("")).toMatch(/two copies can run/i); expect(f.err.join("")).toMatch(/last mirror/i);
  expect(f.calls).toEqual([]);
}, 5000);

it("normalizes an explicitly confirmed box alias to the enrolled UUID before forget", async () => {
  const f = await fixture(), file = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(file, "utf8"));
  config.peers[0].alias = "box-1.invalid"; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  expect(await f.invoke(["roam", "forget", "box-1.invalid", "--confirm", "destroyed box-1.invalid"])).toBe(0);
  expect(f.calls).toContainEqual({ op: "forget", machine: "box-1.invalid", confirmation: `destroyed ${BOX}` });
}, 5000);

it("disabled forget invokes only the confirmed typed port and returns its real pending presentation", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(file, "utf8"));
  config.enabled = false; config.peers[0].alias = "box-1.invalid"; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const home = { sessionId: "s-1", machineId: HUB, epoch: 4, moveId: null, updatedAt: 123 };
  const actual: import("../move-ports").AdapterMachineRecoveryOutcome = { ok: true, code: 0, operationId: "forget-a", reason: "destroyed-machine-recovered", presentation: "pending", value: [home],
    results: [{ sessionId: home.sessionId, code: 0, reason: "restored", home, presentation: "pending", repairCommand: null }] };
  const calls: Array<{ machine: string; confirmed: true }> = [];
  const runDisabledForget = async (input: { machine: string; confirmed: true }): Promise<typeof actual> => { calls.push(input); return actual; };
  expect(await main(["roam", "forget", "box-1.invalid", "--confirm", "destroyed box-1.invalid", "--json"],
    { out: text => f.out.push(text), err: text => f.err.push(text) }, { runDisabledForget })).toBe(0);
  expect(calls).toEqual([{ machine: BOX, confirmed: true }]);
  expect(JSON.parse(f.out.join(""))).toEqual(actual);
}, 5000);

it("disabled forget prints the exact pending launch command instead of hiding it behind doctor", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(file, "utf8"));
  config.enabled = false; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const repairCommand = "cd '/fixture/workspace' && 'pi' --session '/fixture/session.jsonl'";
  const actual: import("../move-ports").AdapterMachineRecoveryOutcome = { ok: false, code: 3, operationId: "forget-a", reason: "recovery-launch-pending", value: null, recovered: [],
    results: [{ sessionId: "s-1", code: 3, reason: "recovery-launch-pending", home: null, presentation: null, repairCommand }] };
  expect(await main(["roam", "forget", BOX, "--confirm", `destroyed ${BOX}`], { out: text => f.out.push(text), err: text => f.err.push(text) }, { runDisabledForget: async () => actual })).toBe(3);
  expect(f.err.join("")).toContain(repairCommand);
  expect(f.calls).toEqual([]);
}, 5000);

it.each(["hub-running", "not-disabled"] as const)("disabled forget returns the port's %s refusal unchanged", async reason => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(file, "utf8"));
  config.enabled = false; config.peers[0].alias = "box-1.invalid"; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const actual = { ok: false as const, reason }, runDisabledForget: import("../disabled-forget-contract").RunDisabledForget = async () => actual;
  expect(await main(["roam", "forget", "box-1.invalid", "--confirm", `destroyed ${BOX}`, "--json"],
    { out: text => f.out.push(text), err: text => f.err.push(text) }, { runDisabledForget })).toBe(1);
  expect(JSON.parse(f.out.join(""))).toEqual(actual);
}, 5000);

it("disable is a verified no-op on a never-enabled hub", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...config, enabled: false, peers: [] }), { mode: 0o600 });
  expect(await f.invoke(["roam", "disable"])).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
  expect(existsSync(join(f.root, "roam/journal.db"))).toBe(false);
  expect(f.out.join("")).toMatch(/disabled|already off/i);
  expect(f.out.join("")).toContain("Reload open pi sessions (/reload) to pick up /move.");
  expect(f.out.join("")).not.toContain("reload automatically");
}, 5000);

it("disable completes interrupted service removal and retries each box flag", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.enabled = false; config.peers[0].alias = "box-1.invalid";
  const other = { ...config.peers[0], machineId: "00000000-0000-4000-8000-000000000003", alias: "box-2.invalid" };
  config.peers.push(other); writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  openJournal(join(f.root, "roam/journal.db"));
  const plist = join(f.root, "Library/LaunchAgents/com.spider.roam.hub.plist");
  mkdirSync(join(f.root, "Library/LaunchAgents"), { recursive: true }); writeFileSync(plist, "fixture");
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 }); vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl);
  const removal = vi.spyOn(launchd, "removeHubService").mockImplementation(async () => { unlinkSync(plist); });
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  const requests: Record<string, unknown>[] = [];
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: { async resolve(peer: unknown) { return peer; } }, async executeProvision(peer: { machineId: string }, request: Record<string, unknown>) {
    requests.push(request); if (peer.machineId === other.machineId) throw new Error("offline"); return { enabled: request.enabled };
  } } as never);
  expect(await f.invoke(["roam", "disable"])).toBe(0);
  expect(removal).toHaveBeenCalledOnce(); expect(existsSync(plist)).toBe(false);
  expect(requests.map(request => [request.machineId, request.enabled])).toEqual([[BOX, false], [other.machineId, false]]);
  expect(f.out.join("")).toContain("box-2.invalid");
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
}, 5000);

it("disable leaves the enabled flag on when hub-service removal fails", async () => {
  const f = await fixture(), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.peers = []; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const plist = join(f.root, "Library/LaunchAgents/com.spider.roam.hub.plist");
  mkdirSync(join(f.root, "Library/LaunchAgents"), { recursive: true }); writeFileSync(plist, "fixture");
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 }); vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl);
  vi.spyOn(launchd, "removeHubService").mockRejectedValue(new Error("service removal failed"));
  expect(await f.invoke(["roam", "disable"])).toBe(3);
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(true);
  expect(existsSync(plist)).toBe(true);
}, 5000);

it.each([true, false])("Mac disable propagates to a reachable box and retains an unreachable flag (reachable: %s)", async reachable => {
  const f = await fixture(), requests: Record<string, unknown>[] = [];
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: { async resolve(peer: unknown) { return peer; } }, async executeProvision(_peer: unknown, request: Record<string, unknown>) {
    requests.push(request); if (!reachable) throw new Error("offline"); return { enabled: request.enabled };
  } } as never);
  expect(await f.invoke(["roam", "disable"])).toBe(0);
  expect(JSON.parse(readFileSync(join(f.root, "roam/config.json"), "utf8")).enabled).toBe(false);
  expect(requests).toEqual([expect.objectContaining({ action: "roaming-enabled", machineId: BOX, hubMachineId: HUB, enabled: false })]);
  if (!reachable) expect(f.out.join("")).toContain("unconfirmed");
  expect(await f.invoke(["move", "session-a", "box"])).toBe(1);
  expect(f.err.join("")).toContain("roaming-disabled");
}, 5000);
it("enable reports every box precondition before changing capture or flags", async () => {
  const f = await fixture(HUB, { code: 0, reason: "ready", value: { enabled: true } }), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = false; config.peers[0].alias = "box-1.invalid";
  const other = { ...config.peers[0], machineId: "00000000-0000-4000-8000-000000000003", alias: "box-2.invalid" };
  config.peers.push(other); writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const db = openDb(join(f.root, "spider.db")); migrate(db, "global", { machineId: HUB, globalRoot: f.root }); db.close();
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 }); vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(diagnostics, "assertCompatibleConsumers").mockResolvedValue(undefined);
  const service = vi.spyOn(launchd, "installHubService").mockResolvedValue(undefined), operations: string[] = [], starts: string[] = [], flags: unknown[] = [];
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(peer: { machineId: string }, argv: string[]) {
    if (argv[1] === "intercom") { starts.push(peer.machineId); return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-broker-start", ok: true, machineId: peer.machineId })); }
    const op = JSON.parse(argv[2]); operations.push(op.kind);
    if (peer.machineId === other.machineId) throw new Error("offline");
    return Buffer.from(JSON.stringify({ operationId: op.id, code: 0, value: op.kind === "stores" ? { protocol: 1, schema: 14, machineId: BOX, stores: ["global"] } : { complete: true } }));
  } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: { async resolve(peer: unknown) { return peer; } }, async executeProvision(_peer: unknown, request: unknown) { flags.push(request); return { enabled: true }; } } as never);
  const doctor = vi.spyOn(remoteObservations, "remoteDoctor").mockImplementation(async (_transport, peer) => {
    if (peer.machineId === other.machineId) throw new Error("offline");
    return { enabled: false, diagnostics: [
      { severity: "warning", reason: "intercom-other-extension: ordinary-extension (not classified for intercom).", repairCommand: null },
      { severity: "block", reason: "pi-auth-missing", repairCommand: null },
      { severity: "block", reason: "intercom-federation: federation-feature-missing.", repairCommand: null },
      { severity: "block", reason: "local machine: Bundled SQLite must be at least 3.42 for roaming capture.", repairCommand: null },
    ], consumers: [] };
  });
  expect(await f.invoke(["roam", "enable"])).toBe(1);
  expect(f.err.join("")).toContain("ordinary-extension");
  expect(f.err.join("")).toContain("preflight-failed:box-1.invalid:pi-auth-missing");
  expect(f.err.join("")).toContain("preflight-failed:box-1.invalid:intercom-federation");
  expect(f.err.join("")).toContain("preflight-failed:box-1.invalid:intercom-broker");
  expect(f.err.join("")).toContain("preflight-failed:box-1.invalid:sqlite-bundled");
  expect(f.err.join("")).toContain("box-unreachable:box-2.invalid");
  expect(f.err.join("")).toContain("spider roam provision box-1.invalid");
  expect(f.err.join("")).toContain("spider roam forget box-2.invalid");
  expect(starts).toEqual([]);
  expect(operations).not.toContain("enable-capture"); expect(operations).not.toContain("recheck-store");
  expect(flags).toEqual([]); expect(service).not.toHaveBeenCalled();
  expect(doctor).toHaveBeenCalled();
  const after = openDb(join(f.root, "spider.db"));
  try { expect(after.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 }); } finally { after.close(); }
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
}, 5000);

it("reports pending enable before flags or capture if a broker cannot start after preflight", async () => {
  const f = await fixture(HUB, { code: 0, reason: "ready", value: { enabled: true } }), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = false; config.peers[0].alias = "box-1.invalid"; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const db = openDb(join(f.root, "spider.db")); migrate(db, "global", { machineId: HUB, globalRoot: f.root }); db.close();
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 }); vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  const operations: string[] = [], flags: unknown[] = [], service = vi.spyOn(launchd, "installHubService").mockResolvedValue(undefined);
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    if (argv[1] === "intercom") throw new Error("fixture spawn failure");
    const op = JSON.parse(argv[2]); operations.push(op.kind);
    return Buffer.from(JSON.stringify({ operationId: op.id, code: 0, value: { protocol: 1, schema: 14, machineId: BOX, stores: ["global"] } }));
  } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: {}, async executeProvision(_p: unknown, request: unknown) { flags.push(request); } } as never);
  vi.spyOn(remoteObservations, "remoteDoctor").mockResolvedValue({ enabled: false, diagnostics: [], consumers: [] });
  vi.spyOn(diagnostics, "assertCompatibleConsumers").mockResolvedValue(undefined);
  expect(await f.invoke(["roam", "enable", "--json"])).toBe(3);
  const result = JSON.parse(f.out.join(""));
  expect(result.reason).toBe("preflight-failed:box-1.invalid:intercom-broker");
  expect(result.value.issues).toContainEqual({ reason: result.reason, repairCommand: "spider roam doctor box-1.invalid" });
  expect(operations).toEqual(["stores"]); expect(flags).toEqual([]); expect(service).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
}, 5000);

it("explicit Mac enable requires box preflight before authorizing its flag", async () => {
  const f = await fixture(HUB, { code: 0, reason: "ready", value: { enabled: true } }), requests: Record<string, unknown>[] = [];
  const file = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(file, "utf8")); writeFileSync(file, JSON.stringify({ ...config, enabled: false }), { mode: 0o600 });
  const db = openDb(join(f.root, "spider.db")); migrate(db, "global", { machineId: HUB, globalRoot: f.root }); db.close();
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 }); vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(diagnostics, "assertCompatibleConsumers").mockResolvedValue(undefined);
  vi.spyOn(launchd, "installHubService").mockResolvedValue(undefined);
  const starts: string[] = [];
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    if (argv[1] === "intercom") { starts.push(BOX); return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-broker-start", ok: true, machineId: BOX })); }
    const op = JSON.parse(argv[2]); return Buffer.from(JSON.stringify({ operationId: op.id, code: 0, value: op.kind === "stores" ? { protocol: 1, schema: 14, machineId: BOX, stores: ["global"] } : { complete: true } }));
  } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: { async resolve(peer: unknown) { return peer; } }, async executeProvision(_peer: unknown, request: Record<string, unknown>) { requests.push(request); return { enabled: request.enabled }; } } as never);
  const doctor = vi.spyOn(remoteObservations, "remoteDoctor").mockResolvedValue({ enabled: false, diagnostics: [{ severity: "block", reason: "fixture-preflight", repairCommand: null }], consumers: [] });
  expect(await f.invoke(["roam", "enable"])).not.toBe(0); expect(requests).toEqual([]);
  doctor.mockResolvedValue({ enabled: false, diagnostics: [{ severity: "warning", reason: "intercom-other-extension: ordinary-extension (not classified for intercom).", repairCommand: null }], consumers: [] });
  expect(await f.invoke(["roam", "enable"])).toBe(0);
  expect(f.out.join("")).toContain("ordinary-extension");
  expect(f.out.join("")).toContain("Reload open pi sessions (/reload) to pick up /move.");
  expect(f.out.join("")).not.toContain("reload automatically");
  expect(starts).toEqual([BOX]);
  expect(requests).toEqual([expect.objectContaining({ action: "roaming-enabled", enabled: true, machineId: BOX, hubMachineId: HUB })]);
}, 5000);
it("doctor reports enabled flag drift and preserves both configurations", async () => {
  const f = await fixture(), config = localRuntime.readLocalIdentity(f.root), before = readFileSync(join(f.root, "roam/config.json"), "utf8");
  vi.spyOn(remoteObservations, "remoteDoctor").mockResolvedValue({ enabled: false, diagnostics: [], consumers: [] });
  expect(await peerEnabledDiagnostics(config, {} as never)).toEqual([{ reason: `peer-enabled-mismatch:${BOX}`, severity: "warning", repairCommand: "spider roam enable" }]);
  vi.mocked(remoteObservations.remoteDoctor).mockResolvedValue({ enabled: true, diagnostics: [], consumers: [] });
  expect(await peerEnabledDiagnostics({ ...config, enabled: false }, {} as never)).toEqual([{ reason: `peer-enabled-mismatch:${BOX}`, severity: "warning", repairCommand: "spider roam disable" }]);
  expect(readFileSync(join(f.root, "roam/config.json"), "utf8")).toBe(before);
}, 5000);
