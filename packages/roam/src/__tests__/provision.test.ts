import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { claimMachineIdentity } from "@spider/db-core/roam/machine";
import { applyIntercomSwitchover, filesystemSwitchoverPorts } from "../../../../scripts/intercom-switchover.mjs";
import { DEFAULT_LIMITS } from "../contracts";
import type { Outcome, Peer, Transport } from "../contracts";
import { openJournal } from "../journal";
import { installPiAuth } from "../auth";
import { installSelectedFiles } from "../selected-files";
import type { SelectedFile } from "../selected-files";
import * as provisionModule from "../provision";
import { bootstrapPeer, healthyInventory } from "./bootstrap-fixture";

type Provision = (input: { operation: { id: string; machineId: string; expectedEpoch: null; kind: string; args: Record<string, never> }; peer: Peer;
  selected: readonly string[]; includeAuth: boolean; confirmedProviders: readonly string[] }, ports: unknown) => Promise<Outcome<{ hostingReady: boolean }>>;
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
  const state = { allow: true, existingId: null as string | null, verified: false, agentDirectory: "default" as "default" | "custom" | "unknown",
    coreId: "fixture-core", replaceCoreOnConfirm: false };
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
    transport, journal, limits: DEFAULT_LIMITS, coreUnit: "herdr-core.service",
    async withPeerLock<T>(_machineId: string, work: () => Promise<T>): Promise<T> { events.push("lock"); try { return await work(); } finally { events.push("unlock"); } },
    async confirm(target: string, providers: readonly string[]) {
      events.push("confirm"); confirmations.push({ target, providers: [...providers] });
      if (state.replaceCoreOnConfirm) state.coreId = "replacement-core";
      return state.allow;
    },
    systemd: {
      unitDir: "/home/fixture/.config/systemd/user",
      async writeUnit(name: string, bytes: string) { events.push("unit"); write(units, name, bytes); },
      async systemctl(argv: readonly string[]) { events.push("systemctl"); systemctl.push([...argv]); },
    },
    async resources() { throw new Error("local resource probe is forbidden"); },
    async bootId() { throw new Error("local boot probe is forbidden"); },
    release: { pi: "1.2.0", intercom: "spider-owned", spiderSha256: sha256, nodeRange: "22.23.4 || 26.4.0" },
    source: { agentRoot: source, releaseFile, piProviders: ["github-copilot"] }, destination: virtual,
    async present(value: unknown) { events.push("present"); preview.push(value); },
    async report(value: unknown) { events.push("report"); diagnostics.push(value); },
    async verifyPeer() {
      return { piSignedIn: state.verified, nativeSqlite: true, extensionLoaded: true, exactSession: true, privateModes: true,
        bundledIntercom: true, intercomUnique: true, legacyDrained: true, federation: true };
    },
    bootstrap: { async probeAgentDirectory() {
      events.push("agent-directory-probe"); return { status: state.agentDirectory, core: { local: "fixture-local-core", remote: state.coreId } };
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
      async cleanupSecrets(_peer: Peer) { events.push("cleanup-secrets"); },
      async installRelease(_peer: Peer, input: { bytes: Buffer; sha256: string; npmPrefix: string; globalRoot: string; pi: string; intercom: string }) {
        events.push("release");
        expect(createHash("sha256").update(input.bytes).digest("hex")).toBe(input.sha256);
        expect(input).toMatchObject({ npmPrefix: virtual.npmPrefix, globalRoot: bootstrapPeer.globalRoot, pi: "1.2.0", intercom: "spider-owned" });
        return { pi: bootstrapPeer.pi, cli: bootstrapPeer.cli, supervisor: virtual.supervisor };
      },
      async installFiles(_peer: Peer, files: readonly SelectedFile[]) { events.push("files"); installSelectedFiles({ destinationRoot: destination, files }); },
      async installCredentialFiles(_peer: Peer, files: readonly SelectedFile[]) { events.push("credential-files"); installSelectedFiles({ destinationRoot: destination, files }); },
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
  };
  const request = (id: string, includeAuth = false, providers: readonly string[] = [], selected: readonly string[] = ["settings.json"]) => ({
    operation: { id, machineId: bootstrapPeer.machineId, expectedEpoch: null, kind: "provision", args: {} }, peer: bootstrapPeer,
    selected, includeAuth, confirmedProviders: providers,
  });
  return { root, source, destination, staging, units, global, journal, write, releaseFile, coreFile, terminals, stageFile, state, events, confirmations, persisted, preview,
    diagnostics, systemctl, secretCollectionCalls, value, ports, request };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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

it("refuses a supervisor unit outside the user systemd directory", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.ports.systemd.unitDir = "/home/fixture/not-systemd";
  expect(await provision!(f.request("bad-unit-dir"), f.ports)).toMatchObject({ code: 1, reason: "invalid-provision-destination" });
  expect(f.events).toEqual([]); expect(f.journal.read("bad-unit-dir")).toEqual([]);
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

it("without auth install succeeds but hosting remains disabled", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.source, "settings.json", JSON.stringify({ theme: "sample", packages: ["npm:pi-intercom"] }));
  const result = await provision!(f.request("no-auth"), f.ports);
  expect(result).toMatchObject({ code: 0, value: { hostingReady: false } });
  expect(f.confirmations).toEqual([{ target: bootstrapPeer.alias, providers: [] }]);
  expect(f.events.indexOf("present")).toBeLessThan(f.events.indexOf("confirm"));
  expect(f.events.indexOf("confirm")).toBeLessThan(f.events.indexOf("identity"));
  expect(f.events).not.toContain("auth-stage");
  expect(f.secretCollectionCalls).toEqual([]);
  expect(f.persisted[0].pi).toBe(bootstrapPeer.pi);
  expect(posix.isAbsolute(f.persisted[0].pi)).toBe(true);
  expect(JSON.parse(readFileSync(join(f.destination, "settings.json"), "utf8"))).toEqual({ theme: "sample", packages: [] });
  expect(f.preview).toHaveLength(1);
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

it("secret commands are never executed and consented auth staging is removed", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  f.write(f.source, "auth.json", JSON.stringify({ "github-copilot": { type: "oauth", access: "fixture-secret" }, other: { type: "api_key", key: "other-secret" } }));
  const result = await provision!(f.request("with-auth", true, ["github-copilot"]), f.ports);
  expect(result).toMatchObject({ code: 0, value: { hostingReady: false } });
  expect(f.confirmations).toEqual([{ target: bootstrapPeer.alias, providers: ["github-copilot"] }]);
  expect(JSON.parse(readFileSync(join(f.destination, "auth.json"), "utf8"))).toEqual({ "github-copilot": { type: "oauth", access: "fixture-secret" } });
  expect(existsSync(f.stageFile)).toBe(false);
  expect(f.events.indexOf("auth-stage")).toBeGreaterThan(f.events.indexOf("confirm"));
  expect(f.secretCollectionCalls).toEqual([]);
  expect(JSON.stringify({ result, events: f.events, preview: f.preview, diagnostics: f.diagnostics })).not.toContain("fixture-secret");
}, 5000);

it("reprovision backs up once and creates one unit", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.destination, "settings.json", JSON.stringify({ theme: "original" }));
  f.write(f.source, "settings.json", JSON.stringify({ theme: "first" }));
  expect((await provision!(f.request("first"), f.ports)).code).toBe(0);
  f.write(f.source, "settings.json", JSON.stringify({ theme: "second" }));
  expect((await provision!(f.request("second"), f.ports)).code).toBe(0);
  expect(JSON.parse(readFileSync(join(f.destination, "settings.json.spider-roam.bak"), "utf8"))).toEqual({ theme: "original" });
  expect(JSON.parse(readFileSync(join(f.destination, "settings.json"), "utf8"))).toEqual({ theme: "second" });
  expect(readdirSync(f.units).filter(name => name === "spider-roam-supervisor.service")).toHaveLength(1);
  const unit = readFileSync(join(f.units, "spider-roam-supervisor.service"), "utf8");
  expect(unit).toContain("PartOf=herdr-core.service");
  expect(unit).toContain('Environment="PI_CODING_AGENT_DIR=/home/fixture/.pi/agent"');
  expect(unit).toContain("WantedBy=default.target");
}, 5000);

it("core unit bytes and terminals remain unchanged", async () => {
  expect(provision).toBeTypeOf("function");
  const f = fixture(); f.write(f.source, "settings.json", "{}");
  const core = readFileSync(f.coreFile), terminals = readFileSync(f.terminals);
  expect((await provision!(f.request("core-safe"), f.ports)).code).toBe(0);
  expect(readFileSync(f.coreFile)).toEqual(core);
  expect(readFileSync(f.terminals)).toEqual(terminals);
  expect(f.systemctl).toEqual([["--user", "daemon-reload"], ["--user", "enable", "spider-roam-supervisor.service"]]);
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
  f.ports.verifyPeer = async () => ({ piSignedIn: true, nativeSqlite: true, extensionLoaded: true, exactSession: true, privateModes: true,
    bundledIntercom: true, intercomUnique: true, legacyDrained: false, federation: true });
  const blocked = await provision!(f.request("legacy"), f.ports);
  expect(blocked).toMatchObject({ code: 0, value: { hostingReady: false } });
}, 5000);
