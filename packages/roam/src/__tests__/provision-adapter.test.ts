import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "vite";
import type { Journal, Peer, Transport } from "../contracts";
import { DEFAULT_LIMITS } from "../contracts";
import { copyPiAuth } from "../auth";
import { beginRelease, beginShortWrite, endShortWrite } from "../release-receipt";
import { releaseRequestDigest } from "../release-request";
import { inspectDestinationSettings, selectedSettingsDigests } from "../selected-files";
import * as adapterModule from "../provision-adapter";

const roots: string[] = [];
type Factory = (input: unknown) => {
  enroll(peer: Peer, hubMachineId: string): Promise<void>;
  installRelease(peer: Peer, input: { bytes: Buffer; sha256: string; npmPrefix: string; globalRoot: string; pi: "1.2.0"; intercom: "spider-owned" }): Promise<{ pi: string; cli: string; supervisor: string }>;
  installFiles(peer: Peer, files: readonly { path: string; bytes: Buffer; mode: 0o600 | 0o700 }[], expectedSettingsFingerprint?: string): Promise<void>;
  installCredentialFiles(peer: Peer, files: readonly { path: string; bytes: Buffer; mode: 0o600 | 0o700 }[], providers: readonly string[], expectedSettingsFingerprint?: string): Promise<void>;
  auth(peer: Peer, operationId: string): import("../auth").AuthPorts;
  switchover(peer: Peer, operationId: string): Promise<{ status: string }>;
  verifyPeer(): Promise<import("../provision-contracts").ProvisionVerification>;
  cleanupSecrets(peer: Peer): Promise<void>;
  systemd: { writeUnit(name: string, contents: string): Promise<void>; systemctl(argv: readonly string[]): Promise<void> };
};
const create = (adapterModule as { createHcProvisionAdapter?: Factory }).createHcProvisionAdapter;
const remoteProgram = (adapterModule as { PROVISION_REMOTE_SCRIPT?: string }).PROVISION_REMOTE_SCRIPT;

function fixture() {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "provision-adapter-")); roots.push(root);
  const home = join(root, "home"), globalRoot = join(home, "global"), agentDir = join(home, "agent"), npmPrefix = join(home, "prefix"), unitDir = join(home, "units"), bin = join(home, "bin");
  for (const dir of [home, globalRoot, agentDir, npmPrefix, unitDir, bin]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(globalRoot, "roam"), { mode: 0o700 });
  writeFileSync(join(globalRoot, "roam", "machine.json"), JSON.stringify({ version: 1, machineId: "11111111-1111-4111-8111-111111111111", label: "box-1.invalid" }), { mode: 0o600 });
  const releaseSha = createHash("sha256").update("fixture archive").digest("hex");
  const installPrefix = join(npmPrefix, "spider-releases", releaseSha), releaseRoot = join(installPrefix, "node_modules", "@guru-irl", "spider");
  const peer: Peer = { machineId: "11111111-1111-4111-8111-111111111111", alias: "box-1.invalid", node: join(bin, "node"), pi: join(npmPrefix, "bin", "pi"),
    cli: join(releaseRoot, "dist", "roam", "cli.mjs"), core: join(bin, "hc"), globalRoot };
  const destination = { home, agentDir, npmPrefix, supervisor: join(releaseRoot, "dist", "roam", "supervisor.mjs") };
  const calls = join(root, "systemctl-calls"), writes: { path: string; bytes: Buffer }[] = [], requests: { action: string; argv: string[] }[] = [], launches: string[] = [];
  const launchState = { loseReply: false, dropBefore: 0, terminalOnly: false }, terminalFile = join(root, "release-terminals.json");
  writeFileSync(join(bin, "hc"), `#!${process.execPath}\nimport fs from 'node:fs'; const a=process.argv.slice(2); console.log(JSON.stringify(a[0]==='server'?{core:{id:'fixture-core'}}:(fs.existsSync(${JSON.stringify(terminalFile)})?JSON.parse(fs.readFileSync(${JSON.stringify(terminalFile)},'utf8')):{terminals:[]})));\n`, { mode: 0o700 });
  writeFileSync(join(bin, "systemctl"), `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o700 });
  const transport: Transport = {
    async resolve(value) { return value; }, async bootstrapProbe() { throw new Error("unexpected probe"); },
    async exec() { throw new Error("unexpected exec"); }, async run() { throw new Error("unexpected run"); }, async read() { throw new Error("unexpected read"); },
    async write(_peer, path, bytes) {
      if (!path.startsWith(join(globalRoot, "roam", "provision") + "/")) throw new Error("outside fixture staging");
      writes.push({ path, bytes: Buffer.from(bytes) }); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, bytes);
    },
  };
  const remote = {
    transport,
    async claimIdentity() { throw new Error("unexpected identity bootstrap"); },
    async executeProvision(_peer: Peer, request: Record<string, unknown>) {
      const argv = ["--input-type=module-typescript", "-e", remoteProgram!];
      requests.push({ action: String(request.action), argv });
      const child = spawnSync(process.execPath, argv, { input: JSON.stringify({ ...request, core: peer.core, coreId: "fixture-core" }), encoding: "utf8",
        timeout: request.action === "verify" ? 4900 : 4000,
        env: { ...process.env, HOME: home, PATH: bin, SPIDER_GLOBAL_ROOT: globalRoot } });
      if (child.status !== 0) throw new Error("fixture remote program failed");
      const reply = JSON.parse(child.stdout) as { error?: string; value?: unknown };
      if (reply.error) throw Object.assign(new Error("remote request failed"), { code: reply.error });
      return reply.value;
    },
    async launchRelease(_peer: Peer, _operationId: string, requestFile: string) {
      launches.push(requestFile);
      if (launchState.dropBefore > 0) { launchState.dropBefore--; throw Object.assign(new Error("reply lost"), { code: "cli-timeout" }); }
      if (launchState.terminalOnly) {
        writeFileSync(terminalFile, JSON.stringify({ terminals: [{ state: "live", labels: { "spider.operation": "op-1", "spider.machine": peer.machineId } }] }));
        throw Object.assign(new Error("reply lost"), { code: "cli-timeout" });
      }
      const child = spawnSync(process.execPath, ["--input-type=module-typescript", "-e", remoteProgram!, requestFile], {
        encoding: "utf8", timeout: 4000, env: { ...process.env, HOME: home, PATH: bin, SPIDER_GLOBAL_ROOT: globalRoot },
      });
      if (child.status !== 0) throw new Error("fixture background launch failed");
      if (launchState.loseReply) { launchState.loseReply = false; throw Object.assign(new Error("reply lost"), { code: "cli-timeout" }); }
      return { terminal: "box-1.invalid/t1" };
    },
  };
  const options = { peer, operationId: "op-1", destination, unitDir, coreUnit: "herdr-core.service", limits: { ...DEFAULT_LIMITS, chunkBytes: 32 }, transport: remote,
    piProviders: ["github-copilot"] };
  const input = { bytes: Buffer.from("fixture archive"), sha256: releaseSha, npmPrefix, globalRoot, pi: "1.2.0" as const, intercom: "spider-owned" as const };
  return { root, home, globalRoot, agentDir, npmPrefix, unitDir, bin, releaseRoot, peer, destination, calls, writes, requests, launches, launchState, terminalFile, remote, options, input };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function releaseNpm(f: ReturnType<typeof fixture>) {
  const log = join(f.root, "npm-calls");
  const npm = `#!${process.execPath}\nimport fs from 'node:fs'; import path from 'node:path';\nconst a=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:a,root:process.env.SPIDER_GLOBAL_ROOT})+'\\n');\nconst prefix=a[a.indexOf('--prefix')+1];\nif(a.includes('--global')){const dir=path.join(prefix,'bin');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,'pi'),${JSON.stringify(`#!${process.execPath}\nconsole.log('1.2.0');\n`)},{mode:0o700});}\nelse {const p=path.join(prefix,'node_modules','@guru-irl','spider');for(const file of ['dist/extension.js','dist/intercom/broker.mjs','dist/roam/cli.mjs','dist/roam/supervisor.mjs','scripts/intercom-switchover.mjs','scripts/extension-shim.mjs']){const out=path.join(p,file);fs.mkdirSync(path.dirname(out),{recursive:true,mode:0o700});fs.writeFileSync(out,'fixture',{mode:0o600});}}\n`;
  writeFileSync(join(f.bin, "npm"), npm, { mode: 0o700 });
  return log;
}

it("enrollment short writes converge after a lost reply and reject a changed hub", async () => {
  const f = fixture(), adapter = create!(f.options), hub = "00000000-0000-4000-8000-000000000001";
  const original = f.remote.executeProvision.bind(f.remote); let lost = false;
  f.remote.executeProvision = async (peer, request) => {
    const result = await original(peer, request);
    if (request.action === "enrollment" && !lost) { lost = true; throw Object.assign(new Error("lost"), { code: "cli-timeout" }); }
    return result;
  };
  await adapter.enroll(f.peer, hub);
  expect(JSON.parse(readFileSync(join(f.globalRoot, "roam", "config.json"), "utf8"))).toMatchObject({ enabled: false, machineId: f.peer.machineId, hubMachineId: hub, peers: [] });
  await adapter.enroll(f.peer, hub);
  await expect(adapter.enroll(f.peer, "00000000-0000-4000-8000-000000000003")).rejects.toMatchObject({ code: "operation-arguments-changed" });
  expect(f.requests.filter(row => row.action === "enrollment")).toHaveLength(4);
}, 5000);

it("remote enrollment refuses malformed matching configuration without replacing it", async () => {
  const f = fixture(), hub = "00000000-0000-4000-8000-000000000001", file = join(f.globalRoot, "roam", "config.json");
  const saved = Buffer.from(JSON.stringify({ enabled: "yes", role: "box", machineId: f.peer.machineId, hubMachineId: hub, peers: [], coreUnit: "herdr-core.service" }));
  writeFileSync(file, saved, { mode: 0o600 });
  await expect(create!(f.options).enroll(f.peer, hub)).rejects.toMatchObject({ code: "enrollment-conflict" });
  expect(readFileSync(file)).toEqual(saved);
}, 5000);

it("reconciles a lost release-launch reply and never runs a duplicate installation", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), adapter = create!(f.options), log = releaseNpm(f); f.launchState.loseReply = true;
  const installed = await adapter.installRelease(f.peer, f.input);
  expect(installed).toEqual({ pi: f.peer.pi, cli: f.peer.cli, supervisor: f.destination.supervisor });
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; root: string });
  expect(calls).toHaveLength(2);
  expect(calls.every(call => call.root === f.globalRoot)).toBe(true);
  expect(calls[0].args).toContain("@earendil-works/pi-coding-agent@1.2.0");
  expect(calls[1].args.some(arg => arg.endsWith("release.tgz"))).toBe(true);
  expect(JSON.stringify(calls)).not.toContain("npm:pi-intercom");
  expect(f.writes.every(item => item.bytes.length <= 32)).toBe(true);
  expect(await adapter.installRelease(f.peer, f.input)).toEqual(installed);
  expect(f.launches).toHaveLength(1);
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
  const different = Buffer.from("different release"), sha256 = createHash("sha256").update(different).digest("hex");
  await expect(adapter.installRelease(f.peer, { ...f.input, bytes: different, sha256 })).rejects.toMatchObject({ code: "release-arguments-changed" });
  expect(f.launches).toHaveLength(1);
  const requestFile = f.launches[0], saved = readFileSync(requestFile);
  await expect(f.remote.executeProvision(f.peer, { action: "prepare", operationId: "op-1", machineId: f.peer.machineId, home: f.home,
    globalRoot: f.globalRoot, agentDir: f.agentDir, npmPrefix: f.npmPrefix, unitDir: f.unitDir, maximum: f.options.limits.agentBytes,
    chunkBytes: f.options.limits.chunkBytes, names: ["release-request"] })).rejects.toMatchObject({ code: "invalid-staging-name" });
  expect(readFileSync(requestFile)).toEqual(saved);
  await f.remote.launchRelease(f.peer, "op-1", requestFile);
  expect(f.launches).toHaveLength(2);
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
}, 5000);

it("relaunches the same operation only after receipt and terminal evidence are both absent", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), adapter = create!(f.options), log = releaseNpm(f); f.launchState.dropBefore = 1;
  expect(await adapter.installRelease(f.peer, f.input)).toEqual({ pi: f.peer.pi, cli: f.peer.cli, supervisor: f.destination.supervisor });
  expect(f.launches).toHaveLength(2);
  expect(f.launches[0]).toBe(f.launches[1]);
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
  expect(f.requests.filter(item => item.action === "release-prepare")).toHaveLength(1);
}, 5000);

it("does not retry a release launch that is definitely refused", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), adapter = create!(f.options);
  f.remote.launchRelease = async (_peer, _operationId, requestFile) => {
    f.launches.push(requestFile); throw Object.assign(new Error("refused"), { code: "consent-required" });
  };
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "consent-required" });
  expect(f.launches).toHaveLength(1);
}, 5000);

it("does not relaunch when a labelled terminal exists and records its unfinished failure", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(); f.launchState.terminalOnly = true;
  const adapter = create!({ ...f.options, limits: { ...f.options.limits, importMs: 100, retryDelaysMs: [1] } });
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "release-pending" });
  expect(f.launches).toHaveLength(1);
  writeFileSync(f.terminalFile, JSON.stringify({ terminals: [{ state: "finished", labels: { "spider.operation": "op-1", "spider.machine": f.peer.machineId } }] }));
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "installer-interrupted" });
  expect(f.launches).toHaveLength(1);
  const receipt = JSON.parse(readFileSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"), "utf8"));
  expect(receipt).toMatchObject({ state: "failed", reason: "installer-interrupted" });
}, 5000);

it("blocks another operation while a prior background release is unresolved", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(); f.launchState.terminalOnly = true;
  const limits = { ...f.options.limits, importMs: 100, retryDelaysMs: [1] };
  const first = create!({ ...f.options, limits });
  await expect(first.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "release-pending" });
  const second = create!({ ...f.options, operationId: "op-2", limits });
  await expect(second.cleanupSecrets(f.peer)).rejects.toMatchObject({ code: "release-in-progress" });
  expect(f.launches).toHaveLength(1);
}, 5000);

it("turns an interrupted started receipt into failure when the labelled terminal finished", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), adapter = create!({ ...f.options, limits: { ...f.options.limits, importMs: 150, retryDelaysMs: [1] } });
  f.remote.launchRelease = async (_peer, operationId, requestFile) => {
    f.launches.push(requestFile);
    const request = JSON.parse(readFileSync(requestFile, "utf8"));
    beginRelease({ directory: dirname(requestFile), operationId, digest: releaseRequestDigest(request), owner: { pid: 123, bootId: "nonlinux", start: "42" } });
    writeFileSync(f.terminalFile, JSON.stringify({ terminals: [{ state: "finished", labels: { "spider.operation": "op-1", "spider.machine": f.peer.machineId } }] }));
    throw Object.assign(new Error("reply lost"), { code: "cli-timeout" });
  };
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "installer-interrupted" });
  expect(f.launches).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"), "utf8"))).toMatchObject({ state: "failed" });
}, 5000);

it("records a failed installer and does not repeat it for the same operation", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), adapter = create!(f.options);
  writeFileSync(join(f.bin, "npm"), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toThrow();
  const receipt = JSON.parse(readFileSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"), "utf8"));
  expect(receipt.state).toBe("failed");
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toThrow();
  expect(f.launches).toHaveLength(1);
}, 5000);

it("refuses an unpinned release before any transfer", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), adapter = create!(f.options);
  await expect(adapter.installRelease(f.peer, { ...f.input, sha256: "f".repeat(64) })).rejects.toThrow();
  expect(f.writes).toEqual([]);
}, 5000);

it("waits for a live short writer before repeating the same operation", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), intents = join(f.globalRoot, "roam", "provision-intents", "op-1");
  mkdirSync(intents, { recursive: true, mode: 0o700 });
  const stat = process.platform === "linux" ? readFileSync("/proc/self/stat", "utf8") : "";
  const owner = process.platform === "linux" ? { pid: process.pid, bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] } : { pid: process.pid, bootId: "nonlinux", start: String(Date.now()) };
  const lockInput = { directory: intents, operationId: "op-1", digest: "a".repeat(64), owner };
  const lock = beginShortWrite(lockInput, () => "live");
  if (lock.kind !== "acquired") throw new Error("lock not acquired");
  const adapter = create!(f.options), unit = "spider-roam-supervisor.service";
  await expect(adapter.systemd.writeUnit(unit, "fixture unit")).rejects.toMatchObject({ code: "short-write-pending" });
  expect(existsSync(join(f.unitDir, unit))).toBe(false);
  endShortWrite(lockInput, lock.token);
  await adapter.systemd.writeUnit(unit, "fixture unit");
  expect(readFileSync(join(f.unitDir, unit), "utf8")).toBe("fixture unit");
}, 5000);

it("refuses unlisted settings at the destination even if a caller bypasses the preview", async () => {
  const f = fixture(), adapter = create!(f.options);
  const bytes = Buffer.from('{"theme":"sample","defaultProjectTrust":"always"}');
  const allowed = { path: "settings.json", bytes: Buffer.from('{"theme":"sample"}'), mode: 0o600 as const };
  const preview = inspectDestinationSettings({ home: f.home, destinationRoot: f.agentDir, entries: selectedSettingsDigests(allowed), maximum: 1024 * 1024 });
  await expect(adapter.installFiles(f.peer, [{ path: "settings.json", bytes, mode: 0o600 }], preview.fingerprint))
    .rejects.toMatchObject({ code: "selection-not-allowed" });
  expect(existsSync(join(f.agentDir, "settings.json"))).toBe(false);
  expect(readdirSync(join(f.globalRoot, "roam", "provision", "op-1"))).toEqual([]);
}, 5000);

it("reports invalid box settings by name without writing the file or a backup", async () => {
  const f = fixture(), adapter = create!(f.options), target = join(f.agentDir, "settings.json");
  writeFileSync(target, "[broken", { mode: 0o600 });
  await expect(adapter.installFiles(f.peer, [{ path: "settings.json", bytes: Buffer.from('{"theme":"sample"}'), mode: 0o600 }], "a".repeat(64)))
    .rejects.toMatchObject({ code: "invalid-destination-settings" });
  expect(readFileSync(target, "utf8")).toBe("[broken");
  expect(existsSync(`${target}.spider-roam.bak`)).toBe(false);
}, 5000);

it("merges credential-bearing settings through private staging and the approved fence", async () => {
  const f = fixture(), adapter = create!(f.options), target = join(f.agentDir, "settings.json"), secret = "fixture-secret";
  writeFileSync(target, '{"defaultModel":"old-model","defaultProjectTrust":"never"}', { mode: 0o600 });
  const file = { path: "settings.json", bytes: Buffer.from(JSON.stringify({ defaultModel: `https://models.invalid/?token=${secret}` })), mode: 0o600 as const };
  const preview = inspectDestinationSettings({ home: f.home, destinationRoot: f.agentDir, entries: selectedSettingsDigests(file), maximum: 1024 * 1024 });
  await adapter.installCredentialFiles(f.peer, [file], ["settings"], preview.fingerprint);
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ defaultModel: `https://models.invalid/?token=${secret}`, defaultProjectTrust: "never" });
  expect(f.writes).toEqual([]); expect(JSON.stringify(f.requests)).not.toContain(secret);
  expect(readdirSync(join(f.globalRoot, "roam", "provision", "op-1"))).toEqual([]);
}, 5000);

it("rejects a credential substituted into a public batch at the destination", async () => {
  const f = fixture(), adapter = create!(f.options), remote = f.remote.executeProvision.bind(f.remote);
  const injected = Buffer.from('{"apiKey":"fixture-secret"}');
  f.remote.executeProvision = async (peer, request) => {
    if (request.action !== "install-files") return remote(peer, request);
    const file = request.file as { path: string; mode: number; chunks: { name: string; size: number; sha256: string }[] };
    expect(file.chunks).toHaveLength(1);
    writeFileSync(join(f.globalRoot, "roam", "provision", "op-1", file.chunks[0].name), injected, { mode: 0o600 });
    const chunk = { ...file.chunks[0], size: injected.length, sha256: createHash("sha256").update(injected).digest("hex") };
    return remote(peer, { ...request, file: { ...file, chunks: [chunk] } });
  };
  await expect(adapter.installFiles(f.peer, [{ path: "keybindings.json", bytes: Buffer.from('{"apiKey":"$K"}'), mode: 0o600 }]))
    .rejects.toMatchObject({ code: "credential-file-requires-consent" });
  expect(existsSync(join(f.agentDir, "keybindings.json"))).toBe(false);
}, 5000);

it("rejects private credentials whose provider was changed after local validation", async () => {
  const f = fixture(), adapter = create!(f.options), remote = f.remote.executeProvision.bind(f.remote);
  f.remote.executeProvision = (peer, request) => remote(peer, request.action === "install-files" ? { ...request, providers: ["other"] } : request);
  const bytes = Buffer.from('{"providers":{"demo":{"apiKey":"fixture-secret"}}}');
  await expect(adapter.installCredentialFiles(f.peer, [{ path: "models.json", bytes, mode: 0o600 }], ["demo"]))
    .rejects.toMatchObject({ code: "provider-consent-required" });
  expect(existsSync(join(f.agentDir, "models.json"))).toBe(false);
}, 5000);

it("rejects a file assembled from mixed public and private chunks", async () => {
  const f = fixture(), adapter = create!(f.options), remote = f.remote.executeProvision.bind(f.remote);
  f.remote.executeProvision = async (peer, request) => {
    if (request.action !== "install-files") return remote(peer, request);
    const file = request.file as { path: string; mode: number; chunks: { name: string; size: number; sha256: string }[] };
    expect(file.chunks.length).toBeGreaterThan(1);
    const stage = join(f.globalRoot, "roam", "provision", "op-1"), name = `secret-file-${"a".repeat(32)}`;
    writeFileSync(join(stage, name), readFileSync(join(stage, file.chunks[0].name)), { mode: 0o600 });
    return remote(peer, { ...request, file: { ...file, chunks: [{ ...file.chunks[0], name }, ...file.chunks.slice(1)] } });
  };
  const bytes = Buffer.from(JSON.stringify({ value: "x".repeat(60) }));
  await expect(adapter.installFiles(f.peer, [{ path: "keybindings.json", bytes, mode: 0o600 }])).rejects.toMatchObject({ code: "invalid-chunks" });
  expect(existsSync(join(f.agentDir, "keybindings.json"))).toBe(false);
}, 5000);

it("rejects an unguarded settings batch before staging any bytes", async () => {
  const f = fixture(), adapter = create!(f.options);
  await expect(adapter.installFiles(f.peer, [{ path: "settings.json", bytes: Buffer.from('{"theme":"source-theme"}'), mode: 0o600 }]))
    .rejects.toMatchObject({ code: "invalid-settings-preview" });
  expect(existsSync(join(f.agentDir, "settings.json"))).toBe(false);
  expect(f.requests.some(call => call.action === "prepare" || call.action === "install-files")).toBe(false); expect(f.writes).toEqual([]);
}, 5000);

it("rejects a settings write if its fingerprint is stripped in transit", async () => {
  const f = fixture(), adapter = create!(f.options);
  const file = { path: "settings.json", bytes: Buffer.from('{"theme":"source-theme"}'), mode: 0o600 as const };
  const preview = inspectDestinationSettings({ home: f.home, destinationRoot: f.agentDir, entries: selectedSettingsDigests(file), maximum: 1024 * 1024 });
  const remote = f.remote.executeProvision.bind(f.remote);
  f.remote.executeProvision = (peer, request) => {
    if (request.action !== "install-files") return remote(peer, request);
    const { expectedSettingsFingerprint: _stripped, ...unguarded } = request;
    return remote(peer, unguarded);
  };
  await expect(adapter.installFiles(f.peer, [file], preview.fingerprint)).rejects.toMatchObject({ code: "invalid-settings-preview" });
  expect(existsSync(join(f.agentDir, "settings.json"))).toBe(false);
}, 5000);

it("preserves precise box-only numbers in the generated destination program", async () => {
  const f = fixture(), adapter = create!(f.options), target = join(f.agentDir, "settings.json");
  writeFileSync(target, '{"theme":"old-theme","large":9007199254740993,"nested":{"huge":1e400}}', { mode: 0o600 });
  const file = { path: "settings.json", bytes: Buffer.from('{"theme":"source-theme"}'), mode: 0o600 as const };
  const preview = inspectDestinationSettings({ home: f.home, destinationRoot: f.agentDir, entries: selectedSettingsDigests(file), maximum: 1024 * 1024 });
  await adapter.installFiles(f.peer, [file], preview.fingerprint);
  const result = readFileSync(target, "utf8");
  expect(result).toContain('"large": 9007199254740993'); expect(result).toContain('"huge": 1e400');
  expect(JSON.parse(result).theme).toBe("source-theme");
}, 5000);

it("fences a settings short write against edits made after preview", async () => {
  const f = fixture(), adapter = create!(f.options), target = join(f.agentDir, "settings.json");
  writeFileSync(target, '{"theme":"old-theme","defaultProjectTrust":"never"}', { mode: 0o600 });
  const file = { path: "settings.json", bytes: Buffer.from('{"theme":"source-theme"}'), mode: 0o600 as const };
  const preview = inspectDestinationSettings({ home: f.home, destinationRoot: f.agentDir, entries: selectedSettingsDigests(file), maximum: 1024 * 1024 });
  const edited = '{"theme":"external-edit","defaultProjectTrust":"never"}'; writeFileSync(target, edited, { mode: 0o600 });
  await expect(adapter.installFiles(f.peer, [file], preview.fingerprint)).rejects.toMatchObject({ code: "settings-preview-changed" });
  expect(readFileSync(target, "utf8")).toBe(edited); expect(existsSync(`${target}.spider-roam.bak`)).toBe(false);
}, 5000);

it("replays a lost settings merge reply without changing bytes or replacing its backup", async () => {
  const f = fixture(), adapter = create!(f.options), target = join(f.agentDir, "settings.json"), backup = `${target}.spider-roam.bak`;
  const original = '{"theme":"old-theme","defaultProjectTrust":"never"}'; writeFileSync(target, original, { mode: 0o600 });
  const file = { path: "settings.json", bytes: Buffer.from('{"theme":"source-theme"}'), mode: 0o600 as const };
  const preview = inspectDestinationSettings({ home: f.home, destinationRoot: f.agentDir, entries: selectedSettingsDigests(file), maximum: 1024 * 1024 });
  const remote = f.remote.executeProvision.bind(f.remote); let lost = false;
  f.remote.executeProvision = async (peer, request) => {
    const result = await remote(peer, request);
    if (request.action === "install-files" && !lost) { lost = true; throw Object.assign(new Error("reply lost"), { code: "cli-timeout" }); }
    return result;
  };
  await adapter.installFiles(f.peer, [file], preview.fingerprint);
  expect(lost).toBe(true); expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ theme: "source-theme", defaultProjectTrust: "never" });
  const first = readFileSync(target), inode = lstatSync(target).ino;
  expect(readFileSync(backup, "utf8")).toBe(original);
  await adapter.installFiles(f.peer, [file], preview.fingerprint);
  expect(readFileSync(target)).toEqual(first); expect(lstatSync(target).ino).toBe(inode); expect(readFileSync(backup, "utf8")).toBe(original);
  expect(readdirSync(join(f.globalRoot, "roam", "provision", "op-1"))).toEqual([]);
}, 5000);

it("rejects changed file bytes for the same operation before overwriting the destination", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), adapter = create!(f.options);
  const first = { path: "settings.json", bytes: Buffer.from('{"theme":"first"}'), mode: 0o600 as const };
  const preview = inspectDestinationSettings({ home: f.home, destinationRoot: f.agentDir, entries: selectedSettingsDigests(first), maximum: 1024 * 1024 });
  await adapter.installFiles(f.peer, [first], preview.fingerprint);
  await expect(adapter.installFiles(f.peer, [{ path: "settings.json", bytes: Buffer.from('{"theme":"second"}'), mode: 0o600 }], preview.fingerprint))
    .rejects.toMatchObject({ code: "operation-arguments-changed" });
  expect(readFileSync(join(f.agentDir, "settings.json"), "utf8")).toBe('{"theme":"first"}');
}, 5000);

it("replays a lost secret-chunk reply and rejects changed secret bytes under the same operation", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), execute = f.remote.executeProvision.bind(f.remote); let replayed = false;
  f.remote.executeProvision = async (peer, request) => {
    const result = await execute(peer, request);
    if (request.action === "secret-chunk" && typeof request.offset === "number" && request.offset > 0 && !replayed) {
      replayed = true; throw Object.assign(new Error("reply lost"), { code: "cli-timeout" });
    }
    return result;
  };
  const adapter = create!(f.options), auth = adapter.auth(f.peer, "op-1"), first = Buffer.alloc(80, 65);
  const staged = auth.stage(first); await expect(staged).resolves.toHaveProperty("file");
  const stage = await staged; expect(replayed).toBe(true); await auth.remove(stage);
  const retry = adapter.auth(f.peer, "op-1");
  await expect(retry.stage(Buffer.alloc(80, 66))).rejects.toMatchObject({ code: "operation-arguments-changed" });
  await retry.remove(null);
  expect(readdirSync(join(f.globalRoot, "roam", "provision", "op-1")).filter(name => name.startsWith("secret-"))).toEqual([]);
}, 5000);

it("uses bounded hc file writes to install only selected files", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), adapter = create!(f.options);
  writeFileSync(join(f.agentDir, "AGENTS.md"), "old", { mode: 0o600 });
  const bytes = Buffer.from("new instructions spanning several small chunks");
  await adapter.installFiles(f.peer, [{ path: "AGENTS.md", bytes, mode: 0o600 }]);
  expect(readFileSync(join(f.agentDir, "AGENTS.md"))).toEqual(bytes);
  expect(readFileSync(join(f.agentDir, "AGENTS.md.spider-roam.bak"), "utf8")).toBe("old");
  expect(f.writes.length).toBeGreaterThan(1);
  expect(f.writes.every(item => item.bytes.length <= 32)).toBe(true);
  expect(lstatSync(join(f.agentDir, "AGENTS.md")).mode & 0o777).toBe(0o600);
}, 5000);

it("cleans interrupted secret and doctor staging while retaining unrelated artifacts", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), adapter = create!(f.options), stage = join(f.globalRoot, "roam", "provision", "op-1");
  mkdirSync(stage, { recursive: true, mode: 0o700 }); mkdirSync(join(stage, "doctor-orphan"), { mode: 0o700 });
  writeFileSync(join(stage, "secret-orphan"), "fixture-secret", { mode: 0o600 });
  writeFileSync(join(stage, "doctor-orphan", "auth.json"), "fixture-secret", { mode: 0o600 });
  writeFileSync(join(stage, ".secret-11111111-1111-4111-8111-111111111111.tmp"), "fixture-secret", { mode: 0o600 });
  writeFileSync(join(stage, "public-keep"), "keep", { mode: 0o600 });
  const prior = join(f.globalRoot, "roam", "provision", "prior-op"); mkdirSync(prior, { mode: 0o700 });
  writeFileSync(join(prior, "secret-orphan"), "fixture-secret", { mode: 0o600 });
  await adapter.cleanupSecrets(f.peer);
  expect(readdirSync(stage)).toEqual(["public-keep"]);
  expect(readdirSync(prior)).toEqual([]);
  expect(JSON.stringify(f.requests)).not.toContain("fixture-secret");
}, 5000);

it("replays a lost selected-file reply once without losing the backup or accepting changed bytes", async () => {
  const f = fixture(), adapter = create!(f.options);
  mkdirSync(join(f.agentDir, "themes"), { recursive: true, mode: 0o700 });
  const target = join(f.agentDir, "themes", "custom.json"), backup = `${target}.spider-roam.bak`;
  writeFileSync(target, "previous", { mode: 0o600 });
  writeFileSync(join(f.agentDir, "unrelated"), "keep", { mode: 0o600 });
  const remote = f.remote.executeProvision.bind(f.remote); let lost = false;
  f.remote.executeProvision = async (peer, request) => {
    const result = await remote(peer, request);
    if (request.action === "install-files" && !lost) { lost = true; throw Object.assign(new Error("reply lost"), { code: "cli-timeout" }); }
    return result;
  };
  const file = { path: "themes/custom.json", bytes: Buffer.from('{"name":"night"}'), mode: 0o600 as const };
  await adapter.installFiles(f.peer, [file]);
  expect(lost).toBe(true); expect(readFileSync(target)).toEqual(file.bytes); expect(readFileSync(backup, "utf8")).toBe("previous");
  const inode = lstatSync(target).ino, backupInode = lstatSync(backup).ino;
  await adapter.installFiles(f.peer, [file]);
  expect(lstatSync(target).ino).toBe(inode); expect(lstatSync(backup).ino).toBe(backupInode);
  await expect(adapter.installFiles(f.peer, [{ ...file, bytes: Buffer.from('{"name":"light"}') }]))
    .rejects.toMatchObject({ code: "operation-arguments-changed" });
  expect(readFileSync(target)).toEqual(file.bytes); expect(readFileSync(backup, "utf8")).toBe("previous");
  expect(readFileSync(join(f.agentDir, "unrelated"), "utf8")).toBe("keep");
  expect(readdirSync(join(f.globalRoot, "roam", "provision", "op-1"))).toEqual([]);
}, 5000);

it("refuses a destination symlink without altering its target and cleans transferred chunks", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), adapter = create!(f.options), outside = join(f.root, "outside");
  writeFileSync(outside, "keep", { mode: 0o600 }); symlinkSync(outside, join(f.agentDir, "AGENTS.md"));
  await expect(adapter.installFiles(f.peer, [{ path: "AGENTS.md", bytes: Buffer.from("new"), mode: 0o600 }])).rejects.toThrow();
  expect(readFileSync(outside, "utf8")).toBe("keep");
  expect(lstatSync(join(f.agentDir, "AGENTS.md")).isSymbolicLink()).toBe(true);
  expect(readdirSync(join(f.globalRoot, "roam", "provision", "op-1"))).toEqual([]);
}, 5000);

it("does not expose credential-like remote error codes or messages", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), original = f.remote.executeProvision;
  f.remote.executeProvision = async (peer, request) => {
    if (request.action === "secret-chunk") throw Object.assign(new Error("fixture-secret"), { code: "fixture-secret" });
    return original(peer, request);
  };
  const adapter = create!(f.options); let caught: unknown;
  try { await adapter.installCredentialFiles(f.peer, [{ path: "models.json", bytes: Buffer.from('{"providers":{"demo":{"apiKey":"fixture-secret"}}}'), mode: 0o600 }], ["demo"]); } catch (error) { caught = error; }
  expect(caught).toBeTruthy();
  expect(String(caught)).not.toContain("fixture-secret");
  expect(JSON.stringify(caught)).not.toContain("fixture-secret");
  expect(readdirSync(join(f.globalRoot, "roam", "provision", "op-1"))).toEqual([]);
}, 5000);

it("transfers commented Pi model definitions unchanged when they contain only an environment reference", async () => {
  const f = fixture(), adapter = create!(f.options);
  const models = '{\n// portable reference\n"providers":{"demo":{"apiKey":"${DEMO_KEY}",}},\n}\n';
  await adapter.installFiles(f.peer, [{ path: "models.json", bytes: Buffer.from(models), mode: 0o600 }]);
  expect(readFileSync(join(f.agentDir, "models.json"), "utf8")).toBe(models);
  expect(f.writes.length).toBeGreaterThan(0);
}, 5000);

it("refuses a credential assignment in a model comment on the public file channel", async () => {
  const f = fixture(), adapter = create!(f.options);
  const models = '{\n// token: fixture-secret\n"providers":{"demo":{"apiKey":"${DEMO_KEY}"}}\n}';
  await expect(adapter.installFiles(f.peer, [{ path: "models.json", bytes: Buffer.from(models), mode: 0o600 }]))
    .rejects.toMatchObject({ code: "credential-file-requires-consent" });
  expect(f.writes).toEqual([]); expect(f.requests).toEqual([]);
}, 5000);

it("snapshots public model bytes before asynchronous staging can change the caller buffer", async () => {
  const f = fixture(), adapter = create!(f.options);
  const bytes = Buffer.from('{"providers":{"demo":{"apiKey":"${MODEL_TOKEN}"}}}'), expected = Buffer.from(bytes);
  const position = bytes.indexOf("${MODEL_TOKEN}");
  f.remote.transport.resolve = async peer => { bytes.write("fixture-secret", position); return peer; };
  await adapter.installFiles(f.peer, [{ path: "models.json", bytes, mode: 0o600 }]);
  expect(bytes.toString("utf8")).toContain("fixture-secret");
  expect(readFileSync(join(f.agentDir, "models.json"))).toEqual(expected);
  expect(Buffer.concat(f.writes.map(write => write.bytes))).toEqual(expected);
  expect(Buffer.concat(f.writes.map(write => write.bytes)).toString("utf8")).not.toContain("fixture-secret");
}, 5000);

it("refuses credential-bearing model definitions on the public file channel", async () => {
  const f = fixture(), adapter = create!(f.options);
  const bytes = Buffer.from('{"providers":{"demo":{"apiKey":"fixture-secret"}}}');
  await expect(adapter.installFiles(f.peer, [{ path: "models.json", bytes, mode: 0o600 }]))
    .rejects.toMatchObject({ code: "credential-file-requires-consent" });
  expect(f.writes).toEqual([]); expect(f.requests).toEqual([]);
  expect(existsSync(join(f.agentDir, "models.json"))).toBe(false);
}, 5000);

it("snapshots private model bytes and provider names before asynchronous staging", async () => {
  const f = fixture(), adapter = create!(f.options), providers = ["demo"];
  const bytes = Buffer.from('{"providers":{"demo":{"apiKey":"fixture-secret"}}}'), expected = Buffer.from(bytes);
  const remote = f.remote.executeProvision.bind(f.remote), seen: unknown[] = [];
  f.remote.executeProvision = async (peer, request) => {
    if (request.action === "secret-chunk" || request.action === "install-files") seen.push(request.providers);
    return remote(peer, request);
  };
  f.remote.transport.resolve = async peer => { bytes.write("evil", bytes.indexOf("demo")); providers[0] = "evil"; return peer; };
  await adapter.installCredentialFiles(f.peer, [{ path: "models.json", bytes, mode: 0o600 }], providers);
  expect(bytes.toString("utf8")).toContain("evil"); expect(providers).toEqual(["evil"]);
  expect(readFileSync(join(f.agentDir, "models.json"))).toEqual(expected);
  expect(seen.length).toBeGreaterThan(0); expect(seen.every(value => JSON.stringify(value) === '["demo"]')).toBe(true);
  expect(f.writes).toEqual([]);
}, 5000);

it("refuses private model credentials for a provider omitted from the transfer consent", async () => {
  const f = fixture(), adapter = create!(f.options);
  const models = Buffer.from('{"providers":{"other":{"apiKey":"fixture-secret"}}}');
  await expect(adapter.installCredentialFiles(f.peer, [{ path: "models.json", bytes: models, mode: 0o600 }], ["demo"]))
    .rejects.toMatchObject({ code: "provider-consent-required" });
  expect(f.writes).toEqual([]); expect(f.requests).toEqual([]);
  expect(existsSync(join(f.agentDir, "models.json"))).toBe(false);
}, 5000);

it("uses private stdin rather than hc file writes for credential-bearing settings", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), adapter = create!(f.options), secret = Buffer.from('{"providers":{"example":{"apiKey":"fixture-secret"}}}');
  await adapter.installCredentialFiles(f.peer, [{ path: "models.json", bytes: secret, mode: 0o600 }], ["example"]);
  expect(readFileSync(join(f.agentDir, "models.json"))).toEqual(secret);
  expect(f.writes).toEqual([]);
  expect(f.requests.every(item => !JSON.stringify(item.argv).includes("fixture-secret"))).toBe(true);
  expect(readdirSync(join(f.globalRoot, "roam", "provision", "op-1"))).toEqual([]);
}, 5000);

it("sends auth only through private stdin staging and removes it", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), execute = f.remote.executeProvision.bind(f.remote), modes: number[] = [];
  f.remote.executeProvision = async (peer, request) => {
    const result = await execute(peer, request);
    if (request.action === "secret-chunk") {
      const stage = join(f.globalRoot, "roam", "provision", "op-1");
      modes.push(lstatSync(stage).mode & 0o777, lstatSync(join(stage, String(request.name))).mode & 0o777);
    }
    return result;
  };
  const adapter = create!(f.options), source = join(f.root, "source"); mkdirSync(source, { mode: 0o700 });
  writeFileSync(join(source, "auth.json"), JSON.stringify({ "github-copilot": { type: "oauth", access: "fixture-secret" } }), { mode: 0o600 });
  const journal: Journal = { begin: () => ({ kind: "pending", result: null }), record() {},
    read: () => [{ action: "provision-consent", result: { approved: true, target: f.peer.alias, machineId: f.peer.machineId, providers: ["github-copilot"] } }] };
  await copyPiAuth({ sourceRoot: source, peer: f.peer, operationId: "op-1", providers: ["github-copilot"], journal, maxBytes: 4096 }, adapter.auth(f.peer, "op-1"));
  expect(JSON.parse(readFileSync(join(f.agentDir, "auth.json"), "utf8"))).toEqual({ "github-copilot": { type: "oauth", access: "fixture-secret" } });
  expect(f.writes).toEqual([]);
  expect(f.requests.some(item => item.action === "secret-chunk")).toBe(true);
  expect(modes.length).toBeGreaterThan(0);
  expect(modes.every((mode, index) => mode === (index % 2 === 0 ? 0o700 : 0o600))).toBe(true);
  expect(f.requests.every(item => !JSON.stringify(item.argv).includes("fixture-secret"))).toBe(true);
  const stage = join(f.globalRoot, "roam", "provision", "op-1");
  expect(readdirSync(stage).filter(name => name.startsWith("secret-"))).toEqual([]);
  const intents = join(f.globalRoot, "roam", "provision-intents", "op-1");
  expect(lstatSync(intents).mode & 0o777).toBe(0o700);
  for (const name of readdirSync(intents)) {
    expect(lstatSync(join(intents, name)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(intents, name), "utf8")).not.toContain("fixture-secret");
  }
  expect(lstatSync(join(f.agentDir, "auth.json")).mode & 0o777).toBe(0o600);
}, 5000);

it("installs only a supervisor unit through a fake systemd port", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), adapter = create!(f.options), core = join(f.unitDir, "herdr-core.service");
  writeFileSync(core, "original core", { mode: 0o600 }); chmodSync(f.unitDir, 0o755);
  await adapter.systemd.writeUnit("spider-roam-supervisor.service", "fixture unit");
  await adapter.systemd.systemctl(["--user", "daemon-reload"]);
  await adapter.systemd.systemctl(["--user", "enable", "spider-roam-supervisor.service"]);
  expect(readFileSync(core, "utf8")).toBe("original core");
  expect(readFileSync(join(f.unitDir, "spider-roam-supervisor.service"), "utf8")).toBe("fixture unit");
  expect(readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([["--user", "daemon-reload"], ["--user", "enable", "spider-roam-supervisor.service"]]);
  await expect(adapter.systemd.systemctl(["--user", "restart", "herdr-core.service"])).rejects.toThrow();
}, 5000);

function readyExecutables(f: ReturnType<typeof fixture>, wrongSession = false) {
  const piLog = join(f.root, "pi-calls"), piDir = dirname(f.peer.pi); mkdirSync(piDir, { recursive: true, mode: 0o700 });
  const pi = `#!${process.execPath}\nimport fs from 'node:fs'; const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(piLog)},JSON.stringify(args)+'\\n');\nif(args[0]==='auth') process.exit(0);\nconst file=args[args.indexOf('--session')+1], header=JSON.parse(fs.readFileSync(file,'utf8').split('\\n')[0]); fs.readFileSync(0,'utf8');\nconsole.log(JSON.stringify({id:'probe',type:'response',command:'get_state',success:true,data:{sessionFile:file,sessionId:${wrongSession ? "'different'" : "header.id"}}}));\n`;
  writeFileSync(f.peer.pi, pi, { mode: 0o700 });
  const sdk = join(f.npmPrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
  mkdirSync(dirname(sdk), { recursive: true, mode: 0o700 });
  writeFileSync(sdk, "export class DefaultResourceLoader { async reload() {} getExtensions() { return { errors: [], extensions: [{ tools: new Map([['spider', {}]]) }] }; } }", { mode: 0o600 });
  const native = join(f.releaseRoot, "node_modules", "better-sqlite3"), vec = join(f.releaseRoot, "node_modules", "sqlite-vec");
  mkdirSync(native, { recursive: true, mode: 0o700 }); mkdirSync(vec, { recursive: true, mode: 0o700 });
  writeFileSync(join(f.releaseRoot, "package.json"), '{"type":"module"}', { mode: 0o600 });
  writeFileSync(join(native, "package.json"), '{"main":"index.cjs"}', { mode: 0o600 });
  writeFileSync(join(native, "index.cjs"), "module.exports = class Database { prepare() { return { get: () => ({ value: 1 }) }; } loadExtension() {} exec() {} close() {} };", { mode: 0o600 });
  writeFileSync(join(vec, "package.json"), '{"main":"index.cjs"}', { mode: 0o600 });
  writeFileSync(join(vec, "index.cjs"), "exports.getLoadablePath = () => 'fixture';", { mode: 0o600 });
  mkdirSync(join(f.releaseRoot, "dist", "intercom"), { recursive: true, mode: 0o700 });
  writeFileSync(join(f.releaseRoot, "dist", "extension.js"), "export default () => {};", { mode: 0o600 });
  writeFileSync(join(f.releaseRoot, "dist", "intercom", "broker.mjs"), "fixture", { mode: 0o600 });
  return piLog;
}

it("verifies offline pi auth, native modules, extension load and exact-session launch", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), log = readyExecutables(f), adapter = create!(f.options);
  writeFileSync(join(f.agentDir, "auth.json"), JSON.stringify({ "github-copilot": { type: "oauth", access: "fixture-secret", refresh: "fixture-refresh", expires: Date.now() + 60_000 } }), { mode: 0o600 });
  const verified = await adapter.verifyPeer();
  expect(verified).toMatchObject({ piSignedIn: true, nativeSqlite: true, extensionLoaded: true, exactSession: true, privateModes: true, bundledIntercom: true,
    intercomUnique: false, legacyDrained: false, federation: false });
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
  expect(calls.some(args => args[0] === "auth" && args.includes("--no-refresh") && args.includes("github-copilot"))).toBe(true);
  expect(calls.some(args => args.includes("--session") && args.includes("--offline"))).toBe(true);
  expect(JSON.stringify(calls)).not.toContain("fixture-secret");
  expect(readdirSync(join(f.globalRoot, "roam", "provision", "op-1"))).toEqual([]);
}, 5000);

describe("real pi loader", () => {
  let buildRoot: string;
  beforeAll(async () => {
    const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
    buildRoot = mkdtempSync(join(scratch, "real-pi-bundle-"));
    await build({ root: process.cwd(), configFile: join(process.cwd(), "vite.config.mjs"), logLevel: "silent", build: { outDir: buildRoot } });
  }, 5000);
  afterAll(() => { if (buildRoot) rmSync(buildRoot, { recursive: true, force: true }); });
  it("loads the bundled extension and exact fixture session with the real pi loader", async () => {
    expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
    const f = fixture(); readyExecutables(f);
    const moduleRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist");
    const sdk = join(f.npmPrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
    unlinkSync(f.peer.pi); unlinkSync(sdk); symlinkSync(process.execPath, f.peer.node);
    symlinkSync(join(moduleRoot, "bundle", "cli.js"), f.peer.pi); symlinkSync(join(moduleRoot, "index.js"), sdk);
    copyFileSync(join(buildRoot, "extension.js"), join(f.releaseRoot, "dist", "extension.js"));
    const verified = await create!(f.options).verifyPeer();
    expect(verified.extensionLoaded).toBe(true);
    expect(verified.exactSession).toBe(true);
    expect(verified.piSignedIn).toBe(false);
    expect(readdirSync(join(f.globalRoot, "roam", "provision", "op-1"))).toEqual([]);
  }, 5000);
});

it("does not run credential commands or accept an exact-session mismatch", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), log = readyExecutables(f, true), adapter = create!(f.options);
  writeFileSync(join(f.agentDir, "auth.json"), JSON.stringify({ "github-copilot": { type: "api_key", key: "!fixture-command" } }), { mode: 0o600 });
  const verified = await adapter.verifyPeer();
  expect(verified.piSignedIn).toBe(false); expect(verified.exactSession).toBe(false);
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
  expect(calls.some(args => args[0] === "auth")).toBe(false);
  expect(JSON.stringify(calls)).not.toContain("fixture-command");
  expect(readdirSync(join(f.globalRoot, "roam", "provision", "op-1"))).toEqual([]);
}, 5000);

it("activates Spider's own extension after installing filtered settings", async () => {
  const f = fixture(), adapter = create!(f.options), scripts = join(f.releaseRoot, "scripts"), extensionDir = join(f.agentDir, "extensions");
  mkdirSync(join(f.releaseRoot, "dist", "intercom"), { recursive: true, mode: 0o700 }); mkdirSync(scripts, { mode: 0o700 });
  mkdirSync(extensionDir, { mode: 0o700 }); writeFileSync(join(extensionDir, "keep.ts"), "existing extension", { mode: 0o600 });
  const bundle = join(f.releaseRoot, "dist", "extension.js");
  writeFileSync(bundle, "export default () => {};", { mode: 0o600 });
  writeFileSync(join(f.releaseRoot, "dist", "intercom", "broker.mjs"), "broker", { mode: 0o600 });
  copyFileSync(join(process.cwd(), "scripts", "intercom-switchover.mjs"), join(scripts, "intercom-switchover.mjs"));
  copyFileSync(join(process.cwd(), "scripts", "extension-shim.mjs"), join(scripts, "extension-shim.mjs"));
  writeFileSync(join(f.agentDir, "settings.json"), '{"packages":["npm:pi-intercom","npm:other"],"extensions":["old.ts"],"defaultProjectTrust":"never"}', { mode: 0o600 });
  const settings = { path: "settings.json", bytes: Buffer.from('{"theme":"sample"}'), mode: 0o600 as const };
  const preview = inspectDestinationSettings({ home: f.home, destinationRoot: f.agentDir, entries: selectedSettingsDigests(settings), maximum: 1024 * 1024 });
  await adapter.installFiles(f.peer, [settings], preview.fingerprint);
  expect(JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8"))).toEqual({ packages: ["npm:pi-intercom", "npm:other"],
    extensions: ["old.ts"], defaultProjectTrust: "never", theme: "sample" });
  await adapter.switchover(f.peer, "op-1");
  expect(JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8"))).toEqual({ packages: ["npm:other"],
    extensions: ["old.ts"], defaultProjectTrust: "never", theme: "sample" });
  expect(readFileSync(join(extensionDir, "spider.ts"), "utf8")).toContain(JSON.stringify(bundle));
  expect(readFileSync(join(extensionDir, "keep.ts"), "utf8")).toBe("existing extension");
}, 5000);

it("uses the existing switchover transaction and retains old package files", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), adapter = create!(f.options), scripts = join(f.releaseRoot, "scripts");
  mkdirSync(join(f.releaseRoot, "dist", "intercom"), { recursive: true, mode: 0o700 }); mkdirSync(scripts, { mode: 0o700 });
  writeFileSync(join(f.releaseRoot, "dist", "extension.js"), "export default () => {};", { mode: 0o600 });
  writeFileSync(join(f.releaseRoot, "dist", "intercom", "broker.mjs"), "broker", { mode: 0o600 });
  copyFileSync(join(process.cwd(), "scripts", "intercom-switchover.mjs"), join(scripts, "intercom-switchover.mjs"));
  copyFileSync(join(process.cwd(), "scripts", "extension-shim.mjs"), join(scripts, "extension-shim.mjs"));
  const legacy = join(f.agentDir, "npm", "node_modules", "pi-intercom"); mkdirSync(legacy, { recursive: true, mode: 0o700 });
  const old = join(legacy, "index.ts"); writeFileSync(old, "legacy client", { mode: 0o600 });
  writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-intercom", "npm:other"] }), { mode: 0o600 });
  const receipt = await adapter.switchover(f.peer, "op-1");
  expect(receipt.status).toBe("migration-pending");
  expect(JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8"))).toEqual({ packages: ["npm:other"] });
  expect(readFileSync(old, "utf8")).toBe("legacy client");
  expect(existsSync(join(f.agentDir, "extensions", "spider.ts"))).toBe(true);
}, 5000);
