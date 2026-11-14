import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import * as bytesClient from "../../../herdr/src/client/bytes";
import * as coreClient from "../../../herdr/src/client/hc";
import * as liveness from "../../../herdr/src/client/liveness";
import { HerdrError } from "../../../herdr/src/client/parse";
import * as transportModule from "../transport";
import { BOOTSTRAP_AGENT_DIRECTORY_SCRIPT, BOOTSTRAP_SCRIPT, BOOTSTRAP_SETTINGS_SCRIPT } from "../bootstrap-script";
import { selectedSettingsDigests } from "../selected-files";
import type { SettingsDestinationPreview, SettingsKeyDigest } from "../selected-files";
import type { Journal, Peer, Transport } from "../contracts";
import { bootstrapPeer, inventoryEnvelope } from "./bootstrap-fixture";

type CoreFence = { local: string; remote: string };
const coreFence: CoreFence = { local: "local-core", remote: "remote-core" };
type ProvisionTransport = { transport: Transport; probeAgentDirectory(peer: Peer, home: string): Promise<{ status: "default" | "custom" | "unknown"; core: CoreFence }>;
  previewSettings(peer: Peer, home: string, entries: readonly SettingsKeyDigest[], maximum: number, core: CoreFence): Promise<SettingsDestinationPreview>;
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
    settingsReply: { version: 1, kind: "settings-preview", value: { fingerprint: "a".repeat(64), digests: ["b".repeat(64)] } } as Record<string, unknown>,
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
    if (argv.includes(BOOTSTRAP_SETTINGS_SCRIPT)) return Buffer.from(JSON.stringify(state.settingsReply));
    if (argv.includes(BOOTSTRAP_SCRIPT)) return Buffer.from(JSON.stringify(inventoryEnvelope()));
    const request = JSON.parse(options.stdin!.toString("utf8")) as { action?: string };
    if (request.action && state.provisionError) throw state.provisionError;
    return Buffer.from(JSON.stringify(request.action ? state.provisionReply : state.reply));
  });
  const fixtureRoot = process.env.SPIDER_GLOBAL_ROOT;
  if (!fixtureRoot) throw new Error("Fixture global root is required");
  const options = { binary: "/fixture/hc", env: { HC_SOCKET: resolve(fixtureRoot, "provision-fixture.sock"), HC_SESSION: "fixture" }, enrolled: [bootstrapPeer] };
  const consent = (peer: Peer = bootstrapPeer) => journal.record("op-1", "provision-consent", { target: peer.alias, machineId: peer.machineId, approved: true, providers: ["github-copilot"] });
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

it("does not send source settings value digests to the box before consent", async () => {
  const f = fixture(), port = create!(f.options, f.journal), entries = [{ path: ["theme"], sha256: "c".repeat(64) }];
  f.state.settingsReply = { version: 1, kind: "settings-preview", value: { fingerprint: "a".repeat(64), digests: ["b".repeat(64)] } };
  await port.previewSettings(bootstrapPeer, "/home/fixture", entries, 1024, { local: "local-core", remote: "remote-core" });
  const request = f.calls.find(call => call.argv.includes(BOOTSTRAP_SETTINGS_SCRIPT));
  expect(request).toBeTruthy(); expect(request!.stdin!.toString("utf8")).not.toContain(entries[0].sha256);
}, 5000);

it("runs the actual settings probe through transport without sending source-value hashes", async () => {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "settings-transport-")), home = join(root, "home"), agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(agent, "settings.json"), '{"theme":"box-value","defaultModel":"shared-value","defaultProjectTrust":"never"}', { mode: 0o600 });
    const entries = selectedSettingsDigests({ path: "settings.json", bytes: Buffer.from('{"theme":"source-value","defaultModel":"shared-value"}'), mode: 0o600 });
    const f = fixture(), port = create!(f.options, f.journal); let request = "";
    vi.spyOn(bytesClient, "invokeBytes").mockImplementation(async (_binary, argv, _env, options) => {
      expect(argv).toContain(BOOTSTRAP_SETTINGS_SCRIPT); request = options.stdin!.toString("utf8");
      const child = spawnSync(process.execPath, ["--input-type=module-typescript", "-e", BOOTSTRAP_SETTINGS_SCRIPT],
        { input: options.stdin, env: { ...process.env, HOME: home }, cwd: home, encoding: "utf8", timeout: 3000 });
      expect(child.status).toBe(0); expect(child.stderr).toBe(""); return Buffer.from(child.stdout);
    });
    const preview = await port.previewSettings(bootstrapPeer, home, entries, 1024 * 1024, coreFence);
    expect(preview.changedKeys).toEqual(["theme"]); expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(request).not.toContain("source-value"); for (const entry of entries) expect(request).not.toContain(entry.sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 5000);

it("core-fences the read-only settings preview and sends only key paths", async () => {
  const f = fixture(), port = create!(f.options, f.journal);
  expect(port.previewSettings).toBeTypeOf("function");
  const entries = selectedSettingsDigests({ path: "settings.json", bytes: Buffer.from('{"theme":"fixture-sensitive-value"}'), mode: 0o600 });
  expect(await port.previewSettings(bootstrapPeer, "/home/fixture", entries, 1024 * 1024, coreFence))
    .toEqual({ fingerprint: "a".repeat(64), changedKeys: ["theme"] });
  const call = f.calls.at(-1)!;
  expect(call.argv).toContain(BOOTSTRAP_SETTINGS_SCRIPT); expect(call.argv).toContain("--stdin");
  expect(JSON.parse(call.stdin!.toString("utf8"))).toEqual({ home: "/home/fixture", agentDir: "/home/fixture/.pi/agent", paths: entries.map(entry => entry.path), maximum: 1024 * 1024 });
  expect(JSON.stringify(call.argv)).not.toContain("fixture-sensitive-value"); expect(call.stdin!.toString("utf8")).not.toContain("fixture-sensitive-value");
  expect(f.events.slice(-5)).toEqual(["server", "machine", "identity", "server", "machine"]);
  f.state.settingsReply = { version: 1, kind: "settings-preview", error: "invalid-destination-settings" };
  await expect(port.previewSettings(bootstrapPeer, "/home/fixture", entries, 1024 * 1024, coreFence)).rejects.toMatchObject({ code: "invalid-destination-settings" });
  f.state.settingsReply = { version: 1, kind: "settings-preview", error: "fixture-secret" };
  await expect(port.previewSettings(bootstrapPeer, "/home/fixture", entries, 1024 * 1024, coreFence)).rejects.toMatchObject({ code: "invalid-bootstrap-reply" });
  f.state.settingsReply = { version: 1, kind: "settings-preview", value: { fingerprint: "a".repeat(64), digests: ["defaultProjectTrust"] } };
  await expect(port.previewSettings(bootstrapPeer, "/home/fixture", entries, 1024 * 1024, coreFence)).rejects.toMatchObject({ code: "invalid-bootstrap-reply" });
  f.state.settingsReply = { version: 1, kind: "settings-preview", value: { fingerprint: "a".repeat(64), digests: [entries[0].sha256] } };
  expect(await port.previewSettings(bootstrapPeer, "/home/fixture", entries, 1024 * 1024, coreFence)).toEqual({ fingerprint: "a".repeat(64), changedKeys: [] });
  f.state.replaceDuringCall = true;
  await expect(port.previewSettings(bootstrapPeer, "/home/fixture", entries, 1024 * 1024, coreFence)).rejects.toMatchObject({ code: "core-changed" });
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
    node: bootstrapPeer.node, cli: bootstrapPeer.cli, pi: bootstrapPeer.pi, providers: ["github-copilot"], data: Buffer.from("fixture-secret").toString("base64") };
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

it("refuses credential chunks and files for an unconsented provider before sending bytes", async () => {
  const f = fixture();
  f.journal.record("op-1", "provision-consent", { target: bootstrapPeer.alias, machineId: bootstrapPeer.machineId, approved: true, providers: ["github-copilot"] });
  const port = create!(f.options, f.journal), handle = await port.transport.resolve(bootstrapPeer), before = f.calls.length;
  const base = { operationId: "op-1", machineId: bootstrapPeer.machineId, globalRoot: bootstrapPeer.globalRoot,
    node: bootstrapPeer.node, cli: bootstrapPeer.cli, pi: bootstrapPeer.pi };
  const chunk = { ...base, action: "secret-chunk", providers: ["demo"], data: Buffer.from("fixture-secret").toString("base64") };
  await expect(port.executeProvision(handle, chunk)).rejects.toMatchObject({ code: "consent-required" });
  await expect(port.executeProvision(handle, { ...chunk, providers: [] })).rejects.toMatchObject({ code: "consent-required" });
  await expect(port.executeProvision(handle, { ...chunk, providers: ["github-copilot", "github-copilot"] })).rejects.toMatchObject({ code: "consent-required" });
  await expect(port.executeProvision(handle, { ...base, action: "auth-install", providers: ["demo"] })).rejects.toMatchObject({ code: "consent-required" });
  await expect(port.executeProvision(handle, { ...base, action: "auth-install" })).rejects.toMatchObject({ code: "consent-required" });
  await expect(port.executeProvision(handle, { ...base, action: "install-files", providers: ["demo"],
    file: { path: "models.json", chunks: [{ name: "secret-file-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] } })).rejects.toMatchObject({ code: "consent-required" });
  expect(f.calls).toHaveLength(before);
  expect(await port.executeProvision(handle, { ...chunk, providers: ["github-copilot"] })).toBe(true);
  expect(await port.executeProvision(handle, { ...base, action: "auth-install", providers: ["github-copilot"] })).toBe(true);
  expect(f.calls.length).toBeGreaterThan(before);
  expect(JSON.stringify(f.calls.at(-1)!.argv)).not.toContain("fixture-secret");
}, 5000);

it("admits a consented enrollment action through the real transport policy", async () => {
  const f = fixture(), port = create!(f.options, f.journal), handle = await port.transport.resolve(bootstrapPeer);
  const request = { action: "enrollment", operationId: "op-1", machineId: bootstrapPeer.machineId, globalRoot: bootstrapPeer.globalRoot,
    node: bootstrapPeer.node, cli: bootstrapPeer.cli, pi: bootstrapPeer.pi, hubMachineId: "00000000-0000-4000-8000-000000000001", coreUnit: "fixture.service" };
  await expect(port.executeProvision(handle, request)).rejects.toMatchObject({ code: "consent-required" });
  f.consent(); f.state.provisionReply = { version: 1, kind: "provision", value: "enrolled" };
  expect(await port.executeProvision(handle, request)).toBe("enrolled");
  expect(f.events.slice(-5)).toEqual(["server", "machine", "identity", "server", "machine"]);
  expect(JSON.parse(f.calls.at(-1)!.stdin!.toString("utf8"))).toEqual({ ...request, core: bootstrapPeer.core, coreId: "remote-core" });
  f.state.provisionReply = { version: 1, kind: "provision", value: "untrusted" };
  await expect(port.executeProvision(handle, request)).rejects.toMatchObject({ code: "invalid-provision-reply" });
  f.state.provisionReply = { version: 1, kind: "provision", value: "already-enrolled" };
  expect(await port.executeProvision(handle, request)).toBe("already-enrolled"); f.state.replaceDuringCall = true;
  await expect(port.executeProvision(handle, request)).rejects.toMatchObject({ code: "core-changed" });
}, 5000);

it.each(["invalid-enrollment", "unsafe-enrollment", "enrollment-identity-mismatch", "enrollment-conflict", "enrollment-publication-pending"])("retains the named %s enrollment refusal", async reason => {
  const f = fixture(); f.consent(); const port = create!(f.options, f.journal), handle = await port.transport.resolve(bootstrapPeer);
  f.state.provisionReply = { version: 1, kind: "provision", error: reason };
  await expect(port.executeProvision(handle, { action: "enrollment", operationId: "op-1", machineId: bootstrapPeer.machineId, globalRoot: bootstrapPeer.globalRoot,
    node: bootstrapPeer.node, cli: bootstrapPeer.cli, pi: bootstrapPeer.pi })).rejects.toMatchObject({ code: reason });
}, 5000);

it.each(["invalid-destination-settings", "settings-preview-changed", "invalid-settings-preview", "credential-file-requires-consent", "provider-consent-required"])("preserves the named %s settings refusal", async reason => {
  const f = fixture(); f.consent(); const port = create!(f.options, f.journal), handle = await port.transport.resolve(bootstrapPeer);
  f.state.provisionReply = { version: 1, kind: "provision", error: reason };
  await expect(port.executeProvision(handle, { action: "install-files", operationId: "op-1", machineId: bootstrapPeer.machineId,
    globalRoot: bootstrapPeer.globalRoot, node: bootstrapPeer.node, cli: bootstrapPeer.cli, pi: bootstrapPeer.pi }))
    .rejects.toMatchObject({ code: reason });
}, 5000);

it("preserves cli-timeout for a bounded provisioning write", async () => {
  const f = fixture(); f.consent(); const port = create!(f.options, f.journal), handle = await port.transport.resolve(bootstrapPeer);
  f.state.provisionError = new HerdrError("cli-timeout", "fixture-secret");
  await expect(port.executeProvision(handle, { action: "secret-chunk", operationId: "op-1", machineId: bootstrapPeer.machineId,
    globalRoot: bootstrapPeer.globalRoot, node: bootstrapPeer.node, cli: bootstrapPeer.cli, pi: bootstrapPeer.pi, providers: ["github-copilot"] }))
    .rejects.toMatchObject({ code: "cli-timeout" });
}, 5000);

it("redacts untrusted transport error codes and details", async () => {
  const f = fixture(); f.consent(); const port = create!(f.options, f.journal), handle = await port.transport.resolve(bootstrapPeer);
  f.state.provisionError = Object.assign(new Error("fixture-secret"), { code: "fixture-secret", details: { stderr: "fixture-secret" } });
  let caught: unknown;
  try { await port.executeProvision(handle, { action: "secret-chunk", operationId: "op-1", machineId: bootstrapPeer.machineId,
    globalRoot: bootstrapPeer.globalRoot, node: bootstrapPeer.node, cli: bootstrapPeer.cli, pi: bootstrapPeer.pi, providers: ["github-copilot"] }); } catch (error) { caught = error; }
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
