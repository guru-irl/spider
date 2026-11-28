import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { getProvisionRemoteScript } from "../provision-remote-script";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { claimMachineIdentity } from "@spider/db-core/roam/machine";
import { applyIntercomSwitchover, filesystemSwitchoverPorts } from "../../../../scripts/intercom-switchover.mjs";
import { DEFAULT_LIMITS } from "../contracts";
import type { Outcome, Peer, Transport } from "../contracts";
import { openJournal } from "../journal";
import { installPiAuth } from "../auth";
import { inspectDestinationSettings, inspectAgentPrivateModes, installSelectedFiles } from "../selected-files";
import type { SelectedFile, SettingsKeyDigest } from "../selected-files";
import * as provisionModule from "../provision";
import { bootstrapPeer, healthyInventory } from "./bootstrap-fixture";

type Provision = (input: { operation: { id: string; machineId: string; expectedEpoch: null; kind: string; args: Record<string, never> }; peer: Peer;
  selected: readonly string[]; includeAuth: boolean; confirmedProviders: readonly string[]; expectedAuthBytes?: number;
  expectedFiles?: readonly { path: string; size: number; mode: number }[]; expectedSelectionDigest?: string; replaceCorePin?: boolean; requireDestinationAuth?: boolean }, ports: unknown) => Promise<Outcome<{ hostingReady: boolean }>>;
const provision = (provisionModule as { provision?: Provision }).provision;
const roots: string[] = [];

function fixture() {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "provision-")); roots.push(root);
  const source = join(root, "source"), destination = join(root, "agent"), staging = join(root, "stage"), units = join(root, "units"), global = join(root, "global");
  for (const dir of [source, destination, staging, units, global]) mkdirSync(dir, { mode: 0o700 });
  const write = (base: string, name: string, text: string) => {
    const file = join(base, name); mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, text, { mode: 0o600 }); return file;
  };
  const releaseFile = write(source, "spider.tgz", "fixture spider release");
  const sha256 = createHash("sha256").update(readFileSync(releaseFile)).digest("hex");
  const coreFile = write(units, "herdr-core.service", "unchanged core unit"), terminals = write(root, "terminals.json", "[\"terminal-1\"]");
  const releaseRoot = join(root, "release"); mkdirSync(join(releaseRoot, "dist", "intercom"), { recursive: true, mode: 0o700 });
  write(releaseRoot, "dist/extension.js", "extension"); write(releaseRoot, "dist/intercom/broker.mjs", "broker");
  const activeFile = write(root, "active.json", "null"), journal = openJournal(join(root, "journal.db"));
  const state = { allow: true, existingId: null as string | null, verified: false, hubEnabled: true, boxEnabled: false, agentDirectory: "default" as "default" | "custom" | "unknown",
    coreId: "fixture-core", replaceCoreOnConfirm: false, supervisorEnabled: false, permissionTightenings: 0, repairModes: false };
  const events: string[] = [], confirmations: { target: string; providers: readonly string[] }[] = [], persisted: Peer[] = [];
  const preview: unknown[] = [], diagnostics: unknown[] = [], systemctl: string[][] = [], secretCollectionCalls: string[] = [];
  const value = healthyInventory();
  const transport: Transport = {
    async bootstrapProbe(_peer, _kind, options) {
      if (options?.expectedCore && options.expectedCore.remote !== state.coreId) throw Object.assign(new Error("changed"), { code: "core-changed" });
      return structuredClone(value);
    },
    async resolve(peer) { return peer; },
    async exec() { throw new Error("unexpected command"); }, async run() { throw new Error("unexpected launch"); },
    async read() { throw new Error("unexpected read"); }, async write() { throw new Error("unexpected write"); },
  };
  const virtual = { home: "/home/fixture", agentDir: "/home/fixture/.pi/agent", npmPrefix: "/home/fixture/.local",
    supervisor: "/home/fixture/.local/lib/spider/dist/roam/supervisor.mjs" };
  const stageFile = join(staging, "auth.stage");
  const ports = {
    transport, journal, hubMachineId: "00000000-0000-4000-8000-000000000001", limits: DEFAULT_LIMITS, coreUnit: "herdr-core.service",
    async withPeerLock<T>(_machineId: string, work: () => Promise<T>): Promise<T> { events.push("lock"); try { return await work(); } finally { events.push("unlock"); } },
    async confirm(target: string, providers: readonly string[]) {
      events.push("confirm"); confirmations.push({ target, providers: [...providers] });
      if (state.replaceCoreOnConfirm) state.coreId = "replacement-core";
      return state.allow;
    },
    systemd: {
      async writeUnit(name: string, bytes: string) { events.push("unit"); write(units, name, bytes); },
      async systemctl(argv: readonly string[]) {
        events.push("systemctl"); systemctl.push([...argv]);
        if (argv[1] === "enable") state.supervisorEnabled = true;
        if (argv[1] === "disable") state.supervisorEnabled = false;
      },
    },
    async resources() { throw new Error("local resource probe is forbidden"); },
    async bootId() { throw new Error("local boot probe is forbidden"); },
    release: { pi: "1.2.0", intercom: "spider-owned", spiderSha256: sha256, nodeRange: "22.23.4 || 26.4.0" },
    source: { agentRoot: source, releaseFile, piProviders: ["github-copilot"] }, destination: virtual,
    async present(value: unknown) { events.push("present"); preview.push(value); },
    async report(value: unknown) { events.push("report"); diagnostics.push(value); },
    async verifyPeer() {
      return { corePin: "ready", piSignedIn: state.verified, nativeSqlite: true, extensionLoaded: true, exactSession: true, privateModes: true,
        bundledIntercom: true, intercomUnique: true, legacyDrained: true, federation: true,
        intercomEvidence: { settings: "settings-unique", legacy: "legacy-drained-private-agent", federation: "federation-v1", otherExtensions: [] } };
    },
    bootstrap: { async probeAgentDirectory() {
      events.push("agent-directory-probe"); return { status: state.agentDirectory, core: { local: "fixture-local-core", remote: state.coreId } };
    },
    async previewSettings(_peer: Peer, _home: string, entries: readonly SettingsKeyDigest[], maximum: number, core: { local: string; remote: string }, selectedPaths?: readonly string[]) {
      if (core.local !== "fixture-local-core" || core.remote !== state.coreId) throw Object.assign(new Error("changed"), { code: "core-changed" });
      events.push("settings-preview"); return inspectDestinationSettings({ home: root, destinationRoot: destination, entries, maximum, selectedPaths, repairablePrivateModes: state.repairModes });
    },
    async claimIdentity(peer: Peer, operationId: string, core: { local: string; remote: string }) {
      if (!core || core.local !== "fixture-local-core" || core.remote !== state.coreId) throw Object.assign(new Error("changed"), { code: "core-changed" });
      events.push("identity");
      const consent = journal.read(operationId).some(item => item.action === "provision-consent" && item.result.approved === true);
      if (!consent) throw new Error("identity before consent");
      if (state.existingId) claimMachineIdentity(global, state.existingId);
      return { machineId: claimMachineIdentity(global, peer.machineId), coreId: "fixture-core" };
    } },
    transfer: {
      async reconcilePairUnits(_peer: Peer) {},
      async repairAgentDirectory(_peer: Peer) {
        events.push("private-mode-repair");
        const repairs = inspectAgentPrivateModes(destination, true).map(entry => ({ ...entry, path: entry.path.replace(destination, virtual.agentDir) }));
        const auth = join(destination, "auth.json"), present = existsSync(auth);
        value.auth.pi = { present, readable: present, modeSafe: present && (lstatSync(auth).mode & 0o7777) === 0o600 };
        return repairs;
      },
      async setEnabled(_peer: Peer, _hub: string, enabled: boolean) { state.boxEnabled = enabled; events.push(`enabled:${enabled}`); },
      async enroll(_peer: Peer, hubMachineId: string) { expect(hubMachineId).toBe("00000000-0000-4000-8000-000000000001"); events.push("enrollment"); },
      async cleanupSecrets(_peer: Peer) { events.push("cleanup-secrets"); },
      async installRelease(_peer: Peer, input: { bytes: Buffer; sha256: string; npmPrefix: string; globalRoot: string; pi: string; intercom: string }) {
        events.push("release");
        expect(createHash("sha256").update(input.bytes).digest("hex")).toBe(input.sha256);
        expect(input).toMatchObject({ npmPrefix: virtual.npmPrefix, globalRoot: bootstrapPeer.globalRoot, pi: "1.2.0", intercom: "spider-owned" });
        return { pi: bootstrapPeer.pi, cli: bootstrapPeer.cli, supervisor: virtual.supervisor };
      },
      async installFiles(_peer: Peer, files: readonly SelectedFile[], expectedSettingsFingerprint?: string) {
        events.push("files"); installSelectedFiles({ destinationRoot: destination, files, expectedSettingsFingerprint });
      },
      async installCredentialFiles(_peer: Peer, files: readonly SelectedFile[], providers: readonly string[], expectedSettingsFingerprint?: string) {
        expect(providers.length).toBeGreaterThan(0); events.push("credential-files"); installSelectedFiles({ destinationRoot: destination, files, expectedSettingsFingerprint });
      },
      auth(_peer: Peer, _operationId: string) {
        return {
          async stage(bytes: Buffer) { events.push("auth-stage"); writeFileSync(stageFile, bytes, { mode: 0o600 }); return { file: stageFile }; },
          async install(stage: { file: string }, providers: readonly string[]) { events.push("auth-install"); installPiAuth({ destinationRoot: destination, stagingRoot: staging, stagedFile: stage.file, providers }); },
          async remove(stage: { file: string } | null) { events.push("auth-remove"); rmSync(stage?.file ?? stageFile, { force: true }); },
        };
      },
      async switchover(_peer: Peer, operationId: string) {
        events.push("switchover");
        return applyIntercomSwitchover({ operationId, settingsFiles: [join(destination, "settings.json")], legacyRoots: [join(destination, "legacy-intercom")],
          release: releaseRoot, journalFile: join(root, `switch-${operationId}.json`) }, filesystemSwitchoverPorts(activeFile));
      },
    },
    async persistPeer(peer: Peer) { events.push("persist"); persisted.push(peer); },
    async permissionTightening(_peer: Peer) { events.push("permission-summary"); return state.permissionTightenings; },
    async setParticipation(_peer: Peer, ready: boolean | null) {
      if (state.hubEnabled && ready === null) return;
      state.boxEnabled = state.hubEnabled && ready === true; events.push(`enabled:${state.boxEnabled}`);
    },
  };
  const request = (id: string, includeAuth = false, providers: readonly string[] = [], selected: readonly string[] = ["settings.json"]) => ({
    operation: { id, machineId: bootstrapPeer.machineId, expectedEpoch: null, kind: "provision", args: {} }, peer: bootstrapPeer,
    selected, includeAuth, confirmedProviders: providers,
  });
  return { root, source, destination, staging, units, global, journal, write, releaseFile, coreFile, terminals, stageFile, state, events, confirmations, persisted, preview,
    diagnostics, systemctl, secretCollectionCalls, value, ports, request };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("reprovisioning repairs sign-in modes with no settings selected and records every repair", async () => {
  const f = fixture(); f.state.repairModes = true; f.state.verified = true;
  const settings = f.write(f.destination, "settings.json", '{"theme":"sample"}'), auth = f.write(f.destination, "auth.json", "{}");
  const folder = join(f.destination, "sessions"); mkdirSync(folder, { mode: 0o700 });
  chmodSync(settings, 0o664); chmodSync(auth, 0o664); chmodSync(folder, 0o775);
  f.value.auth.pi = { present: true, readable: true, modeSafe: false };
  const request = { ...f.request("signin-modes", false, [], []), requireDestinationAuth: true };
  const expected = [
    { path: "/home/fixture/.pi/agent/auth.json", uid: process.getuid!(), before: 0o664, after: 0o600 },
    { path: "/home/fixture/.pi/agent/sessions", uid: process.getuid!(), before: 0o775, after: 0o700 },
    { path: "/home/fixture/.pi/agent/settings.json", uid: process.getuid!(), before: 0o664, after: 0o600 },
  ];
  const outcome = await provision!(request, f.ports);
  expect(outcome).toMatchObject({ code: 0, reason: "installed", value: { privateModeRepairs: expected } });
  expect(lstatSync(settings).mode & 0o7777).toBe(0o600); expect(lstatSync(auth).mode & 0o7777).toBe(0o600); expect(lstatSync(folder).mode & 0o7777).toBe(0o700);
  expect(readFileSync(settings, "utf8")).toBe('{"theme":"sample"}');
  expect(f.events.indexOf("private-mode-repair")).toBeGreaterThan(f.events.indexOf("confirm"));
  expect(f.events.indexOf("private-mode-repair")).toBeLessThan(f.events.indexOf("release"));
  expect(await provision!(request, f.ports)).toMatchObject({ code: 0, value: { privateModeRepairs: expected } });
});

it("reprovision repairs a stopped enrolled pair so enable succeeds", async () => {
  const f = fixture(), { scenario, cleanupPairScenarios } = await import("./intercom-pair-fixture");
  const pair = await scenario();
  let hubSocket: { close(): Promise<void> } | undefined;
  try {
    const { provisionIntercomEnrollment } = await import("../intercom-enrollment");
    const { inspectLocalIntercomDoctor } = await import("../intercom-doctor");
    const { HELPER_EXCHANGE_FEATURE, FEDERATION_NOTICE_ACK_FEATURE } = await import("@spider/intercom/protocol");
    const { parseConfig } = await import("../config"), { main } = await import("../cli");
    const { openDb, migrate } = await import("@spider/db-core"), { startHubControl } = await import("../control-socket");
    const controls = await import("../production-controls"), productionHub = await import("../production-hub");
    const transport = await import("../transport"), diagnostics = await import("../diagnostics");
    const observations = await import("../remote-observations"), launchd = await import("../launchd");
    expect((await provisionIntercomEnrollment(pair.request, pair.enrollment)).code).toBe(0);
    const local = pair.locals.get(pair.target.machineId)!, name = "spider-pair-pair-1-host.service";
    await local.run(["/fixture/systemctl", "--user", "stop", name], { timeoutMs: 1000, maxBytes: 4096 });
    const owned = pair.units.get(`${pair.target.machineId}/${name}`)!;
    const foreign = { name: "foreign.service", file: "/home/fixture/foreign.service", pid: 0, state: "inactive", members: [] };
    pair.units.set(`${pair.target.machineId}/foreign.service`, foreign);
    const peer = { ...bootstrapPeer, machineId: pair.target.machineId }, hub = pair.request.operation.machineId;
    const config = parseConfig(JSON.parse(readFileSync(join(pair.target.globalRoot, "roam/config.json"), "utf8")));
    const doctor = () => inspectLocalIntercomDoctor({ root: pair.target.globalRoot, config, agentDir: local.home, resourcePorts: local, run: local.run,
      features: async () => [HELPER_EXCHANGE_FEATURE, FEDERATION_NOTICE_ACK_FEATURE],
      inspectSsh: async enrolled => ({ targetMachineId: pair.target.machineId, sshUser: "fixture", hostKeys: [enrolled.hostKey] }),
      link: async () => ({ status: "live", reason: null }) });
    mkdirSync(join(f.root, "roam"), { mode: 0o700 });
    f.write(f.root, "roam/machine.json", JSON.stringify({ machineId: hub }));
    f.write(f.root, "roam/config.json", JSON.stringify({ enabled: false, role: "hub", machineId: hub, hubMachineId: hub,
      peers: [peer], discoveryRoots: [], coreUnit: "fixture.service" }));
    const db = openDb(join(f.root, "spider.db")); migrate(db, "global", { machineId: hub, globalRoot: f.root }); db.close();
    hubSocket = await startHubControl(join(f.root, "roam/hub.sock"), async () => ({ code: 0, reason: "ready", value: { enabled: true } }));
    const launcher = f.write(f.root, "launchctl", "fixture");
    vi.stubEnv("HOME", f.root); vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root); vi.stubEnv("SPIDER_ROAM_PI", process.execPath); vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launcher);
    vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/core" } } as never);
    vi.spyOn(diagnostics, "assertCompatibleConsumers").mockResolvedValue(undefined);
    vi.spyOn(launchd, "installHubService").mockResolvedValue(undefined);
    vi.spyOn(observations, "remoteDoctor").mockImplementation(async () => ({ enabled: false, diagnostics: await doctor(), consumers: [] }));
    vi.spyOn(transport, "createTransport").mockReturnValue({ async resolve(target: Peer) { return target; }, async exec(_target: Peer, argv: string[]) {
      if (argv[1] === "intercom") return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-broker-start", ok: true, machineId: peer.machineId,
        doctor: { enabled: false, diagnostics: await doctor(), consumers: [] } }));
      const op = JSON.parse(argv[2]);
      return Buffer.from(JSON.stringify({ operationId: op.id, code: 0, value: op.kind === "stores"
        ? { protocol: 1, schema: 14, machineId: peer.machineId, stores: ["global"] } : { complete: true } }));
    } } as never);
    vi.spyOn(transport, "createProvisionTransport").mockReturnValue({ transport: { async resolve(target: Peer) { return target; } },
      async executeProvision(_target: Peer, request: { enabled: boolean }) { return { enabled: request.enabled }; } } as never);
    const blocked = await controls.enableRoaming(f.root, () => process.execPath);
    expect(blocked).toMatchObject({ code: 1, reason: "preflight-failed:box-1.invalid:intercom-pair-unit-unavailable",
      issues: [expect.objectContaining({ repairCommand: "spider roam provision box-1.invalid" })] });
    expect(owned.state).toBe("inactive");
    f.state.verified = true; f.state.hubEnabled = false;
    const transfer = { ...f.ports.transfer, async reconcilePairUnits(target: Peer) {
      expect(target.machineId).toBe(pair.target.machineId);
      let out = "";
      expect(await main(["--global-root", pair.target.globalRoot, "roam", "intercom", "repair-units"],
        { out: text => { out += text; }, err: () => {} }, { pairPorts: local })).toBe(0);
      const reply = JSON.parse(out);
      if (!reply.ok) throw Object.assign(new Error("pair repair failed"), { code: reply.reason });
    } };
    const request = { ...f.request("repair-pair", false, [], []), peer,
      operation: { ...f.request("repair-pair").operation, machineId: peer.machineId } };
    expect(await provision!(request, { ...f.ports, transfer })).toMatchObject({ code: 0 });
    expect(owned.state).toBe("active");
    await local.run(["/fixture/systemctl", "--user", "stop", name], { timeoutMs: 1000, maxBytes: 4096 });
    expect(await provision!(request, { ...f.ports, transfer })).toMatchObject({ code: 0 });
    expect(owned.state).toBe("inactive"); // A completed operation replays without repeating its effects.
    const fresh = { ...request, operation: { ...request.operation, id: "repair-pair-again" } };
    expect(await provision!(fresh, { ...f.ports, transfer })).toMatchObject({ code: 0 });
    expect(owned.state).toBe("active");
    expect(foreign).toEqual({ name: "foreign.service", file: "/home/fixture/foreign.service", pid: 0, state: "inactive", members: [] });
    expect(pair.calls.some(call => call.includes("foreign.service"))).toBe(false);
    expect(await controls.enableRoaming(f.root, () => process.execPath)).toMatchObject({ code: 0, reason: "roaming-enabled" });
  } finally { await hubSocket?.close(); cleanupPairScenarios(); }
}, 5000);

it.each(["intercom-unit-mismatch", "revocation-pending"])("keeps provisioning incomplete when pair-unit repair reports %s", async code => {
  const f = fixture(); f.state.verified = true; f.write(f.source, "settings.json", "{}");
  f.ports.transfer.reconcilePairUnits = async () => { throw Object.assign(new Error("fixture refusal"), { code }); };
  const outcome = await provision!(f.request(`pair-refusal-${code}`), f.ports);
  expect(outcome).toMatchObject({ code: 3, reason: code });
  expect(f.systemctl).not.toContainEqual(["--user", "enable", "spider-roam-supervisor.service"]);
  expect(f.state.boxEnabled).toBe(false);
  expect(f.journal.read(`pair-refusal-${code}`).some(row => row.action === "done")).toBe(false);
});

it("declining consent does not attempt pair-unit repair", async () => {
  const f = fixture(); let repairs = 0; f.write(f.source, "settings.json", "{}");
  f.ports.confirm = async () => false;
  f.ports.transfer.reconcilePairUnits = async () => { repairs++; };
  expect(await provision!(f.request("pair-no-consent"), f.ports)).toMatchObject({ code: 1, reason: "consent-refused" });
  expect(repairs).toBe(0);
});

it("declining consent leaves repairable destination modes unchanged", async () => {
  const f = fixture(); f.state.repairModes = true; f.state.allow = false;
  const settings = f.write(f.destination, "settings.json", "{}"); chmodSync(settings, 0o664);
  expect(await provision!(f.request("decline-mode-repair", false, [], []), f.ports)).toMatchObject({ code: 1, reason: "consent-refused" });
  expect(lstatSync(settings).mode & 0o7777).toBe(0o664); expect(f.events).not.toContain("private-mode-repair");
});

it("still requires a real destination sign-in after a repairable preview", async () => {
  const f = fixture(); f.state.repairModes = true; f.value.auth.pi = { present: false, readable: false, modeSafe: false };
  expect(await provision!({ ...f.request("missing-signin", false, [], []), requireDestinationAuth: true }, f.ports)).toMatchObject({ code: 1, reason: "destination-auth-missing" });
  expect(f.events).not.toContain("private-mode-repair");
});

it("preserves path, mode, owner and actionable repair advice in provisioning refusal", async () => {
  const f = fixture(), path = "/home/fixture/.pi/agent/settings.json";
  f.ports.bootstrap.previewSettings = async () => { throw Object.assign(new Error("refused"), { code: "unsafe-destination", details: { path, mode: 0o664, uid: 1001, problem: "owner" } }); };
  const outcome = await provision!(f.request("foreign-signin", false, [], []), f.ports);
  expect(outcome.code).toBe(1); expect(outcome.reason).toContain(path); expect(outcome.reason).toContain("0664"); expect(outcome.reason).toContain("uid 1001"); expect(outcome.reason).toContain("then reprovision");
});

it("names unsafe install parents and supplies exact chmod advice in provisioning outcomes", async () => {
  const f = fixture(), path = "/home/fixture/.local", details = { path, mode: 0o775, uid: 1000, problem: "writable-parent" };
  f.ports.transfer.installRelease = async () => { throw Object.assign(new Error("refused"), { code: "unsafe-destination", details }); };
  const outcome = await provision!(f.request("unsafe-install-parent", false, [], []), f.ports);
  expect(outcome.reason).toBe("unsafe-destination (/home/fixture/.local; mode 0775; uid 1000; writable-parent). Run chmod go-w '/home/fixture/.local', then reprovision.");
});

it("names configured-root ownership failures before the settings preview", async () => {
  const f = fixture(), path = "/home/fixture/.pi/agent";
  f.ports.bootstrap.probeAgentDirectory = async () => { throw Object.assign(new Error("refused"), { code: "unsafe-destination", details: { path, mode: 0o775, uid: 1001, problem: "owner" } }); };
  const outcome = await provision!(f.request("foreign-root", false, [], []), f.ports);
  expect(outcome.code).toBe(1); expect(outcome.reason).toContain(path); expect(outcome.reason).toContain("0775"); expect(outcome.reason).toContain("uid 1001");
  expect(f.events).not.toContain("confirm");
});

it("completes ready provisioning when the permission count is unavailable", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}"); f.state.verified = true;
  f.ports.permissionTightening = async () => { throw Object.assign(new Error("unavailable"), { code: "unsafe-staging" }); };
  const result = await provision!(f.request("count-unavailable"), f.ports);
  expect(result).toMatchObject({ code: 0, reason: "installed", value: { hostingReady: true, permissionTightenings: null } });
  expect(f.systemctl).toEqual([]);
  expect(f.state.boxEnabled).toBe(true);
  expect(await provision!(f.request("count-unavailable"), f.ports)).toEqual(result);
});

it.each(["core-pin-invalid", "core-pin-conflict", "core-pin-changed"])("keeps %s actionable across provisioning", async reason => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.ports.transfer.enroll = async () => { throw Object.assign(new Error("pin refused"), { code: reason }); };
  const outcome = await provision!(f.request("pin-error"), f.ports);
  expect(outcome).toMatchObject({ reason });
  if (reason !== "core-pin-invalid") expect(outcome.repairCommand).toBe(`spider roam provision ${bootstrapPeer.alias} --replace-core-pin`);
});

it.each([
  "chunk-mismatch", "cli-aborted", "cli-exit", "invalid-chunk", "invalid-chunks", "invalid-file", "invalid-providers",
  "invalid-provision-reply", "invalid-release-receipt", "invalid-request", "invalid-switchover-journal",
  "machine-not-enrolled", "missing-hc", "missing-switchover-backup", "peer-invalidated", "process-identity-unavailable",
  "release-launch-uncertain", "reply-too-large", "selection-not-allowed", "spawn-error", "stdin-error", "too-large", "unresolved-peer",
  "unsafe-context", "unsafe-path", "unsafe-release", "unsafe-staging", "invalid-operation", "invalid-provision-options",
  "staging-cleanup-pending", "invalid-bootstrap-reply", "invalid-bootstrap-request", "invalid-bootstrap-kind", "invalid-byte-limit",
  "invalid-cli-deadline", "invalid-reply", "bootstrap-probe-failed", "agent-directory-probe-failed", "provision-transport-failed", "invalid-release-request",
  "invalid-limits", "invalid-staging-name", "unknown-provision-action",
] as const)("preserves the known provisioning error %s", async code => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.ports.transfer.switchover = async () => { throw Object.assign(new Error("untrusted detail"), { code }); };
  const outcome = await provision!(f.request(`known-${code}`), f.ports);
  expect(outcome).toMatchObject({ code: 3, reason: code });
  expect(JSON.stringify(outcome)).not.toContain("untrusted detail");
}, 5000);

it("quotes an unsafe destination path in the repair command", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.ports.transfer.switchover = async () => { throw Object.assign(new Error("untrusted detail"), {
    code: "destination-permissions-unsafe", details: { path: "/home/fixture/.pi/agent/user's themes" },
  }); };
  expect(await provision!(f.request("quoted-permissions"), f.ports)).toMatchObject({ code: 3, reason: "destination-permissions-unsafe",
    repairCommand: "chmod go-w '/home/fixture/.pi/agent/user'\\''s themes'" });
}, 5000);

it.each(["/home/fixture-other/private", "/home/fixture/.pi/agent/../private", "/home/fixture/.pi/agent/unsafe\nname"])
("does not offer a permission repair outside the destination for %s", async path => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.ports.transfer.switchover = async () => { throw Object.assign(new Error("untrusted detail"), {
    code: "destination-permissions-unsafe", details: { path },
  }); };
  const outcome = await provision!(f.request("bad-permission-path"), f.ports);
  expect(outcome.repairCommand).toBeNull();
  expect(JSON.stringify(outcome)).not.toContain(path);
}, 5000);

it("does not expose an unknown coded error", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.ports.transfer.switchover = async () => { throw Object.assign(new Error("untrusted detail"), { code: "fixture-private" }); };
  expect(await provision!(f.request("unknown-code"), f.ports)).toMatchObject({ code: 3, reason: "provision-failed" });
}, 5000);

it("gives a repair command for an unsafe configured agent directory before mutation", async () => {
  const f = fixture();
  f.ports.bootstrap.probeAgentDirectory = async () => { throw Object.assign(new Error("untrusted detail"), {
    code: "destination-permissions-unsafe", details: { path: "/home/fixture/.pi/agent" },
  }); };
  expect(await provision!(f.request("agent-permissions"), f.ports)).toMatchObject({ code: 1, reason: "destination-permissions-unsafe",
    repairCommand: "chmod go-w '/home/fixture/.pi/agent'" });
  expect(f.events).not.toContain("identity");
}, 5000);

it("checks selected file parents before consent and enrollment", async () => {
  const f = fixture(); f.write(f.source, "skills/sample/SKILL.md", "sample");
  f.write(f.destination, "skills/sample/keep", "unchanged"); chmodSync(join(f.destination, "skills/sample"), 0o775);
  f.ports.bootstrap.previewSettings = async (_peer, _home, entries, maximum, _core, selectedPaths) =>
    inspectDestinationSettings({ home: f.root, destinationRoot: f.destination, entries, maximum, selectedPaths });
  const outcome = await provision!(f.request("parent-before-consent", false, [], ["skills/sample"]), f.ports);
  expect(outcome).toMatchObject({ code: 1, reason: "destination-permissions-unsafe" });
  expect(f.confirmations).toEqual([]); expect(f.events).not.toContain("identity"); expect(f.events).not.toContain("release");
  expect(readFileSync(join(f.destination, "skills/sample/keep"), "utf8")).toBe("unchanged");
});

it("offers one recursive repair for an exact retained package tree", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  const root = `/home/fixture/.local/spider-releases/${"a".repeat(64)}`;
  f.ports.transfer.installRelease = async () => { throw Object.assign(new Error("untrusted"), {
    code: "destination-permissions-unsafe", details: { path: root, recursive: true },
  }); };
  expect(await provision!(f.request("recursive-repair"), f.ports)).toMatchObject({
    code: 3, reason: "destination-permissions-unsafe", repairCommand: `chmod -R go-w '${root}'`,
  });
});

it("gives a repair command for an unsafe retained release path", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.ports.transfer.installRelease = async () => { throw Object.assign(new Error("untrusted detail"), {
    code: "destination-permissions-unsafe", details: { path: "/home/fixture/.local/spider-releases/partial" },
  }); };
  expect(await provision!(f.request("release-permissions"), f.ports)).toMatchObject({ code: 3, reason: "destination-permissions-unsafe",
    repairCommand: "chmod go-w '/home/fixture/.local/spider-releases/partial'" });
}, 5000);

it("preserves a known agent-directory probe error", async () => {
  const f = fixture();
  f.ports.bootstrap.probeAgentDirectory = async () => { throw Object.assign(new Error("untrusted detail"), { code: "invalid-bootstrap-reply" }); };
  expect(await provision!(f.request("probe-code"), f.ports)).toMatchObject({ code: 3, reason: "invalid-bootstrap-reply" });
}, 5000);

it("preserves a known peer-lock error", async () => {
  const f = fixture();
  f.ports.withPeerLock = async () => { throw Object.assign(new Error("untrusted detail"), { code: "core-changed" }); };
  expect(await provision!(f.request("lock-code"), f.ports)).toMatchObject({ code: 1, reason: "core-changed" });
}, 5000);

it("preserves the missing adjacent npm failure in the provisioning outcome", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.ports.transfer.installRelease = async () => { throw Object.assign(new Error("missing npm"), { code: "npm-not-found" }); };
  expect(await provision!(f.request("missing-npm"), f.ports)).toMatchObject({ code: 3, reason: "npm-not-found" });
}, 5000);

it("preserves the unfiltered release evidence refusal in the provisioning outcome", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.ports.transfer.installRelease = async () => { throw Object.assign(new Error("unfiltered"), { code: "release-evidence-unfiltered" }); };
  expect(await provision!(f.request("unfiltered"), f.ports)).toMatchObject({ code: 3, reason: "release-evidence-unfiltered" });
}, 5000);

it("preserves the npm installation failure in the provisioning outcome", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.ports.transfer.installRelease = async () => { throw Object.assign(new Error("npm failed"), { code: "npm-install-failed" }); };
  expect(await provision!(f.request("npm-failed"), f.ports)).toMatchObject({ code: 3, reason: "npm-install-failed" });
}, 5000);

it("checks replacement idleness and journals both identities before continuing installation", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  const receipt = { oldCoreId: "previous-core", newCoreId: "fixture-core", oldPinSha256: "a".repeat(64), newPinSha256: "b".repeat(64) };
  const ports = { ...f.ports, async assertCorePinReplaceIdle() { f.events.push("replace-idle"); },
    transfer: { ...f.ports.transfer, async enroll(_peer: Peer, _hub: string, _unit: string, replace?: boolean) {
      if (!replace) throw new Error("replacement flag missing"); f.events.push("replacement"); return receipt;
    } } };
  expect(await provision!({ ...f.request("replace-pin"), replaceCorePin: true }, ports)).toMatchObject({ code: 0 });
  expect(f.events.indexOf("replace-idle")).toBeLessThan(f.events.indexOf("replacement"));
  expect(f.journal.read("replace-pin").find(row => row.action === "core-pin-replaced")?.result).toEqual(receipt);
});

it("refuses explicit pin replacement while the hub still assigns sessions to the box", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  const ports = { ...f.ports, async assertCorePinReplaceIdle() { throw Object.assign(new Error("busy"), { code: "core-pin-in-use" }); } };
  expect(await provision!({ ...f.request("replace-busy"), replaceCorePin: true }, ports)).toMatchObject({ reason: "core-pin-in-use" });
  expect(f.events).not.toContain("enrollment");
});

it("preserves an unreadable hub pin-check refusal", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  const ports = { ...f.ports, async assertCorePinReplaceIdle() {
    throw Object.assign(new Error("hub store cannot be read; run spider roam doctor"), { code: "core-pin-check-unavailable" });
  } };
  expect(await provision!({ ...f.request("unreadable-pin-check"), replaceCorePin: true }, ports))
    .toMatchObject({ code: 3, reason: "core-pin-check-unavailable" });
  expect(f.events).not.toContain("enrollment");
});

it("names the earlier operation that blocks provisioning", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.ports.transfer.cleanupSecrets = async () => { throw Object.assign(new Error("blocked"), {
    code: "release-in-progress", details: { blockingOperationId: "previous-op" },
  }); };
  expect(await provision!(f.request("blocked-operation"), f.ports)).toMatchObject({
    reason: "release-in-progress (previous-op)",
  });
}, 5000);

it("persists box enrollment between identity claim and release launch", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  expect(await provision!(f.request("enrollment-order"), f.ports)).toMatchObject({ code: 0 });
  expect(f.events.indexOf("enrollment")).toBeGreaterThan(f.events.indexOf("identity"));
  expect(f.events.indexOf("enrollment")).toBeLessThan(f.events.indexOf("release"));
}, 5000);

it("refuses custom pi agent directories before consent or provisioning effects", async () => {
  expect(provision).toBeTypeOf("function");
  for (const agentDir of ["/home/fixture/custom-agent", "/outside/agent", "relative-agent"]) {
    const option = fixture(); option.write(option.source, "settings.json", "{}"); option.ports.destination.agentDir = agentDir;
    const requested = await provision!(option.request("custom-option"), option.ports);
    expect(requested).toMatchObject({ code: 1, reason: "custom-agent-directory-unsupported" });
    expect(option.events).toEqual([]); expect(option.journal.read("custom-option")).toEqual([]);
  }

  const environment = fixture(); environment.write(environment.source, "settings.json", "{}"); environment.state.agentDirectory = "custom";
  const detected = await provision!(environment.request("custom-environment"), environment.ports);
  expect(detected).toMatchObject({ code: 1, reason: "custom-agent-directory-unsupported" });
  expect(environment.events).toEqual(["lock", "agent-directory-probe", "unlock"]);
  expect(environment.journal.read("custom-environment")).toEqual([]);
}, 5000);

it("names an explicit agent-directory mismatch before consent or effects", async () => {
  const f = fixture(); f.state.agentDirectory = "custom";
  f.ports.destination.agentDir = "/home/fixture/custom-agent";
  const request = f.request("directory-mismatch");
  expect(await provision!({ ...request, peer: { ...request.peer, agentDir: f.ports.destination.agentDir } }, f.ports)).toMatchObject({ code: 1, reason: "agent-directory-mismatch" });
  expect(f.events).toEqual(["lock", "agent-directory-probe", "unlock"]);
  expect(f.journal.read("directory-mismatch")).toEqual([]);
}, 5000);

it("refuses a supervisor executable outside the pinned installation prefix", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.ports.destination.supervisor = "/home/fixture/not-the-install-prefix/supervisor.mjs";
  f.journal.begin(f.request("bad-unit-dir").operation);
  f.journal.record("bad-unit-dir", "unrelated", { exists: true });
  expect(await provision!(f.request("bad-supervisor-path"), f.ports)).toMatchObject({ code: 1, reason: "invalid-provision-destination" });
  expect(f.events).toEqual([]); expect(f.journal.read("bad-supervisor-path")).toEqual([]);
}, 5000);

it("fails closed when the target agent directory cannot be verified", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.source, "settings.json", "{}"); f.state.agentDirectory = "unknown";
  const result = await provision!(f.request("unknown-environment"), f.ports);
  expect(result).toMatchObject({ code: 3, reason: "agent-directory-unverified" });
  expect(f.events).toEqual(["lock", "agent-directory-probe", "unlock"]);
  expect(f.journal.read("unknown-environment")).toEqual([]);
  const failed = fixture(); failed.write(failed.source, "settings.json", "{}");
  failed.ports.bootstrap.probeAgentDirectory = async () => { failed.events.push("agent-directory-probe"); throw new Error("fixture-secret"); };
  const unavailable = await provision!(failed.request("failed-environment"), failed.ports);
  expect(unavailable).toMatchObject({ code: 3, reason: "agent-directory-unverified" });
  expect(JSON.stringify(unavailable)).not.toContain("fixture-secret");
  expect(failed.events).toEqual(["lock", "agent-directory-probe", "unlock"]);
  expect(failed.journal.read("failed-environment")).toEqual([]);
}, 5000);

it("refuses a core replacement during consent before publishing an identity", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.source, "settings.json", "{}"); f.state.replaceCoreOnConfirm = true;
  const outcome = await provision!(f.request("changed-core"), f.ports);
  expect(outcome).toMatchObject({ code: 3, reason: "core-changed" });
  expect(existsSync(join(f.global, "roam", "machine.json"))).toBe(false);
  expect(f.events).not.toContain("identity"); expect(f.events).not.toContain("release"); expect(f.events).not.toContain("files");
}, 5000);

it("holds a per-peer lock and clears interrupted credential staging before installation", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  expect((await provision!(f.request("retry"), f.ports)).code).toBe(0);
  expect(f.events[0]).toBe("lock");
  expect(f.events.at(-1)).toBe("unlock");
  expect(f.events.indexOf("cleanup-secrets")).toBeGreaterThan(f.events.indexOf("identity"));
  expect(f.events.indexOf("cleanup-secrets")).toBeLessThan(f.events.indexOf("release"));
}, 5000);

it.each([false, true])("installs with blocked verification without touching a supervisor (hub enabled: %s)", async hubEnabled => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  const unit = f.write(f.units, "spider-roam-supervisor.service", "existing legacy unit");
  f.state.hubEnabled = hubEnabled; f.state.supervisorEnabled = true; f.state.boxEnabled = true;
  f.ports.verifyPeer = async () => { throw new Error("verification unavailable"); };
  const request = f.request(`blocked-supervisor-${hubEnabled}`);
  const outcome = await provision!(request, f.ports);
  expect(outcome).toMatchObject({ code: 0, reason: "installed-hosting-disabled", value: { hostingReady: false } });
  expect(f.state.boxEnabled).toBe(false);
  expect(f.journal.read(request.operation.id).at(-1)).toMatchObject({ action: "done", result: outcome });
  expect(readFileSync(unit, "utf8")).toBe("existing legacy unit");
  expect(f.state.supervisorEnabled).toBe(true);
  expect(f.systemctl).toEqual([]);
});

it.each([false, true])("provisions a verified release without installing either supervisor (hub enabled: %s)", async hubEnabled => {
  const f = fixture(); f.write(f.source, "settings.json", "{}"); f.state.hubEnabled = hubEnabled; f.state.verified = true;
  const request = f.request(`ready-release-${hubEnabled}`);
  const outcome = await provision!(request, f.ports);
  expect(outcome).toMatchObject({ code: 0, reason: "installed", value: { hostingReady: true } });
  expect(f.state.boxEnabled).toBe(hubEnabled);
  expect(f.journal.read(request.operation.id).at(-1)).toMatchObject({ action: "done", result: outcome });
  expect(readdirSync(f.units)).toEqual(["herdr-core.service"]);
  expect(f.systemctl).toEqual([]);
});

it.each([0, 17, 1_000_000])("reports and replays the permission-tightening count %i without paths", async count => {
  const f = fixture(); f.write(f.source, "settings.json", "{}"); f.state.verified = true; f.state.permissionTightenings = count;
  const request = f.request(`permission-count-${count}`);
  const first = await provision!(request, f.ports);
  expect(first).toMatchObject({ code: 0, value: { hostingReady: true, permissionTightenings: count } });
  expect(JSON.stringify(first)).not.toContain(f.root);
  expect(f.journal.read(request.operation.id).find(row => row.action === "done")?.result.value)
    .toMatchObject({ permissionTightenings: count });
  f.state.permissionTightenings = 0;
  const retry = await provision!(request, f.ports);
  expect(retry).toEqual(first);
  expect(f.events.filter(event => event === "permission-summary")).toHaveLength(1);
}, 5000);

it("uses null for historical completed counts and rejects corrupt saved values", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}"); f.state.verified = true;
  const request = f.request("legacy-permission-count");
  expect((await provision!(request, f.ports)).code).toBe(0);
  const begin = f.journal.begin.bind(f.journal); let savedCount: unknown = undefined;
  f.journal.begin = operation => {
    const prior = begin(operation);
    if (prior.kind !== "done" || !prior.result) return prior;
    const value = { ...(prior.result.value as Record<string, unknown>), permissionTightenings: savedCount };
    return { ...prior, result: { ...prior.result, value } as never };
  };
  const historical = await provision!(request, f.ports);
  expect(historical).toMatchObject({ code: 0, value: { permissionTightenings: null } });
  savedCount = "/fixture/private";
  const corrupt = await provision!(request, f.ports);
  expect(corrupt).toMatchObject({ code: 3, reason: "invalid-journal-result", value: null });
  expect(JSON.stringify(corrupt)).not.toContain("/fixture/private");
}, 5000);

it("provision while the hub is disabled clears a previously enabled box without starting hosting", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.state.hubEnabled = false; f.state.boxEnabled = true; f.state.verified = true;
  expect(await provision!(f.request("disabled-provision"), f.ports)).toMatchObject({ code: 0, value: { hostingReady: true } });
  expect(f.state.boxEnabled).toBe(false);
  expect(f.events).toContain("enabled:false"); expect(f.events).not.toContain("enabled:true");
  expect(f.systemctl).toEqual([]);
}, 5000);

it("disabled provision leaves no offline RPC probe process or session behind", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}"); f.state.hubEnabled = false;
  const home = join(f.root, "probe-home"), agent = join(home, ".pi", "agent"), globalRoot = join(agent, "spider"), prefix = join(home, ".local"),
    pi = join(prefix, "bin/pi"), observed = join(f.root, "probe-observed.json");
  for (const dir of [home, agent, join(globalRoot, "roam"), dirname(pi)]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(globalRoot, "roam/machine.json"), JSON.stringify({ machineId: bootstrapPeer.machineId }), { mode: 0o600 });
  writeFileSync(pi, `#!${process.execPath}\nimport fs from 'node:fs'; const a=process.argv.slice(2), file=a[a.indexOf('--session')+1];
fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({pid:process.pid,file,argv:a,agent:process.env.PI_CODING_AGENT_DIR,global:process.env.SPIDER_GLOBAL_ROOT}));
const header=JSON.parse(fs.readFileSync(file,'utf8').split('\\n')[0]); fs.readFileSync(0,'utf8');
console.log(JSON.stringify({id:'probe',type:'response',command:'get_state',success:true,data:{sessionFile:file,sessionId:header.id}}));\n`, { mode: 0o700 });
  f.ports.verifyPeer = async () => {
    const request = { action: "verify", operationId: "probe-op", machineId: bootstrapPeer.machineId, home, agentDir: agent, globalRoot, npmPrefix: prefix,
      cli: join(prefix, "lib/spider/dist/roam/cli.mjs"), pi, providers: [], files: [], maximum: DEFAULT_LIMITS.agentBytes, chunkBytes: DEFAULT_LIMITS.chunkBytes };
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", getProvisionRemoteScript()], { input: JSON.stringify(request), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, HOME: home, SPIDER_GLOBAL_ROOT: globalRoot } });
    if (child.status !== 0) throw new Error(`verification failed: ${child.stderr}`);
    const reply = JSON.parse(child.stdout); if (reply.error) throw new Error(reply.error);
    return reply.value;
  };
  expect(await provision!(f.request("disabled-offline-probe"), f.ports)).toMatchObject({ code: 0, reason: "installed-hosting-disabled" });
  const probe = JSON.parse(readFileSync(observed, "utf8"));
  expect(probe.argv).toEqual(expect.arrayContaining(["--offline", "--no-extensions", "--no-mcp", "--session"]));
  expect(probe.agent).not.toBe(agent); expect(probe.global).not.toBe(globalRoot);
  expect(existsSync(probe.file)).toBe(false); expect(existsSync(probe.agent)).toBe(false); expect(existsSync(probe.global)).toBe(false);
  expect(() => process.kill(probe.pid, 0)).toThrow();
  expect(existsSync(join(agent, "intercom/broker.sock"))).toBe(false);
  expect(f.systemctl).toEqual([]);
  expect(f.state.boxEnabled).toBe(false);
}, 5000);

it("a completed provisioning retry clears the box flag when the hub was disabled", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}"); f.state.verified = true;
  const request = f.request("completed-disabled");
  const outcome = await provision!(request, f.ports);
  expect(outcome).toMatchObject({ code: 0, value: { hostingReady: true } });
  expect(f.state.boxEnabled).toBe(true);
  const receipts = f.journal.read(request.operation.id);
  const oldUnit = f.write(f.units, "spider-roam-supervisor.service", "unrelated to this retry");
  f.systemctl.length = 0;
  f.state.hubEnabled = false;
  expect(await provision!(request, f.ports)).toEqual(outcome);
  expect(f.state.boxEnabled).toBe(false);
  expect(f.journal.read(request.operation.id)).toEqual(receipts);
  expect(readFileSync(oldUnit, "utf8")).toBe("unrelated to this retry");
  expect(f.systemctl).toEqual([]);
}, 5000);

it("without auth install succeeds but hosting remains disabled", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.source, "settings.json", JSON.stringify({ theme: "sample", packages: ["npm:pi-intercom"] }));
  const result = await provision!(f.request("no-auth"), f.ports);
  expect(result).toMatchObject({ code: 0, value: { hostingReady: false } });
  expect(f.events).not.toContain("enabled:true");
  expect(f.confirmations).toEqual([{ target: bootstrapPeer.alias, providers: [] }]);
  expect(f.events.indexOf("present")).toBeLessThan(f.events.indexOf("confirm"));
  expect(f.events.indexOf("confirm")).toBeLessThan(f.events.indexOf("identity"));
  expect(f.events).not.toContain("auth-stage");
  expect(f.secretCollectionCalls).toEqual([]);
  expect(f.persisted[0].pi).toBe(bootstrapPeer.pi);
  expect(posix.isAbsolute(f.persisted[0].pi)).toBe(true);
  const settings = JSON.parse(readFileSync(join(f.destination, "settings.json"), "utf8"));
  expect(settings).toEqual({ theme: "sample" });
  expect(settings).not.toHaveProperty("packages");
  expect(f.preview).toHaveLength(1);
}, 5000);

it("installs selected Pi files and previews their metadata without their contents", async () => {
  const f = fixture();
  f.write(f.source, "settings.json", JSON.stringify({ defaultModel: "demo", theme: "sample", defaultProjectTrust: "always", packages: ["npm:ignored"] }));
  const models = JSON.stringify({ providers: { demo: { apiKey: "${DEMO_KEY}" } } });
  f.write(f.source, "models.json", models);
  f.write(f.source, "keybindings.json", '{"app.exit":"ctrl+x"}');
  f.write(f.source, "themes/sample.json", "theme contents");
  f.write(f.source, "AGENTS.md", "instruction contents");
  f.write(f.source, "skills/check/SKILL.md", "skill contents");
  f.write(f.source, "skills/check/references/guide.md", "support contents");
  f.write(f.source, "skills/unselected/SKILL.md", "do not copy");
  const result = await provision!(f.request("portable", false, [], ["settings.json", "models.json", "keybindings.json", "themes", "AGENTS.md", "skills/check"]), f.ports);
  expect(result).toMatchObject({ code: 0 });
  expect(JSON.parse(readFileSync(join(f.destination, "settings.json"), "utf8"))).toEqual({ defaultModel: "demo", theme: "sample" });
  expect(readFileSync(join(f.destination, "models.json"), "utf8")).toBe(models);
  expect(readFileSync(join(f.destination, "keybindings.json"), "utf8")).toBe('{"app.exit":"ctrl+x"}');
  expect(readFileSync(join(f.destination, "themes/sample.json"), "utf8")).toBe("theme contents");
  expect(readFileSync(join(f.destination, "AGENTS.md"), "utf8")).toBe("instruction contents");
  expect(readFileSync(join(f.destination, "skills/check/references/guide.md"), "utf8")).toBe("support contents");
  expect(existsSync(join(f.destination, "skills/unselected"))).toBe(false);
  expect(f.preview[0]).toMatchObject({ selectedFiles: [
    { path: "AGENTS.md", size: 20, mode: 0o600 }, { path: "keybindings.json", size: 21, mode: 0o600 },
    { path: "models.json", size: Buffer.byteLength(models), mode: 0o600 },
    { path: "settings.json", size: Buffer.byteLength('{\n  "defaultModel": "demo",\n  "theme": "sample"\n}\n'), mode: 0o600 },
    { path: "skills/check/SKILL.md", size: 14, mode: 0o600 }, { path: "skills/check/references/guide.md", size: 16, mode: 0o600 },
    { path: "themes/sample.json", size: 14, mode: 0o600 },
  ], settingsKeys: ["defaultModel", "theme"] });
  expect(JSON.stringify({ result, preview: f.preview, events: f.events })).not.toContain("instruction contents");
  expect(JSON.stringify({ result, preview: f.preview, events: f.events })).not.toContain("support contents");
}, 5000);

it("preserves precise box-only numbers when switchover removes legacy intercom", async () => {
  const f = fixture(); f.write(f.source, "settings.json", '{"theme":"source-theme"}');
  const target = f.write(f.destination, "settings.json", '{"theme":"old-theme","large":9007199254740993,"nested":{"huge":1e400},"packages":["npm:pi-intercom","npm:other"]}');
  expect(await provision!(f.request("settings-precise-switchover"), f.ports)).toMatchObject({ code: 0 });
  const result = readFileSync(target, "utf8");
  expect(result).toContain('"large": 9007199254740993'); expect(result).toContain('"huge": 1e400');
  expect(JSON.parse(result).packages).toEqual(["npm:other"]); expect(JSON.parse(result).theme).toBe("source-theme");
}, 5000);

it("previews only settings keys whose values will actually change on the box", async () => {
  const f = fixture();
  f.write(f.source, "settings.json", JSON.stringify({ defaultModel: "same-model", theme: "new-theme",
    compaction: { reserveTokens: 200, keepRecentTokens: 50, modelOverrides: { "demo/a": { reserveTokens: 900 } } } }));
  f.write(f.destination, "settings.json", JSON.stringify({ defaultModel: "same-model", theme: "old-theme", defaultProjectTrust: "never",
    compaction: { reserveTokens: 100, keepRecentTokens: 50, modelOverrides: { "demo/a": { reserveTokens: 800, local: "keep" } } } }));
  const result = await provision!(f.request("settings-preview"), f.ports);
  expect(result.code).toBe(0);
  expect(f.preview[0]).toMatchObject({ settingsKeys: ["compaction.modelOverrides.demo/a.reserveTokens", "compaction.reserveTokens", "theme"] });
  expect(JSON.stringify(f.preview)).not.toContain("new-theme"); expect(JSON.stringify(f.preview)).not.toContain("old-theme");
  expect(JSON.parse(readFileSync(join(f.destination, "settings.json"), "utf8"))).toMatchObject({ defaultProjectTrust: "never", theme: "new-theme" });
}, 5000);

it("refuses invalid box settings before identity, release, or file changes", async () => {
  const f = fixture(); f.write(f.source, "settings.json", '{"theme":"sample"}');
  const target = f.write(f.destination, "settings.json", "[invalid");
  const outcome = await provision!(f.request("invalid-settings"), f.ports);
  expect(outcome).toMatchObject({ code: 1, reason: "invalid-destination-settings" });
  for (const action of ["confirm", "identity", "enrollment", "cleanup-secrets", "release", "files", "switchover"]) expect(f.events).not.toContain(action);
  expect(readFileSync(target, "utf8")).toBe("[invalid");
  expect(existsSync(`${target}.spider-roam.bak`)).toBe(false);
}, 5000);

it("checks box settings before provisioning even when the Mac has no settings file", async () => {
  const f = fixture(); f.write(f.source, "AGENTS.md", "fixture instructions");
  const target = f.write(f.destination, "settings.json", "[invalid");
  const outcome = await provision!(f.request("invalid-settings-without-source", false, [], ["AGENTS.md"]), f.ports);
  expect(outcome).toMatchObject({ code: 1, reason: "invalid-destination-settings" });
  for (const action of ["confirm", "identity", "enrollment", "cleanup-secrets", "release", "files", "switchover"]) expect(f.events).not.toContain(action);
  expect(readFileSync(target, "utf8")).toBe("[invalid"); expect(existsSync(join(f.destination, "AGENTS.md"))).toBe(false);
}, 5000);

it("rechecks box settings after consent even without a source settings file", async () => {
  const f = fixture(); f.write(f.source, "AGENTS.md", "fixture instructions");
  const target = f.write(f.destination, "settings.json", '{"defaultProjectTrust":"never"}');
  f.ports.confirm = async () => { f.events.push("confirm"); f.write(f.destination, "settings.json", "[invalid"); return true; };
  const outcome = await provision!(f.request("invalid-after-consent", false, [], ["AGENTS.md"]), f.ports);
  expect(outcome).toMatchObject({ code: 1, reason: "invalid-destination-settings" });
  for (const action of ["identity", "enrollment", "cleanup-secrets", "release", "files", "switchover"]) expect(f.events).not.toContain(action);
  expect(readFileSync(target, "utf8")).toBe("[invalid"); expect(existsSync(join(f.destination, "AGENTS.md"))).toBe(false);
}, 5000);

it("refuses a box settings change made during consent before target-side mutation", async () => {
  const f = fixture(); f.write(f.source, "settings.json", '{"theme":"source-theme"}');
  const target = f.write(f.destination, "settings.json", '{"theme":"old-theme","defaultProjectTrust":"never"}');
  f.ports.confirm = async () => {
    f.events.push("confirm"); f.write(f.destination, "settings.json", '{"theme":"other-theme","defaultProjectTrust":"never"}'); return true;
  };
  const outcome = await provision!(f.request("settings-race"), f.ports);
  expect(outcome).toMatchObject({ code: 1, reason: "settings-preview-changed" });
  for (const action of ["identity", "enrollment", "cleanup-secrets", "release", "files", "switchover"]) expect(f.events).not.toContain(action);
  expect(readFileSync(target, "utf8")).toBe('{"theme":"other-theme","defaultProjectTrust":"never"}');
  expect(existsSync(`${target}.spider-roam.bak`)).toBe(false);
}, 5000);

it("does not overwrite a box edit made after the final preview and before the settings write", async () => {
  const f = fixture(); f.write(f.source, "settings.json", '{"theme":"source-theme"}');
  const target = f.write(f.destination, "settings.json", '{"theme":"old-theme","defaultProjectTrust":"never"}');
  const install = f.ports.transfer.installFiles;
  f.ports.transfer.installFiles = async (peer, files, expectedSettingsFingerprint) => {
    f.write(f.destination, "settings.json", '{"theme":"late-edit","defaultProjectTrust":"never"}');
    await install(peer, files, expectedSettingsFingerprint);
  };
  expect(await provision!(f.request("settings-late-race"), f.ports)).toMatchObject({ code: 3, reason: "settings-preview-changed" });
  expect(readFileSync(target, "utf8")).toBe('{"theme":"late-edit","defaultProjectTrust":"never"}');
  expect(existsSync(`${target}.spider-roam.bak`)).toBe(false); expect(f.events).not.toContain("switchover");
}, 5000);

it("reports done without changing bytes when the box settings file was initially missing", async () => {
  const f = fixture(); f.write(f.source, "settings.json", '{"theme":"source-theme"}');
  const target = join(f.destination, "settings.json"), request = f.request("settings-missing");
  expect(await provision!(request, f.ports)).toMatchObject({ code: 0 });
  const first = readFileSync(target), firstFileWrites = f.events.filter(value => value === "files").length;
  expect(JSON.parse(first.toString("utf8"))).toEqual({ theme: "source-theme" });
  expect(await provision!(request, f.ports)).toMatchObject({ code: 0 });
  expect(readFileSync(target)).toEqual(first); expect(f.events.filter(value => value === "files")).toHaveLength(firstFileWrites);
  expect(existsSync(`${target}.spider-roam.bak`)).toBe(false); expect(f.confirmations).toHaveLength(1);
}, 5000);

it("retries a lost settings-write reply using the approved preview and first backup", async () => {
  const f = fixture(); f.write(f.source, "settings.json", '{"theme":"source-theme"}');
  const original = '{"theme":"old-theme","defaultProjectTrust":"never"}', target = f.write(f.destination, "settings.json", original);
  const install = f.ports.transfer.installFiles; let lost = false;
  f.ports.transfer.installFiles = async (peer, files, expectedSettingsFingerprint) => {
    await install(peer, files, expectedSettingsFingerprint);
    if (!lost) { lost = true; throw Object.assign(new Error("reply lost"), { code: "cli-timeout" }); }
  };
  expect(await provision!(f.request("settings-retry"), f.ports)).toMatchObject({ code: 3, reason: "cli-timeout" });
  const first = readFileSync(target), backup = `${target}.spider-roam.bak`;
  expect(readFileSync(backup, "utf8")).toBe(original);
  expect(await provision!(f.request("settings-retry"), f.ports)).toMatchObject({ code: 0 });
  expect(readFileSync(target)).toEqual(first); expect(readFileSync(backup, "utf8")).toBe(original);
  expect(f.confirmations).toHaveLength(1);
}, 5000);

it("does not reuse consent after a box settings edit between interrupted retries", async () => {
  const f = fixture(); f.write(f.source, "settings.json", '{"theme":"source-theme"}');
  const target = f.write(f.destination, "settings.json", '{"theme":"old-theme"}');
  const install = f.ports.transfer.installFiles; let lost = false;
  f.ports.transfer.installFiles = async (peer, files, expectedSettingsFingerprint) => {
    await install(peer, files, expectedSettingsFingerprint);
    if (!lost) { lost = true; throw Object.assign(new Error("reply lost"), { code: "cli-timeout" }); }
  };
  expect(await provision!(f.request("settings-retry-edited"), f.ports)).toMatchObject({ code: 3, reason: "cli-timeout" });
  f.write(f.destination, "settings.json", '{"theme":"external-edit"}');
  expect(await provision!(f.request("settings-retry-edited"), f.ports)).toMatchObject({ code: 1, reason: "settings-preview-changed" });
  expect(readFileSync(target, "utf8")).toBe('{"theme":"external-edit"}');
  expect(f.confirmations).toHaveLength(1); expect(f.events.filter(value => value === "identity")).toHaveLength(1);
}, 5000);

it("copies credential-bearing settings through the private consented merge", async () => {
  const f = fixture(), secret = "fixture-secret", model = `https://models.invalid/?token=${secret}`;
  f.write(f.source, "settings.json", JSON.stringify({ defaultModel: model }));
  f.write(f.source, "auth.json", JSON.stringify({ "github-copilot": { type: "oauth", access: "fixture-auth" } }));
  const target = f.write(f.destination, "settings.json", '{"defaultModel":"old-model","defaultProjectTrust":"never"}');
  expect(await provision!(f.request("settings-secret-denied", true, ["github-copilot"]), f.ports)).toMatchObject({ code: 1, reason: "provider-consent-required" });
  expect(f.events).not.toContain("identity");
  const outcome = await provision!(f.request("settings-secret-approved", true, ["settings", "github-copilot"]), f.ports);
  expect(outcome).toMatchObject({ code: 0 }); expect(f.events).toContain("credential-files");
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ defaultModel: model, defaultProjectTrust: "never" });
  expect(JSON.stringify({ outcome, preview: f.preview, events: f.events })).not.toContain(secret);
}, 5000);

it("copies credential-bearing model definitions only after consent for their provider", async () => {
  const f = fixture(), models = JSON.stringify({ providers: { demo: { apiKey: "fixture-secret" } } });
  f.write(f.source, "models.json", models);
  f.write(f.source, "auth.json", JSON.stringify({ "github-copilot": { type: "oauth", access: "auth-secret" } }));
  const denied = await provision!(f.request("model-denied", true, ["github-copilot"], ["models.json"]), f.ports);
  expect(denied).toMatchObject({ code: 1, reason: "provider-consent-required" });
  expect(f.events).not.toContain("identity"); expect(existsSync(join(f.destination, "models.json"))).toBe(false);
  const approved = await provision!(f.request("model-approved", true, ["demo", "github-copilot"], ["models.json"]), f.ports);
  expect(approved).toMatchObject({ code: 0 });
  expect(f.confirmations).toEqual([{ target: bootstrapPeer.alias, providers: ["demo", "github-copilot"] }]);
  expect(f.events).toContain("credential-files");
  expect(readFileSync(join(f.destination, "models.json"), "utf8")).toBe(models);
  expect(JSON.stringify({ denied, approved, preview: f.preview, events: f.events })).not.toContain("fixture-secret");
  expect(JSON.stringify({ denied, approved, preview: f.preview, events: f.events })).not.toContain("auth-secret");
}, 5000);

it.each([false, true])("clears credential configuration bytes after transfer (failure: %s)", async fail => {
  const f = fixture();
  f.write(f.source, "models.json", JSON.stringify({ providers: { demo: { apiKey: "fixture-secret" } } }));
  f.write(f.source, "auth.json", JSON.stringify({ "github-copilot": { type: "oauth", access: "auth-secret" } }));
  const install = f.ports.transfer.installCredentialFiles, retained: Buffer[] = [];
  f.ports.transfer.installCredentialFiles = async (peer, files, providers) => {
    retained.push(...files.map(file => file.bytes));
    expect(providers).toEqual(["demo"]);
    if (fail) throw new Error("transfer failed");
    await install(peer, files, providers);
  };
  const outcome = await provision!(f.request(`clear-secret-${fail}`, true, ["demo", "github-copilot"], ["models.json"]), f.ports);
  expect(outcome.code).toBe(fail ? 3 : 0);
  expect(retained).toHaveLength(1);
  expect(retained[0].length).toBeGreaterThan(0);
  expect(retained[0].every(byte => byte === 0)).toBe(true);
}, 5000);

it("includes the selected auth payload in the metadata-only preview", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.write(f.source, "auth.json", JSON.stringify({ "github-copilot": { type: "oauth", access: "fixture-secret" }, other: { key: "other-secret" } }));
  expect(await provision!(f.request("auth-preview", true, ["github-copilot"]), f.ports)).toMatchObject({ code: 0 });
  const size = Buffer.byteLength('{"github-copilot":{"type":"oauth","access":"fixture-secret"}}\n');
  expect(f.preview[0]).toMatchObject({ selectedFiles: expect.arrayContaining([{ path: "auth.json", size, mode: 0o600 }]) });
  expect(JSON.stringify(f.preview)).not.toContain("fixture-secret"); expect(JSON.stringify(f.preview)).not.toContain("other-secret");
}, 5000);

it("refused provider consent leaves identity and auth unmodified", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.state.allow = false; f.write(f.source, "settings.json", "{}");
  f.write(f.source, "auth.json", JSON.stringify({ "github-copilot": { type: "oauth", access: "fixture-secret" } }));
  const result = await provision!(f.request("refused", true, ["github-copilot"]), f.ports);
  expect(result).toMatchObject({ code: 1, reason: "consent-refused" });
  expect(f.events).not.toContain("identity");
  expect(f.events).not.toContain("auth-stage");
  expect(existsSync(join(f.global, "roam", "machine.json"))).toBe(false);
  expect(existsSync(join(f.destination, "auth.json"))).toBe(false);
}, 5000);

it("changed selected files after preview are refused before consent and target-side effects", async () => {
  const f = fixture(); f.write(f.source, "settings.json", '{"theme":"changed"}');
  const result = await provision!({ ...f.request("files-changed"), expectedFiles: [{ path: "settings.json", size: 1, mode: 0o600 }] }, f.ports);
  expect(result).toMatchObject({ code: 1, reason: "selected-files-changed" });
  expect(f.events).not.toContain("confirm"); expect(f.events).not.toContain("identity"); expect(f.events).not.toContain("files");
}, 5000);

it("refuses selected bytes that differ from the preview even when their size matches", async () => {
  const f = fixture(); f.write(f.source, "settings.json", '{"theme":"later"}');
  const previewBytes = Buffer.from('{\n  "theme": "first"\n}\n');
  const digest = createHash("sha256").update(JSON.stringify([{ path: "settings.json", mode: 0o600,
    sha256: createHash("sha256").update(previewBytes).digest("hex") }])).digest("hex");
  const outcome = await provision!({ ...f.request("same-size-change"), expectedSelectionDigest: digest,
    expectedFiles: [{ path: "settings.json", size: previewBytes.length, mode: 0o600 }] }, f.ports);
  expect(outcome).toMatchObject({ code: 1, reason: "selected-files-changed" });
  expect(f.events).not.toContain("confirm"); expect(f.events).not.toContain("identity"); expect(f.events).not.toContain("files");
}, 5000);

it("changed auth after preview is refused before target-side effects", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  const original = { type: "oauth", access: "first-fixture" };
  f.write(f.source, "auth.json", JSON.stringify({ "github-copilot": original }));
  const expectedAuthBytes = Buffer.byteLength(JSON.stringify({ "github-copilot": original }) + "\n");
  f.ports.confirm = async () => { f.events.push("confirm"); f.write(f.source, "auth.json", JSON.stringify({ "github-copilot": { type: "oauth", access: "longer-changed-fixture" } })); return true; };
  const result = await provision!({ ...f.request("auth-changed", true, ["github-copilot"]), expectedAuthBytes }, f.ports);
  expect(result).toMatchObject({ code: 1, reason: "auth-preview-changed" });
  expect(f.events).not.toContain("identity"); expect(f.events).not.toContain("release"); expect(f.events).not.toContain("auth-stage");
  expect(JSON.stringify({ result, events: f.events })).not.toContain("longer-changed-fixture");
}, 5000);

it("auth changed during release installation is not staged", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  const original = { type: "oauth", access: "first-fixture" };
  f.write(f.source, "auth.json", JSON.stringify({ "github-copilot": original }));
  const expectedAuthBytes = Buffer.byteLength(JSON.stringify({ "github-copilot": original }) + "\n");
  const install = f.ports.transfer.installRelease;
  f.ports.transfer.installRelease = async (peer, input) => {
    const result = await install(peer, input);
    f.write(f.source, "auth.json", JSON.stringify({ "github-copilot": { type: "oauth", access: "longer-changed-fixture" } }));
    return result;
  };
  const result = await provision!({ ...f.request("auth-changed-later", true, ["github-copilot"]), expectedAuthBytes }, f.ports);
  expect(result).toMatchObject({ code: 3, reason: "auth-preview-changed" });
  expect(f.events).toContain("release"); expect(f.events).not.toContain("auth-stage"); expect(f.events).not.toContain("auth-install");
}, 5000);

it("secret commands are never executed and consented auth staging is removed", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.write(f.source, "auth.json", JSON.stringify({ "github-copilot": { type: "oauth", access: "fixture-secret" }, other: { type: "api_key", key: "other-secret" } }));
  const result = await provision!(f.request("with-auth", true, ["github-copilot"]), f.ports);
  expect(result).toMatchObject({ code: 0, value: { hostingReady: false } });
  expect(f.events).not.toContain("enabled:true");
  expect(f.confirmations).toEqual([{ target: bootstrapPeer.alias, providers: ["github-copilot"] }]);
  expect(JSON.parse(readFileSync(join(f.destination, "auth.json"), "utf8"))).toEqual({ "github-copilot": { type: "oauth", access: "fixture-secret" } });
  expect(existsSync(f.stageFile)).toBe(false);
  expect(f.events.indexOf("auth-stage")).toBeGreaterThan(f.events.indexOf("confirm"));
  expect(f.secretCollectionCalls).toEqual([]);
  expect(JSON.stringify({ result, events: f.events, preview: f.preview, diagnostics: f.diagnostics })).not.toContain("fixture-secret");
}, 5000);

it("ready reprovision backs up once without changing supervisor units", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.destination, "settings.json", JSON.stringify({ theme: "original" }));
  f.write(f.source, "settings.json", JSON.stringify({ theme: "first" }));
  f.state.verified = true;
  const v0Unit = f.write(f.units, "spider-roam-supervisor-v0.service", "existing v0 unit");
  expect((await provision!(f.request("first"), f.ports)).code).toBe(0);
  f.write(f.source, "settings.json", JSON.stringify({ theme: "second" }));
  expect((await provision!(f.request("second"), f.ports)).code).toBe(0);
  expect(JSON.parse(readFileSync(join(f.destination, "settings.json.spider-roam.bak"), "utf8"))).toEqual({ theme: "original" });
  expect(JSON.parse(readFileSync(join(f.destination, "settings.json"), "utf8"))).toEqual({ theme: "second" });
  expect(readdirSync(f.units).sort()).toEqual(["herdr-core.service", "spider-roam-supervisor-v0.service"]);
  expect(readFileSync(v0Unit, "utf8")).toBe("existing v0 unit");
  expect(f.systemctl).toEqual([]);
}, 5000);

it("provisions when a recorded diagnostic core unit has vanished", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}"); f.state.verified = true;
  f.value.core = { unit: null, unitExists: false, unitOwned: false, transient: null, socketExists: true, socketOwned: true };
  const before = readFileSync(f.coreFile), terminals = readFileSync(f.terminals);
  expect(await provision!(f.request("missing-diagnostic-unit"), f.ports)).toMatchObject({ code: 0 });
  expect(readFileSync(f.coreFile)).toEqual(before);
  expect(readFileSync(f.terminals)).toEqual(terminals);
  expect(f.systemctl).toEqual([]);
});

it("core unit bytes and terminals remain unchanged", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.source, "settings.json", "{}"); f.state.verified = true;
  const core = readFileSync(f.coreFile), terminals = readFileSync(f.terminals);
  expect((await provision!(f.request("core-safe"), f.ports)).code).toBe(0);
  expect(readFileSync(f.coreFile)).toEqual(core);
  expect(readFileSync(f.terminals)).toEqual(terminals);
  expect(f.systemctl).toEqual([]);
}, 5000);

it("reports a pending release and resumes the same operation without repeating consent", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  const install = f.ports.transfer.installRelease; let pending = true;
  f.ports.transfer.installRelease = async (peer, input) => {
    if (pending) { pending = false; throw Object.assign(new Error("pending"), { code: "release-pending" }); }
    return install(peer, input);
  };
  expect(await provision!(f.request("pending-release"), f.ports)).toMatchObject({ code: 3, reason: "release-pending" });
  expect(f.events).not.toContain("files");
  expect(await provision!(f.request("pending-release"), f.ports)).toMatchObject({ code: 0 });
  expect(f.confirmations).toHaveLength(1);
  expect(f.events.filter(event => event === "identity")).toHaveLength(2);
}, 5000);

it("refuses changed selected-file contents on a retry of the same operation", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.source, "settings.json", '{"theme":"first"}');
  f.ports.transfer.installRelease = async () => { throw Object.assign(new Error("pending"), { code: "release-pending" }); };
  expect(await provision!(f.request("retry-file"), f.ports)).toMatchObject({ code: 3, reason: "release-pending" });
  f.write(f.source, "settings.json", '{"theme":"second"}');
  expect(await provision!(f.request("retry-file"), f.ports)).toMatchObject({ code: 1, reason: "operation-arguments-changed" });
  expect(f.confirmations).toHaveLength(1);
  expect(f.events.filter(event => event === "identity")).toHaveLength(1);
}, 5000);

it("does not reuse consent when a retry observes a different permanent core", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.ports.transfer.installRelease = async () => { throw Object.assign(new Error("pending"), { code: "release-pending" }); };
  expect(await provision!(f.request("retry-core"), f.ports)).toMatchObject({ code: 3, reason: "release-pending" });
  f.state.coreId = "replacement-core";
  expect(await provision!(f.request("retry-core"), f.ports)).toMatchObject({ code: 1, reason: "operation-arguments-changed" });
  expect(f.confirmations).toHaveLength(1);
  expect(f.events.filter(event => event === "identity")).toHaveLength(1);
}, 5000);

it("refuses an identity mismatch before release or file installation", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.source, "settings.json", "{}"); f.state.existingId = "22222222-2222-4222-8222-222222222222";
  const result = await provision!(f.request("mismatch"), f.ports);
  expect(result).toMatchObject({ code: 1, reason: "machine-mismatch" });
  expect(f.events).not.toContain("release");
  expect(f.events).not.toContain("files");
  expect(JSON.parse(readFileSync(join(f.global, "roam", "machine.json"), "utf8"))).toEqual({ machineId: f.state.existingId });
}, 5000);

it("lists files with unsupported paths or credential commands without exposing their values", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(), foreign = ["", "Users", "fixture", "private"].join("/");
  f.write(f.source, "models.json", JSON.stringify({ providers: { demo: { baseUrl: foreign } } }));
  const pathError = await provision!(f.request("bad-path", false, [], ["models.json"]), f.ports);
  expect(pathError).toMatchObject({ code: 1 }); expect(pathError.reason).toContain("unsupported-path");
  expect(pathError.reason).toContain("models.json"); expect(pathError.reason).not.toContain(foreign);
  f.write(f.source, "models.json", JSON.stringify({ providers: { demo: { apiKey: "!fixture-command" } } }));
  const commandError = await provision!(f.request("bad-command", false, [], ["models.json"]), f.ports);
  expect(commandError.reason).toContain("unsupported-credential-command"); expect(commandError.reason).toContain("models.json");
  expect(commandError.reason).not.toContain("fixture-command"); expect(f.events).not.toContain("identity");
  const invalid = await provision!(f.request("bad-selection", false, [], [foreign]), f.ports);
  expect(invalid.reason).toBe("selection-not-allowed"); expect(invalid.reason).not.toContain(foreign);
}, 5000);

it("refuses a release hash mismatch before identity creation", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.source, "settings.json", "{}"); f.write(f.source, "spider.tgz", "different release");
  const result = await provision!(f.request("bad-release"), f.ports);
  expect(result).toMatchObject({ code: 1, reason: "release-digest-mismatch" });
  expect(f.events).not.toContain("identity");
  expect(f.events).not.toContain("release");
}, 5000);

it("requires every readiness check before declaring hosting ready", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.source, "settings.json", "{}"); f.state.verified = true;
  const result = await provision!(f.request("verified"), f.ports);
  expect(result).toMatchObject({ code: 0, value: { hostingReady: true } });
  f.ports.verifyPeer = async () => ({ corePin: "ready", piSignedIn: true, nativeSqlite: true, extensionLoaded: true, exactSession: true, privateModes: true,
    bundledIntercom: true, intercomUnique: true, legacyDrained: false, federation: true,
    intercomEvidence: { settings: "settings-unique", legacy: "legacy-pending-asks", federation: "federation-v1", otherExtensions: [] } });
  const blocked = await provision!(f.request("legacy"), f.ports);
  expect(blocked).toMatchObject({ code: 0, value: { hostingReady: false } });
}, 5000);


it.each(["missing", "unsafe", "ready"] as const)("checks destination sign-in metadata before effects: %s", async status => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.ports.source.piProviders = [];
  f.value.auth.pi = { present: status !== "missing", readable: status !== "missing", modeSafe: status === "ready" };
  const request = { ...f.request("destination-auth"), requireDestinationAuth: true };
  const result = await provision!(request, f.ports);
  expect(result).toMatchObject(status === "ready" ? { code: 0 } : { code: 1, reason: status === "missing" ? "destination-auth-missing" : "destination-auth-unsafe" });
  expect(f.events.includes("identity")).toBe(status === "ready");
  expect(f.events).not.toContain("auth-stage"); expect(f.events).not.toContain("auth-install");
}, 5000);

it("accepts an explicitly configured private agent directory", async () => {
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  const agentDir = "/home/fixture/install/agent";
  f.ports.destination.agentDir = agentDir;
  expect(await provision!({ ...f.request("explicit-agent"), peer: { ...bootstrapPeer, agentDir } }, f.ports)).toMatchObject({ code: 0 });
  expect(f.events).toContain("files");
}, 5000);
