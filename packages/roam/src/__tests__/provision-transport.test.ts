import { afterEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import * as bytesClient from "../../../herdr/src/client/bytes";
import * as coreClient from "../../../herdr/src/client/hc";
import * as liveness from "../../../herdr/src/client/liveness";
import { HerdrError } from "../../../herdr/src/client/parse";
import * as transportModule from "../transport";
import { BOOTSTRAP_AGENT_DIRECTORY_SCRIPT, BOOTSTRAP_SCRIPT } from "../bootstrap-script";
import type { Journal, Peer, Transport } from "../contracts";
import { bootstrapPeer, inventoryEnvelope } from "./bootstrap-fixture";

type CoreFence = { local: string; remote: string };
const coreFence: CoreFence = { local: "local-core", remote: "remote-core" };
type ProvisionTransport = { transport: Transport; probeAgentDirectory(peer: Peer, home: string): Promise<{ status: "default" | "custom" | "unknown"; core: CoreFence }>;
  claimIdentity(peer: Peer, operationId: string, core: CoreFence): Promise<{ machineId: string; coreId: string }>;
  executeProvision(peer: Peer, request: Record<string, unknown>): Promise<unknown>;
  launchRelease(peer: Peer, operationId: string, requestFile: string): Promise<{ terminal: string }> };
type Factory = (options: { binary: string; env: Readonly<NodeJS.ProcessEnv>; enrolled: readonly Peer[] }, journal: Journal) => ProvisionTransport;
const create = (transportModule as typeof transportModule & { createProvisionTransport?: Factory }).createProvisionTransport;

afterEach(() => { vi.restoreAllMocks(); });

function fixture() {
  const actions: { action: string; result: Parameters<Journal["record"]>[2] }[] = [];
  const calls: { argv: readonly string[]; stdin?: Buffer }[] = [], controlCalls: (readonly string[])[] = [], events: string[] = [];
  const state = { remoteCore: "remote-core", replaceDuringCall: false,
    reply: { version: 1, kind: "identity", coreId: "remote-core", machineId: bootstrapPeer.machineId } as Record<string, unknown>,
    provisionReply: { version: 1, kind: "provision", value: true } as Record<string, unknown>, provisionError: null as Error | null,
    agentDirectoryReply: { version: 1, kind: "agent-directory", value: "default" } as Record<string, unknown>,
    runError: null as Error | null };
  const journal: Journal = {
    begin() { return { kind: "pending", result: null }; },
    record(_id, action, result) { actions.push({ action, result }); },
    read() { return actions; },
  };
  vi.spyOn(liveness, "requireCoreAvailable").mockResolvedValue(undefined);
  vi.spyOn(coreClient, "invokeCli").mockImplementation(async (_binary, argv) => {
    events.push(argv[0]); controlCalls.push(argv);
    if (argv[0] === "run") { if (state.runError) throw state.runError; return { address: "box-1.invalid/t1" }; }
    return argv[0] === "server" ? { core: { id: "local-core" }, version: "0.1.16" }
      : { machines: [{ name: bootstrapPeer.alias, id: state.remoteCore }] };
  });
  vi.spyOn(bytesClient, "invokeBytes").mockImplementation(async (_binary, argv, _env, options) => {
    calls.push({ argv, stdin: options.stdin && Buffer.from(options.stdin) }); events.push("identity");
    if (argv.includes("cat")) return Buffer.from(JSON.stringify({ machineId: bootstrapPeer.machineId }));
    if (state.replaceDuringCall) state.remoteCore = "replacement-core";
    if (argv.includes(BOOTSTRAP_AGENT_DIRECTORY_SCRIPT)) return Buffer.from(JSON.stringify(state.agentDirectoryReply));
    if (argv.includes(BOOTSTRAP_SCRIPT)) return Buffer.from(JSON.stringify(inventoryEnvelope()));
    const request = JSON.parse(options.stdin!.toString("utf8")) as { action?: string };
    if (request.action && state.provisionError) throw state.provisionError;
    return Buffer.from(JSON.stringify(request.action ? state.provisionReply : state.reply));
  });
  const fixtureRoot = process.env.SPIDER_GLOBAL_ROOT;
  if (!fixtureRoot) throw new Error("Fixture global root is required");
  const options = { binary: "/fixture/hc", env: { HC_SOCKET: resolve(fixtureRoot, "provision-fixture.sock"), HC_SESSION: "fixture" }, enrolled: [bootstrapPeer] };
  const consent = (peer: Peer = bootstrapPeer) => journal.record("op-1", "provision-consent", { target: peer.alias, machineId: peer.machineId, approved: true, providers: [] });
  return { actions, calls, controlCalls, events, state, journal, options, consent };
}

it("checks the target agent directory read-only before enrollment and rejects untrusted replies", async () => {
  const f = fixture(), port = create!(f.options, f.journal);
  expect(port.probeAgentDirectory).toBeTypeOf("function");
  expect(await port.probeAgentDirectory(bootstrapPeer, "/home/fixture")).toEqual({ status: "default", core: coreFence });
  const call = f.calls.at(-1)!;
  expect(call.argv).toContain(BOOTSTRAP_AGENT_DIRECTORY_SCRIPT);
  expect(JSON.parse(call.stdin!.toString("utf8"))).toEqual({ home: "/home/fixture" });
  expect(f.events.slice(-5)).toEqual(["server", "machine", "identity", "server", "machine"]);
  f.state.agentDirectoryReply = { version: 1, kind: "agent-directory", value: "custom" };
  expect(await port.probeAgentDirectory(bootstrapPeer, "/home/fixture")).toEqual({ status: "custom", core: coreFence });
  f.state.agentDirectoryReply = { version: 1, kind: "agent-directory", value: "fixture-secret" };
  await expect(port.probeAgentDirectory(bootstrapPeer, "/home/fixture")).rejects.toMatchObject({ code: "invalid-bootstrap-reply" });
  const before = f.calls.length;
  await expect(port.probeAgentDirectory(bootstrapPeer, "relative")).rejects.toMatchObject({ code: "invalid-bootstrap-request" });
  expect(f.calls).toHaveLength(before);
  f.state.agentDirectoryReply = { version: 1, kind: "agent-directory", value: "default" }; f.state.replaceDuringCall = true;
  await expect(port.probeAgentDirectory(bootstrapPeer, "/home/fixture")).rejects.toMatchObject({ code: "core-changed" });
}, 5000);

it("refuses a core replacement between the directory probe, inventory, and identity claim", async () => {
  const f = fixture(), port = create!(f.options, f.journal), probe = await port.probeAgentDirectory(bootstrapPeer, "/home/fixture");
  expect(probe).toEqual({ status: "default", core: coreFence });
  expect(await port.transport.bootstrapProbe(bootstrapPeer, "inventory", { timeoutMs: 1000, maxBytes: 65536, expectedCore: probe.core })).toEqual(inventoryEnvelope().value);
  f.consent(); f.state.remoteCore = "replacement-core"; const before = f.calls.length;
  await expect(port.claimIdentity(bootstrapPeer, "op-1", probe.core)).rejects.toMatchObject({ code: "core-changed" });
  await expect(port.transport.bootstrapProbe(bootstrapPeer, "inventory", { timeoutMs: 1000, maxBytes: 65536, expectedCore: probe.core })).rejects.toMatchObject({ code: "core-changed" });
  expect(f.calls).toHaveLength(before);
}, 5000);

it("does not resolve a different core after claiming an identity", async () => {
  const f = fixture(); f.consent(); const port = create!(f.options, f.journal);
  await port.claimIdentity(bootstrapPeer, "op-1", coreFence);
  f.state.remoteCore = "replacement-core";
  await expect(port.transport.resolve(bootstrapPeer)).rejects.toMatchObject({ code: "core-changed" });
  const before = f.calls.length;
  await expect(port.transport.bootstrapProbe(bootstrapPeer, "inventory")).rejects.toMatchObject({ code: "core-changed" });
  expect(f.calls).toHaveLength(before);
}, 5000);

it("launches only a consented release in a labelled outliving background terminal", async () => {
  const f = fixture(), port = create!(f.options, f.journal), handle = await port.transport.resolve(bootstrapPeer);
  const request = `${bootstrapPeer.globalRoot}/roam/provision/op-1/release-request`;
  await expect(port.launchRelease(handle, "op-1", request)).rejects.toMatchObject({ code: "consent-required" });
  f.consent(); expect(await port.launchRelease(handle, "op-1", request)).toEqual({ terminal: "box-1.invalid/t1" });
  const argv = f.controlCalls.find(call => call[0] === "run")!;
  expect(argv).toEqual(expect.arrayContaining(["--bg", "--no-notify", "--outlive-parent", "--no-parent", "--label", "spider.operation=op-1", `spider.machine=${bootstrapPeer.machineId}`]));
  expect(argv.at(-1)).toBe(request);
  expect(f.events.slice(-5)).toEqual(["server", "machine", "run", "server", "machine"]);
  await expect(port.launchRelease(handle, "op-1", `${request}-other`)).rejects.toMatchObject({ code: "invalid-provision-request" });
  await expect(port.executeProvision(handle, { action: "release", operationId: "op-1", machineId: bootstrapPeer.machineId,
    globalRoot: bootstrapPeer.globalRoot, node: bootstrapPeer.node, cli: bootstrapPeer.cli, pi: bootstrapPeer.pi })).rejects.toMatchObject({ code: "invalid-provision-request" });
}, 5000);

it("reconciles an uncertain launch using a validated core-fenced receipt", async () => {
  const f = fixture(); f.consent(); const port = create!(f.options, f.journal), handle = await port.transport.resolve(bootstrapPeer);
  f.state.runError = new Error("fixture launch response lost");
  const requestFile = `${bootstrapPeer.globalRoot}/roam/provision/op-1/release-request`;
  await expect(port.launchRelease(handle, "op-1", requestFile)).rejects.toMatchObject({ code: "release-launch-uncertain" });
  const value = { pi: bootstrapPeer.pi, cli: bootstrapPeer.cli, supervisor: "/home/fixture/.local/supervisor.mjs" };
  f.state.provisionReply = { version: 1, kind: "provision", value: { state: "finished", value } };
  const request = { action: "release-observe", operationId: "op-1", machineId: bootstrapPeer.machineId, globalRoot: bootstrapPeer.globalRoot,
    node: bootstrapPeer.node, cli: bootstrapPeer.cli, pi: bootstrapPeer.pi, supervisor: value.supervisor };
  expect(await port.executeProvision(handle, request)).toEqual({ state: "finished", value });
  expect(f.controlCalls.filter(call => call[0] === "run")).toHaveLength(1);
  expect(f.events.slice(-5)).toEqual(["server", "machine", "identity", "server", "machine"]);
  f.state.provisionReply = { version: 1, kind: "provision", value: { state: "finished", value: { ...value, cli: "/different" } } };
  await expect(port.executeProvision(handle, request)).rejects.toMatchObject({ code: "invalid-provision-reply" });
}, 5000);

it("fences an enrolled installer and sends sensitive request data only on stdin", async () => {
  const f = fixture(), port = create!(f.options, f.journal), handle = await port.transport.resolve(bootstrapPeer);
  const request = { action: "secret-chunk", operationId: "op-1", machineId: bootstrapPeer.machineId, globalRoot: bootstrapPeer.globalRoot,
    node: bootstrapPeer.node, cli: bootstrapPeer.cli, pi: bootstrapPeer.pi, data: Buffer.from("fixture-secret").toString("base64") };
  await expect(port.executeProvision(handle, request)).rejects.toMatchObject({ code: "consent-required" });
  f.consent();
  expect(await port.executeProvision(handle, request)).toBe(true);
  const call = f.calls.at(-1)!;
  expect(JSON.parse(call.stdin!.toString("utf8"))).toEqual({ ...request, core: bootstrapPeer.core, coreId: "remote-core" });
  expect(call.argv).toContain("--stdin");
  const seconds = Number(call.argv[call.argv.indexOf("--timeout") + 1]);
  expect(call.argv).toContain("--timeout"); expect(Number.isInteger(seconds) && seconds > 0).toBe(true);
  expect(JSON.stringify(call.argv)).not.toContain("fixture-secret");
  expect(JSON.stringify(call.argv)).not.toContain(request.data);
  expect(f.events.slice(-5)).toEqual(["server", "machine", "identity", "server", "machine"]);
}, 5000);

it("preserves cli-timeout for a bounded provisioning write", async () => {
  const f = fixture(); f.consent(); const port = create!(f.options, f.journal), handle = await port.transport.resolve(bootstrapPeer);
  f.state.provisionError = new HerdrError("cli-timeout", "fixture-secret");
  await expect(port.executeProvision(handle, { action: "secret-chunk", operationId: "op-1", machineId: bootstrapPeer.machineId,
    globalRoot: bootstrapPeer.globalRoot, node: bootstrapPeer.node, cli: bootstrapPeer.cli, pi: bootstrapPeer.pi }))
    .rejects.toMatchObject({ code: "cli-timeout" });
}, 5000);

it("redacts untrusted transport error codes and details", async () => {
  const f = fixture(); f.consent(); const port = create!(f.options, f.journal), handle = await port.transport.resolve(bootstrapPeer);
  f.state.provisionError = Object.assign(new Error("fixture-secret"), { code: "fixture-secret", details: { stderr: "fixture-secret" } });
  let caught: unknown;
  try { await port.executeProvision(handle, { action: "secret-chunk", operationId: "op-1", machineId: bootstrapPeer.machineId,
    globalRoot: bootstrapPeer.globalRoot, node: bootstrapPeer.node, cli: bootstrapPeer.cli, pi: bootstrapPeer.pi }); } catch (error) { caught = error; }
  expect(caught).toBeTruthy();
  expect(String(caught)).not.toContain("fixture-secret");
  expect(JSON.stringify(caught)).not.toContain("fixture-secret");
}, 5000);

it("invalidates a handle when a destination core self-check changes", async () => {
  const f = fixture(); f.consent(); const port = create!(f.options, f.journal), handle = await port.transport.resolve(bootstrapPeer);
  f.state.provisionReply = { version: 1, kind: "provision", error: "core-changed" };
  const request = { action: "release-observe", operationId: "op-1", machineId: bootstrapPeer.machineId,
    globalRoot: bootstrapPeer.globalRoot, node: bootstrapPeer.node, cli: bootstrapPeer.cli, pi: bootstrapPeer.pi };
  await expect(port.executeProvision(handle, request)).rejects.toMatchObject({ code: "core-changed" });
  const count = f.calls.length;
  await expect(port.executeProvision(handle, request)).rejects.toMatchObject({ code: "core-changed" });
  expect(f.calls).toHaveLength(count);
}, 5000);

it("discards installer results when the permanent core changes", async () => {
  const f = fixture(); f.consent(); const port = create!(f.options, f.journal), handle = await port.transport.resolve(bootstrapPeer);
  f.state.replaceDuringCall = true;
  await expect(port.executeProvision(handle, { action: "cleanup", operationId: "op-1", machineId: bootstrapPeer.machineId,
    globalRoot: bootstrapPeer.globalRoot, node: bootstrapPeer.node, cli: bootstrapPeer.cli, pi: bootstrapPeer.pi })).rejects.toMatchObject({ code: "core-changed" });
}, 5000);

it("never contacts hc without consent recorded for this identity and target", async () => {
  expect(create).toBeTypeOf("function");
  const f = fixture(), port = create!(f.options, f.journal);
  await expect(port.claimIdentity(bootstrapPeer, "op-1", coreFence)).rejects.toMatchObject({ code: "consent-required" });
  f.consent({ ...bootstrapPeer, alias: "box-2.invalid" });
  await expect(port.claimIdentity(bootstrapPeer, "op-1", coreFence)).rejects.toMatchObject({ code: "consent-required" });
  expect(f.events).toEqual([]);
  expect(f.calls).toEqual([]);
}, 5000);

it("pins the core ID in the request and verifies the returned identity", async () => {
  expect(create).toBeTypeOf("function");
  const f = fixture(); f.consent(); const port = create!(f.options, f.journal);
  await expect(port.claimIdentity(bootstrapPeer, "op-1", coreFence)).resolves.toEqual({ machineId: bootstrapPeer.machineId, coreId: "remote-core" });
  expect(f.events).toEqual(["server", "machine", "identity", "server", "machine"]);
  expect(f.calls).toHaveLength(1);
  const request = JSON.parse(f.calls[0].stdin!.toString("utf8"));
  expect(request).toEqual({ globalRoot: bootstrapPeer.globalRoot, machineId: bootstrapPeer.machineId, core: bootstrapPeer.core, coreId: "remote-core", operationId: "op-1" });
  const argv = f.calls[0].argv, program = argv[argv.indexOf("--") + 4];
  expect(argv).toContain("--stdin");
  expect(program).not.toContain(bootstrapPeer.alias);
  expect(program).not.toContain(bootstrapPeer.globalRoot);
  await expect(port.transport.exec(bootstrapPeer, ["status"], { timeoutMs: 1000, maxBytes: 1024 })).rejects.toMatchObject({ code: "unresolved-peer" });
}, 5000);

it("discards a reply for a different core or machine identity", async () => {
  expect(create).toBeTypeOf("function");
  const f = fixture(); f.consent(); const port = create!(f.options, f.journal);
  f.state.reply.coreId = "other-core";
  await expect(port.claimIdentity(bootstrapPeer, "op-1", coreFence)).rejects.toMatchObject({ code: "core-changed" });
  f.state.reply.coreId = "remote-core"; f.state.reply.machineId = "22222222-2222-4222-8222-222222222222";
  await expect(port.claimIdentity(bootstrapPeer, "op-1", coreFence)).rejects.toMatchObject({ code: "machine-mismatch" });
}, 5000);

it("discards the receipt if the core changes during the call", async () => {
  expect(create).toBeTypeOf("function");
  const f = fixture(); f.consent(); f.state.replaceDuringCall = true;
  await expect(create!(f.options, f.journal).claimIdentity(bootstrapPeer, "op-1", coreFence)).rejects.toMatchObject({ code: "core-changed" });
  expect(f.events).toEqual(["server", "machine", "identity", "server", "machine"]);
}, 5000);

it("returns a named identity conflict without leaking remote details", async () => {
  expect(create).toBeTypeOf("function");
  const f = fixture(); f.consent(); f.state.reply = { version: 1, kind: "identity", error: "machine-mismatch" };
  await expect(create!(f.options, f.journal).claimIdentity(bootstrapPeer, "op-1", coreFence)).rejects.toMatchObject({ code: "machine-mismatch" });
  expect(JSON.stringify(f.events)).not.toContain("fixture-secret");
}, 5000);
