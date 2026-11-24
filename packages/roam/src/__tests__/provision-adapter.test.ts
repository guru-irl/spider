import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { build } from "vite";
import type { Journal, Peer, Transport } from "../contracts";
import { DEFAULT_LIMITS } from "../contracts";
import { BOOTSTRAP_SCRIPT } from "../bootstrap-script";
import { copyPiAuth } from "../auth";
import { beginRelease, beginShortWrite, endShortWrite } from "../release-receipt";
import { releaseRequestDigest } from "../release-request";
import { inspectDestinationSettings, selectedSettingsDigests } from "../selected-files";
// @ts-expect-error The release shim is an executable JavaScript build helper.
import { extensionShim } from "../../../../scripts/extension-shim.mjs";
import { startTestBroker, stopTestBroker } from "@spider/intercom/test-support";
import * as adapterModule from "../provision-adapter";

const roots: string[] = [];
type Factory = (input: unknown) => {
  enroll(peer: Peer, hubMachineId: string, coreUnit: string): Promise<void>;
  setEnabled(peer: Peer, hubMachineId: string, enabled: boolean): Promise<void>;
  installRelease(peer: Peer, input: { bytes: Buffer; sha256: string; npmPrefix: string; globalRoot: string; pi: "1.2.0"; intercom: "spider-owned" }): Promise<{ pi: string; cli: string; supervisor: string }>;
  installFiles(peer: Peer, files: readonly { path: string; bytes: Buffer; mode: 0o600 | 0o700 }[], expectedSettingsFingerprint?: string): Promise<void>;
  installCredentialFiles(peer: Peer, files: readonly { path: string; bytes: Buffer; mode: 0o600 | 0o700 }[], providers: readonly string[], expectedSettingsFingerprint?: string): Promise<void>;
  auth(peer: Peer, operationId: string): import("../auth").AuthPorts;
  switchover(peer: Peer, operationId: string): Promise<{ status: string }>;
  verifyPeer(): Promise<import("../provision-contracts").ProvisionVerification>;
  cleanupSecrets(peer: Peer): Promise<void>;
  permissionTightening(peer: Peer): Promise<number>;
  systemd: { writeUnit(name: string, contents: string): Promise<void>; systemctl(argv: readonly string[]): Promise<void> };
};
const create = (adapterModule as { createHcProvisionAdapter?: Factory }).createHcProvisionAdapter;
const remoteProgram = (adapterModule as { PROVISION_REMOTE_SCRIPT?: string }).PROVISION_REMOTE_SCRIPT;

function fixture(short = false) {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, short ? "pa-" : "provision-adapter-")); roots.push(root);
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
  const launchIO: { stdout: string; stderr: string }[] = [];
  const launchState = { loseReply: false, dropBefore: 0, terminalOnly: false, prelude: "" }, terminalFile = join(root, "release-terminals.json"), coreLists = join(root, "core-lists");
  const fakeCore = `#!${process.execPath}\nimport fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'server') console.log(JSON.stringify({core:{id:'fixture-core'},pid:4321,version:'0.1.16'}));
else {
  const file = ${JSON.stringify(terminalFile)};
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {terminals:[]};
  const filters = args.flatMap((arg, index) => arg === '--label' ? [args[index + 1]] : []);
  fs.appendFileSync(${JSON.stringify(coreLists)}, JSON.stringify(args) + '\\n');
  if (data.probeFailure && !filters.includes('spider.operation=op-1')) {
    if (data.probeFailure === 'exit') process.exit(1);
    console.log(data.probeFailure === 'json' ? 'invalid' : JSON.stringify({terminals:null}));
    process.exit(0);
  }
  const matches = (item, filter) => {
    const split = filter.indexOf('=');
    return split > 0 && item.labels?.[filter.slice(0, split)] === filter.slice(split + 1);
  };
  const terminals = data.terminals.filter(item => data.filterMode === 'ignore' ||
    (data.filterMode === 'or' ? filters.some(filter => matches(item, filter)) : filters.every(filter => matches(item, filter)))).map(item => ({
    address:'box-1.invalid/t1', agent:'', cwd:'', state:item.state, turn:0,
    ...(item.state === 'finished' ? {exit_code:0, reason:'exit'} : {}),
    ...(Object.hasOwn(item, 'returnedLabels') ? {labels:item.returnedLabels} : {}),
  }));
  console.log(JSON.stringify({terminals}));
}\n`;
  writeFileSync(join(bin, "hc"), fakeCore, { mode: 0o700 });
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
      const argv = ["--input-type=module-typescript", "-e", launchState.prelude + remoteProgram!];
      requests.push({ action: String(request.action), argv });
      const child = spawnSync(process.execPath, argv, { input: JSON.stringify({ ...request, core: peer.core, coreId: "fixture-core" }), encoding: "utf8",
        timeout: request.action === "verify" ? 4900 : 4000,
        env: { ...process.env, HOME: home, PATH: bin, SPIDER_GLOBAL_ROOT: globalRoot } });
      if (child.status !== 0) throw new Error("fixture remote program failed");
      const reply = JSON.parse(child.stdout) as { error?: string; operationId?: string; path?: string; recursive?: true; value?: unknown };
      if (reply.error) throw Object.assign(new Error("remote request failed"), { code: reply.error,
        ...(reply.operationId ? { details: { blockingOperationId: reply.operationId } } : {}),
        ...(reply.path ? { details: { path: reply.path, ...(reply.recursive ? { recursive: true } : {}) } } : {}) });
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
      launchIO.push({ stdout: child.stdout, stderr: child.stderr });
      if (child.status !== 0) throw new Error("fixture background launch failed");
      if (launchState.loseReply) { launchState.loseReply = false; throw Object.assign(new Error("reply lost"), { code: "cli-timeout" }); }
      return { terminal: "box-1.invalid/t1" };
    },
  };
  const options = { peer, operationId: "op-1", destination, unitDir, limits: { ...DEFAULT_LIMITS, chunkBytes: 32 }, transport: remote,
    piProviders: ["github-copilot"] };
  const input = { bytes: Buffer.from("fixture archive"), sha256: releaseSha, npmPrefix, globalRoot, pi: "1.2.0" as const, intercom: "spider-owned" as const };
  return { root, home, globalRoot, agentDir, npmPrefix, unitDir, bin, releaseRoot, peer, destination, calls, writes, requests, launches, launchIO, launchState, terminalFile, coreLists, remote, options, input };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function releaseNpm(f: ReturnType<typeof fixture>, requireCpu = false, output?: { stage: "global" | "release"; file: string; fail: boolean }) {
  const log = join(f.root, "npm-calls");
  const npm = `#!${process.execPath}\nimport fs from 'node:fs'; import path from 'node:path';\nconst a=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:a,root:process.env.SPIDER_GLOBAL_ROOT,cuda:process.env.npm_config_onnxruntime_node_install_cuda,color:process.env.npm_config_color,loglevel:process.env.npm_config_loglevel})+'\\n');\nif(${requireCpu} && process.env.npm_config_onnxruntime_node_install_cuda!=='skip') process.exit(1);\nconst output=${JSON.stringify(output ?? null)};\nif(output && a.includes('--global')===(output.stage==='global')){process.stdout.write('npm-stdout-fixture\\n');process.stderr.write(fs.readFileSync(output.file));if(output.fail) process.exitCode=1;}\nconst prefix=a[a.indexOf('--prefix')+1];\nif(a.includes('--global')){const dir=path.join(prefix,'bin');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,'pi'),${JSON.stringify(`#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(join(f.root, "pi-release-calls"))},JSON.stringify(process.argv.slice(2))+'\\n'); console.log('1.2.0');\n`)},{mode:0o700});}\nelse {const p=path.join(prefix,'node_modules','@guru-irl','spider');for(const file of ['dist/extension.js','dist/intercom/broker.mjs','dist/roam/cli.mjs','dist/roam/supervisor.mjs','scripts/intercom-switchover.mjs','scripts/extension-shim.mjs','scripts/package-extension.ts']){const out=path.join(p,file);fs.mkdirSync(path.dirname(out),{recursive:true,mode:0o700});fs.writeFileSync(out,'fixture',{mode:0o600});}}\n`;
  writeFileSync(join(f.bin, "npm"), npm, { mode: 0o700 });
  return log;
}

function releaseNpmWithDefaultModes(f: ReturnType<typeof fixture>, oldUmask = false) {
  const log = join(f.root, "npm-calls"), mask = join(f.root, "pi-umask");
  const executable = `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(mask)},process.umask().toString(8)); console.log('1.2.0');\n`;
  const npm = `#!${process.execPath}\nimport fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2), prefix=args[args.indexOf('--prefix')+1];
if (${oldUmask}) process.umask(0o002);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
const write=(file, content, mode=0o666)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o777});fs.writeFileSync(file,content,{mode});};
if (${oldUmask}) for(let i=0;i<250;i++) write(path.join(prefix,'old-'+i,'file'),'retained');
if(args.includes('--global')) {
  write(path.join(prefix,'lib/node_modules/@earendil-works/pi-coding-agent/cli.js'),${JSON.stringify(executable)},0o777);
  fs.mkdirSync(path.join(prefix,'bin'),{recursive:true,mode:0o777});
  fs.symlinkSync('../lib/node_modules/@earendil-works/pi-coding-agent/cli.js',path.join(prefix,'bin/pi'));
} else {
  const root=path.join(prefix,'node_modules/@guru-irl/spider');
  write(path.join(root,'package.json'),JSON.stringify({name:'@guru-irl/spider',version:'0.1.0'}));
  for(const name of ['dist/extension.js','dist/intercom/broker.mjs','dist/roam/cli.mjs','dist/roam/supervisor.mjs','scripts/intercom-switchover.mjs','scripts/extension-shim.mjs','scripts/package-extension.ts']) write(path.join(root,name),'fixture');
}\n`;
  writeFileSync(join(f.bin, "npm"), npm, { mode: 0o700 });
  return log;
}

function installedInventory(f: ReturnType<typeof fixture>) {
  const request = { core: f.peer.core, coreId: "fixture-core", pi: f.peer.pi, cli: f.peer.cli,
    globalRoot: f.globalRoot, agentDir: f.agentDir, checks: [], coreUnit: "fixture.service" };
  const child = spawnSync(process.execPath, ["-e", BOOTSTRAP_SCRIPT], { input: JSON.stringify(request), encoding: "utf8",
    env: { ...process.env, HOME: f.home, PATH: f.bin }, cwd: f.home, timeout: 4000 });
  expect(child.status).toBe(0); expect(child.stderr).toBe("");
  const reply = JSON.parse(child.stdout);
  expect(reply).toHaveProperty("value");
  return reply.value as { pi: string | null; piVersion: string | null; spider: { installed: boolean } };
}

it("installs a non-writable tree under umask 002 that inventory can read", async () => {
  const previous = process.umask(0o002);
  try {
    const f = fixture(); rmSync(f.npmPrefix, { recursive: true }); releaseNpmWithDefaultModes(f);
    writeFileSync(join(f.bin, "systemctl"), `#!${process.execPath}\nconsole.log('Transient=no\\nFragmentPath=\\nMainPID=0');\n`, { mode: 0o700 });
    const adapter = create!(f.options);
    await expect(adapter.installRelease(f.peer, f.input)).resolves.toMatchObject({ pi: f.peer.pi, cli: f.peer.cli });
    const unsafe: string[] = [];
    function walk(path: string) {
      const info = lstatSync(path);
      if (info.isSymbolicLink()) return;
      if ((info.mode & 0o022) !== 0) unsafe.push(path);
      if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
    }
    walk(f.npmPrefix);
    expect(unsafe).toEqual([]);
    expect(readFileSync(join(f.root, "pi-umask"), "utf8")).toBe("22");
    expect(lstatSync(f.npmPrefix).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(f.npmPrefix, "spider-releases", f.input.sha256)).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(f.globalRoot, "roam", "provision", "op-1")).mode & 0o777).toBe(0o700);
    expect(installedInventory(f)).toMatchObject({ pi: f.peer.pi, piVersion: "1.2.0", spider: { installed: true } });
    const bin = join(f.npmPrefix, "bin"), before = lstatSync(bin).mode & 0o777;
    chmodSync(bin, before | 0o020);
    expect(installedInventory(f)).toMatchObject({ pi: null, piVersion: null, spider: { installed: true } });
    chmodSync(bin, before);
    const modules = join(f.npmPrefix, "spider-releases", f.input.sha256, "node_modules"), mode = lstatSync(modules).mode & 0o777;
    chmodSync(modules, mode | 0o020);
    expect(installedInventory(f)).toMatchObject({ pi: f.peer.pi, piVersion: "1.2.0", spider: { installed: false } });
    chmodSync(modules, mode);
  } finally { process.umask(previous); }
}, 10_000);

it("tightens hundreds of retained installer entries in one reuse without touching user data", async () => {
  const f = fixture(); rmSync(f.npmPrefix, { recursive: true }); releaseNpmWithDefaultModes(f);
  mkdirSync(join(f.globalRoot, "roam/provision"), { mode: 0o700 });
  writeFileSync(join(f.bin, "systemctl"), `#!${process.execPath}\nconsole.log('Transient=no\\nFragmentPath=\\nMainPID=0');\n`, { mode: 0o700 });
  const adapter = create!(f.options);
  await adapter.installRelease(f.peer, f.input);
  const outside = join(f.home, "user-pi"); mkdirSync(outside, { mode: 0o700 });
  const roots = [f.npmPrefix, join(f.globalRoot, "roam", "provision", "op-1")];
  for (const root of roots) {
    for (let i = 0; i < 250; i++) {
      const dir = join(root, `old-${i}`); mkdirSync(dir, { mode: 0o700 });
      writeFileSync(join(dir, "file"), "retained", { mode: 0o600 });
      chmodSync(dir, 0o777); chmodSync(join(dir, "file"), 0o666);
    }
    chmodSync(root, root === f.npmPrefix ? 0o777 : 0o720);
  }
  for (let i = 0; i < 250; i++) {
    const dir = join(dirname(dirname(dirname(f.releaseRoot))), `old-${i}`);
    mkdirSync(dir, { mode: 0o700 }); writeFileSync(join(dir, "file"), "retained", { mode: 0o600 });
    chmodSync(dir, 0o777); chmodSync(join(dir, "file"), 0o666);
  }
  chmodSync(outside, 0o777);
  await expect(adapter.installRelease(f.peer, f.input)).resolves.toMatchObject({ cli: f.peer.cli });
  for (const root of roots) for (let i = 0; i < 250; i++) {
    expect(lstatSync(join(root, `old-${i}`)).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(root, `old-${i}`, "file")).mode & 0o777).toBe(0o644);
  }
  expect(lstatSync(outside).mode & 0o777).toBe(0o777);
  const receipt = JSON.parse(readFileSync(join(roots[1], "permission-tightening.json"), "utf8"));
  expect(receipt).toEqual({ version: 1, changed: 1502 });
  writeFileSync(join(roots[1], "permission-tightening.json"), JSON.stringify({ version: 1, changed: 999_999 }), { mode: 0o600 });
  chmodSync(join(f.npmPrefix, "old-0/file"), 0o666);
  chmodSync(join(f.npmPrefix, "old-1/file"), 0o666);
  await adapter.installRelease(f.peer, f.input);
  expect(JSON.parse(readFileSync(join(roots[1], "permission-tightening.json"), "utf8"))).toEqual({ version: 1, changed: 1_000_000 });
  expect(installedInventory(f)).toMatchObject({ pi: f.peer.pi, spider: { installed: true } });
}, 10_000);

it("summarizes real installer permission tightening without exposing paths", async () => {
  const f = fixture(); rmSync(f.npmPrefix, { recursive: true }); releaseNpmWithDefaultModes(f);
  writeFileSync(join(f.bin, "systemctl"), `#!${process.execPath}\nconsole.log('Transient=no\\nFragmentPath=\\nMainPID=0');\n`, { mode: 0o700 });
  const adapter = create!(f.options);
  await expect(Promise.resolve().then(() => adapter.permissionTightening(f.peer))).resolves.toBe(0);
  await adapter.installRelease(f.peer, f.input);
  const privateFile = join(f.npmPrefix, "private-fixture"); writeFileSync(privateFile, "private data", { mode: 0o600 }); chmodSync(privateFile, 0o666);
  await adapter.installRelease(f.peer, f.input);
  expect(lstatSync(privateFile).mode & 0o777).toBe(0o644);
  await expect(adapter.permissionTightening(f.peer)).resolves.toBe(1);
  await expect(adapter.permissionTightening(f.peer)).resolves.toBe(1);
  const receipt = join(f.globalRoot, "roam/provision/op-1/permission-tightening.json");
  const late = join(dirname(receipt), "late-entry"); writeFileSync(late, "late", { mode: 0o600 }); chmodSync(late, 0o666);
  await expect(adapter.permissionTightening(f.peer)).resolves.toBe(2);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ version: 1, changed: 2 });
  writeFileSync(receipt, JSON.stringify({ version: 1, changed: 1_000_000 }), { mode: 0o600 });
  await expect(adapter.permissionTightening(f.peer)).resolves.toBe(1_000_000);
  writeFileSync(receipt, JSON.stringify({ version: 1, changed: 1_000_001, path: privateFile }), { mode: 0o600 });
  await expect(adapter.permissionTightening(f.peer)).rejects.toMatchObject({ code: "unsafe-staging" });
}, 10_000);

it("repairs old-umask npm output in both installer trees in one provisioning round", async () => {
  const f = fixture(); rmSync(f.npmPrefix, { recursive: true }); releaseNpmWithDefaultModes(f, true);
  writeFileSync(join(f.bin, "systemctl"), `#!${process.execPath}\nconsole.log('Transient=no\\nFragmentPath=\\nMainPID=0');\n`, { mode: 0o700 });
  const userPi = join(f.home, "user-prefix/lib/node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(userPi, { recursive: true, mode: 0o700 }); chmodSync(userPi, 0o775);
  for (let i = 0; i < 250; i++) { const file = join(userPi, `file-${i}`); writeFileSync(file, "user", { mode: 0o600 }); chmodSync(file, 0o664); }
  await expect(create!(f.options).installRelease(f.peer, f.input)).resolves.toMatchObject({ cli: f.peer.cli });
  for (const root of [f.npmPrefix, join(f.npmPrefix, "spider-releases", f.input.sha256)]) for (let i = 0; i < 250; i++) {
    expect(lstatSync(join(root, `old-${i}`)).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(root, `old-${i}`, "file")).mode & 0o777).toBe(0o644);
  }
  expect(lstatSync(userPi).mode & 0o777).toBe(0o775);
  expect(lstatSync(join(userPi, "file-249")).mode & 0o777).toBe(0o664);
  const receipt = JSON.parse(readFileSync(join(f.globalRoot, "roam/provision/op-1/permission-tightening.json"), "utf8"));
  expect(Object.keys(receipt).sort()).toEqual(["changed", "version"]);
  expect(receipt.changed).toBeGreaterThan(1000); expect(receipt.changed).toBeLessThanOrEqual(1_000_000);
  expect(installedInventory(f)).toMatchObject({ pi: f.peer.pi, spider: { installed: true } });
}, 10_000);

it("tightens an installer release inside a pre-existing user prefix", async () => {
  const f = fixture(); releaseNpmWithDefaultModes(f);
  const adapter = create!(f.options); await adapter.installRelease(f.peer, f.input);
  const release = join(f.npmPrefix, "spider-releases", f.input.sha256), file = join(f.releaseRoot, "package.json");
  chmodSync(release, 0o775); chmodSync(file, 0o666);
  await expect(adapter.installRelease(f.peer, f.input)).resolves.toMatchObject({ cli: f.peer.cli });
  expect(lstatSync(release).mode & 0o777).toBe(0o755); expect(lstatSync(file).mode & 0o777).toBe(0o644);
  expect(lstatSync(f.npmPrefix).mode & 0o777).toBe(0o700);
}, 10_000);

it("does not claim a replaced prefix from a stale creation receipt", async () => {
  const f = fixture(); rmSync(f.npmPrefix, { recursive: true }); releaseNpmWithDefaultModes(f);
  const adapter = create!(f.options); await adapter.installRelease(f.peer, f.input);
  renameSync(f.npmPrefix, join(f.home, "prior-prefix"));
  const piRoot = join(f.npmPrefix, "lib/node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(piRoot, { recursive: true, mode: 0o700 });
  const file = join(piRoot, "user.js"); writeFileSync(file, "user", { mode: 0o600 }); chmodSync(file, 0o666);
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({
    code: "destination-permissions-unsafe", details: { path: piRoot, recursive: true } });
  expect(lstatSync(file).mode & 0o777).toBe(0o666);
}, 10_000);

it("keeps staging private before accepting secret bytes", async () => {
  const f = fixture(), stage = join(f.globalRoot, "roam/provision/op-1");
  mkdirSync(stage, { recursive: true, mode: 0o700 }); chmodSync(stage, 0o755);
  await expect(create!(f.options).auth(f.peer, "op-1").stage(Buffer.from("{}"))).rejects.toMatchObject({ code: "unsafe-staging" });
  expect(readdirSync(stage)).toEqual([]);
});

it("does not chmod an entry reported as owned by another uid", async () => {
  const f = fixture(); rmSync(f.npmPrefix, { recursive: true }); releaseNpmWithDefaultModes(f);
  const adapter = create!(f.options); await adapter.installRelease(f.peer, f.input);
  const foreign = join(f.npmPrefix, "foreign"); writeFileSync(foreign, "foreign", { mode: 0o600 }); chmodSync(foreign, 0o666);
  // Model an unavailable foreign uid at the filesystem boundary, without requiring root.
  f.launchState.prelude = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original = fs.lstatSync; fs.lstatSync = (...args) => {const stat = original(...args); if(String(args[0]) === ${JSON.stringify(foreign)}) stat.uid += 1; return stat;}; syncBuiltinESMExports();\n`;
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "unsafe-path" });
  expect(lstatSync(foreign).mode & 0o777).toBe(0o666);
}, 10_000);

it("reports an unmarked user package root for one recursive repair", async () => {
  const f = fixture(), piRoot = join(f.npmPrefix, "lib/node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(piRoot, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 250; i++) { const file = join(piRoot, `file-${i}`); writeFileSync(file, "user", { mode: 0o600 }); chmodSync(file, 0o666); }
  releaseNpmWithDefaultModes(f);
  await expect(create!(f.options).installRelease(f.peer, f.input)).rejects.toMatchObject({
    code: "destination-permissions-unsafe", details: { path: piRoot, recursive: true } });
  expect(lstatSync(join(piRoot, "file-0")).mode & 0o777).toBe(0o666);
  expect(spawnSync("/bin/chmod", ["-R", "go-w", piRoot]).status).toBe(0);
  await expect(create!(f.options).installRelease(f.peer, f.input)).resolves.toMatchObject({ cli: f.peer.cli });
}, 10_000);

it("rejects an outside symlink in a proven installer tree without chmodding its target", async () => {
  const f = fixture(); rmSync(f.npmPrefix, { recursive: true }); releaseNpmWithDefaultModes(f);
  const adapter = create!(f.options); await adapter.installRelease(f.peer, f.input);
  const outside = join(f.home, "outside"); writeFileSync(outside, "user", { mode: 0o600 }); chmodSync(outside, 0o666);
  symlinkSync(outside, join(f.npmPrefix, "outside-link"));
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "unsafe-path" });
  expect(lstatSync(outside).mode & 0o777).toBe(0o666);
}, 10_000);

it.each(["\u009b", "\u061c", "\u202e"])("does not report a display-spoofing path from the remote installer %j", async control => {
  const f = fixture(), agentDir = join(f.home, `${control}agent`); mkdirSync(agentDir, { mode: 0o700 }); chmodSync(agentDir, 0o775);
  const options = { ...f.options, destination: { ...f.destination, agentDir } };
  const error = await f.remote.executeProvision(f.peer, { action: "install-files", operationId: "op-1", machineId: f.peer.machineId,
    home: f.home, globalRoot: f.globalRoot, agentDir, npmPrefix: f.npmPrefix, unitDir: f.unitDir, maximum: 1024, chunkBytes: 32 })
    .then(() => null, error => error);
  expect(error.code).toBe("destination-permissions-unsafe"); expect(error.details).toBeUndefined();
  await expect(create!(options).installFiles(f.peer, [{ path: "AGENTS.md", bytes: Buffer.from("sample"), mode: 0o600 }]))
    .rejects.toMatchObject({ code: "invalid-provision-reply", details: undefined });
  expect(lstatSync(agentDir).mode & 0o777).toBe(0o775); expect(existsSync(join(agentDir, "AGENTS.md"))).toBe(false);
});

it("reports a symlinked prefix component with a coded unsafe-path error", async () => {
  const f = fixture(), outside = join(f.home, "outside"); mkdirSync(outside, { mode: 0o700 });
  symlinkSync(outside, join(f.npmPrefix, "lib")); releaseNpmWithDefaultModes(f);
  await expect(create!(f.options).installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "unsafe-path" });
});

it.each(["prefix", "release", "release-child", "pi-file"] as const)("refuses an unsafe retained %s path", async kind => {
  const previous = process.umask(0o002);
  try {
    const f = fixture(), releasePrefix = join(f.npmPrefix, "spider-releases", f.input.sha256);
    const unsafe = kind === "prefix" ? f.npmPrefix : kind === "release" ? releasePrefix : kind === "release-child"
      ? join(releasePrefix, "node_modules", "@guru-irl") : join(f.npmPrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "partial.js");
    if (kind === "pi-file") { mkdirSync(dirname(unsafe), { recursive: true, mode: 0o700 }); writeFileSync(unsafe, "old", { mode: 0o600 }); chmodSync(unsafe, 0o664); }
    else { mkdirSync(unsafe, { recursive: true, mode: 0o700 }); chmodSync(unsafe, 0o775); }
    const log = releaseNpmWithDefaultModes(f), adapter = create!(f.options);
    await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "destination-permissions-unsafe", details: {
      path: kind === "release-child" ? releasePrefix : kind === "pi-file" ? dirname(unsafe) : unsafe,
      ...(kind === "prefix" ? {} : { recursive: true }),
    } });
    expect(lstatSync(unsafe).mode & 0o777).toBe(kind === "pi-file" ? 0o664 : 0o775);
    expect(existsSync(log)).toBe(false);
    chmodSync(unsafe, kind === "pi-file" ? 0o644 : 0o755);
    await expect(adapter.installRelease(f.peer, f.input)).resolves.toMatchObject({ pi: f.peer.pi, cli: f.peer.cli });
  } finally { process.umask(previous); }
}, 10_000);

it("refuses an unsafe retained pi executable before running npm", async () => {
  const previous = process.umask(0o002);
  try {
    const f = fixture(), bin = join(f.npmPrefix, "bin"); mkdirSync(bin, { mode: 0o700 });
    writeFileSync(f.peer.pi, "retained", { mode: 0o700 }); chmodSync(f.peer.pi, 0o775);
    const log = releaseNpmWithDefaultModes(f);
    await expect(create!(f.options).installRelease(f.peer, f.input)).rejects.toMatchObject({
      code: "destination-permissions-unsafe", details: { path: f.peer.pi } });
    expect(lstatSync(f.peer.pi).mode & 0o777).toBe(0o775);
    expect(readFileSync(f.peer.pi, "utf8")).toBe("retained"); expect(existsSync(log)).toBe(false);
  } finally { process.umask(previous); }
}, 10_000);

function prepareSwitchoverRelease(f: ReturnType<typeof fixture>) {
  const scripts = join(f.releaseRoot, "scripts");
  mkdirSync(join(f.releaseRoot, "dist", "intercom"), { recursive: true, mode: 0o700 });
  mkdirSync(scripts, { mode: 0o700 });
  writeFileSync(join(f.releaseRoot, "dist", "extension.js"), "export default () => {};", { mode: 0o600 });
  writeFileSync(join(f.releaseRoot, "dist", "intercom", "broker.mjs"), "broker", { mode: 0o600 });
  copyFileSync(join(process.cwd(), "scripts", "intercom-switchover.mjs"), join(scripts, "intercom-switchover.mjs"));
  copyFileSync(join(process.cwd(), "scripts", "extension-shim.mjs"), join(scripts, "extension-shim.mjs"));
}

it.each(["agent", "extensions"] as const)("reports an unsafe existing %s directory without changing it", async kind => {
  const previous = process.umask(0o002);
  try {
    const f = fixture(), extensions = join(f.agentDir, "extensions"), unsafe = kind === "agent" ? f.agentDir : extensions;
    prepareSwitchoverRelease(f); mkdirSync(extensions, { mode: 0o700 });
    writeFileSync(join(extensions, "keep.ts"), "keep", { mode: 0o600 }); chmodSync(unsafe, 0o775);
    const adapter = create!(f.options);
    await expect(adapter.switchover(f.peer, "op-1")).rejects.toMatchObject({ code: "destination-permissions-unsafe", details: { path: unsafe } });
    expect(lstatSync(unsafe).mode & 0o777).toBe(0o775);
    expect(readFileSync(join(extensions, "keep.ts"), "utf8")).toBe("keep");
    expect(existsSync(join(extensions, "spider.ts"))).toBe(false);
    chmodSync(unsafe, 0o755);
    await expect(adapter.switchover(f.peer, "op-1")).resolves.toMatchObject({ status: "migration-pending" });
  } finally { process.umask(previous); }
}, 10_000);

it("reports an other-writable extensions directory without changing it", async () => {
  const f = fixture(), extensions = join(f.agentDir, "extensions"); prepareSwitchoverRelease(f);
  mkdirSync(extensions, { mode: 0o700 }); chmodSync(extensions, 0o757);
  await expect(create!(f.options).switchover(f.peer, "op-1")).rejects.toMatchObject({
    code: "destination-permissions-unsafe", details: { path: extensions } });
  expect(lstatSync(extensions).mode & 0o777).toBe(0o757);
}, 5000);

it("reports an unsafe selected-file parent without changing it", async () => {
  const f = fixture(), themes = join(f.agentDir, "themes"), file = join(themes, "sample.json");
  mkdirSync(themes, { mode: 0o700 }); chmodSync(themes, 0o775); writeFileSync(file, "original", { mode: 0o600 });
  const adapter = create!(f.options), selected = { path: "themes/sample.json", bytes: Buffer.from('{"name":"sample"}'), mode: 0o600 as const };
  await expect(adapter.installFiles(f.peer, [selected])).rejects.toMatchObject({
    code: "destination-permissions-unsafe", details: { path: themes } });
  expect(lstatSync(themes).mode & 0o777).toBe(0o775); expect(readFileSync(file, "utf8")).toBe("original");
  chmodSync(themes, 0o755);
  await expect(adapter.installFiles(f.peer, [selected])).resolves.toBeUndefined();
  expect(readFileSync(file)).toEqual(selected.bytes);
}, 5000);

it("does not suggest chmod for a symlinked extensions directory", async () => {
  const f = fixture(), target = join(f.root, "outside"), extensions = join(f.agentDir, "extensions");
  prepareSwitchoverRelease(f); mkdirSync(target, { mode: 0o700 }); chmodSync(target, 0o775); symlinkSync(target, extensions);
  let caught: unknown;
  try { await create!(f.options).switchover(f.peer, "op-1"); } catch (error) { caught = error; }
  expect(caught).toBeTruthy();
  expect(caught).not.toMatchObject({ code: "destination-permissions-unsafe" });
  expect(lstatSync(extensions).isSymbolicLink()).toBe(true);
  expect(lstatSync(target).mode & 0o777).toBe(0o775);
  expect(readdirSync(target)).toEqual([]);
}, 5000);

it("creates the agent extensions directory safely under umask 002", async () => {
  const previous = process.umask(0o002);
  try {
    const f = fixture(); prepareSwitchoverRelease(f);
    await expect(create!(f.options).switchover(f.peer, "op-1")).resolves.toMatchObject({ status: "migration-pending" });
    expect(lstatSync(join(f.agentDir, "extensions")).mode & 0o022).toBe(0);
    expect(lstatSync(join(f.agentDir, "extensions", "spider.ts")).mode & 0o022).toBe(0);
  } finally { process.umask(previous); }
}, 10_000);

it("installs with CUDA downloads disabled for both npm commands", async () => {
  vi.stubEnv("npm_config_onnxruntime_node_install_cuda", "force");
  try {
    const f = fixture(), adapter = create!(f.options), log = releaseNpm(f, true);
    await expect(adapter.installRelease(f.peer, f.input)).resolves.toEqual({
      pi: f.peer.pi, cli: f.peer.cli, supervisor: f.destination.supervisor,
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { cuda?: string });
    expect(calls.map(call => call.cuda)).toEqual(["skip", "skip"]);
  } finally { vi.unstubAllEnvs(); }
}, 10_000);

it("overrides diagnostic settings for both npm commands", async () => {
  vi.stubEnv("npm_config_color", "always"); vi.stubEnv("npm_config_loglevel", "silent");
  try {
    const f = fixture(), log = releaseNpm(f);
    await expect(create!(f.options).installRelease(f.peer, f.input)).resolves.toEqual({
      pi: f.peer.pi, cli: f.peer.cli, supervisor: f.destination.supervisor,
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls.map(call => [call.color, call.loglevel])).toEqual([["false", "notice"], ["false", "notice"]]);
  } finally { vi.unstubAllEnvs(); }
}, 10_000);

it("overrides npm settings that suppress structured diagnostics", async () => {
  vi.stubEnv("npm_config_color", "always"); vi.stubEnv("npm_config_loglevel", "silent");
  try {
    const f = fixture();
    writeFileSync(join(f.bin, "npm"), `#!${process.execPath}\nif (process.env.npm_config_loglevel !== 'silent') process.stderr.write((process.env.npm_config_color === 'always' ? '\\x1b[31m' : '') + 'npm error code E404\\n');\nprocess.exit(1);\n`, { mode: 0o700 });
    await expect(create!(f.options).installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "npm-install-failed" });
    const receipt = JSON.parse(readFileSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"), "utf8"));
    expect(receipt.diagnostic.npmCode).toBe("E404");
  } finally { vi.unstubAllEnvs(); }
}, 10_000);

it("reports a missing adjacent npm with a durable specific code", async () => {
  const f = fixture(), adapter = create!(f.options);
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "npm-not-found" });
  const receipt = JSON.parse(readFileSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"), "utf8"));
  expect(receipt).toMatchObject({ state: "failed", reason: "npm-not-found" });
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "npm-not-found" });
  expect(f.launches).toHaveLength(1);
}, 10_000);

it.each(["global", "release"] as const)("records structured fields when the %s npm command fails", async stage => {
  const f = fixture(), adapter = create!(f.options), stderr = join(f.root, "npm-stderr");
  const messages = [
    `npm error code ${stage === "global" ? "E404" : "1"}`,
    `npm error path /home/example/work/node_modules/${stage === "global" ? "@example/tool" : "onnxruntime-node"}`,
    "npm error GET https://box-1.invalid/download?token=fixture-url-value",
    "npm error //box-1.invalid/:_authToken=fixture-auth-value",
    "npm error password=fixture-password-value",
    "npm error Authorization: Bearer fixture-bearer-value",
    "npm error API_KEY=fixture-key-value",
    "npm error cookie: fixture-cookie-value",
    "npm error access_token:",
    "fixtureAccessValue42",
    "npm error token=" + "Z".repeat(16_000),
    "npm error Failed to download the binaries: 404 Not Found",
  ];
  writeFileSync(stderr, "npm warn harmless detail\n".repeat(50_000) + messages.join("\n") + "\n");
  releaseNpm(f, false, { stage, file: stderr, fail: true });
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "npm-install-failed" });
  const receiptFile = join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json");
  const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
  expect(receipt).toMatchObject({ state: "failed", reason: "npm-install-failed" });
  expect(lstatSync(receiptFile).mode & 0o777).toBe(0o600);
  expect(receipt.diagnostic).toEqual({ step: stage === "global" ? "pi" : "release", exitCode: 1, signal: null,
    npmCode: stage === "global" ? "E404" : "1", packageName: stage === "global" ? "@example/tool" : "onnxruntime-node" });
  expect(receipt).not.toHaveProperty("stderrTail");
  expect(JSON.stringify(receipt)).not.toContain("Failed to download the binaries: 404 Not Found");
  expect(JSON.stringify(receipt)).not.toContain("/home/example/work");
  expect(JSON.stringify(receipt)).not.toContain("npm error");
  for (const hidden of ["https://", "fixture-url-value", "fixture-auth-value", "fixture-password-value", "fixture-bearer-value",
    "fixture-key-value", "fixture-cookie-value", "fixtureAccessValue42", "Z".repeat(100)]) {
    expect(JSON.stringify(receipt)).not.toContain(hidden);
  }
  expect(f.launchIO).toHaveLength(1);
  expect(() => JSON.parse(f.launchIO[0].stdout)).not.toThrow();
  expect(f.launchIO[0].stdout).not.toContain("npm-stdout-fixture");
  expect(f.launchIO[0].stdout).not.toContain("fixture-bearer-value");
  expect(f.launchIO[0].stderr).not.toContain("fixture-bearer-value");
}, 15_000);

it("does not persist credentials or URLs from npm stderr", async () => {
  const f = fixture(), adapter = create!(f.options), stderr = join(f.root, "npm-stderr");
  const messages = [
    'npm error "key": "fixtureKeyFieldValue"',
    "npm error service_access_key_id=fixtureAccessIdValue",
    "npm error username=fixtureUserName",
    "npm error GET https%3A%2F%2Fbox-1.invalid%2Ffile",
    "npm error guest:creds@box-1.invalid",
    "npm error secret_token:",
    "",
    "fixtureMultiLineValue",
    'npm error "credential": {',
    '  "value": "fixtureNestedValue"',
    "}",
    "npm error code E401",
  ];
  writeFileSync(stderr, messages.join("\n") + "\n");
  releaseNpm(f, false, { stage: "global", file: stderr, fail: true });
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "npm-install-failed" });
  const receipt = JSON.parse(readFileSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"), "utf8"));
  expect(receipt.diagnostic).toEqual({ step: "pi", exitCode: 1, signal: null, npmCode: "E401", packageName: null });
  expect(receipt).not.toHaveProperty("stderrTail");
  for (const hidden of ["fixtureKeyFieldValue", "fixtureAccessIdValue", "fixtureUserName", "https%3A%2F%2F", "guest:creds@",
    "fixtureMultiLineValue", "fixtureNestedValue"]) expect(JSON.stringify(receipt)).not.toContain(hidden);
}, 10_000);

it("does not persist scheme-free URLs or token-shaped npm output", async () => {
  const f = fixture(), adapter = create!(f.options), stderr = join(f.root, "npm-stderr");
  const hidden = ["box-1.invalid/path", "192.0.2.1/path", "tok_A1b2C3d4E5f6"];
  writeFileSync(stderr, hidden.map(value => `npm error ${value}`).join("\n") + "\nnpm error code E404\n");
  releaseNpm(f, false, { stage: "global", file: stderr, fail: true });
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "npm-install-failed" });
  const receipt = JSON.parse(readFileSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"), "utf8"));
  expect(receipt.diagnostic).toEqual({ step: "pi", exitCode: 1, signal: null, npmCode: "E404", packageName: null });
  expect(receipt).not.toHaveProperty("stderrTail");
  expect(hidden.filter(value => JSON.stringify(receipt).includes(value))).toEqual([]);
}, 10_000);

it.each([
  { input: "ELIFECYCLE", expected: "ELIFECYCLE" },
  { input: "ENOTFOUND", expected: "ENOTFOUND" },
  { input: "ETIMEDOUT", expected: "ETIMEDOUT" },
  { input: "EACCES", expected: "EACCES" },
  { input: "1", expected: "1" },
  { input: "EUNTRUSTED", expected: null },
])("accepts only allowlisted npm code $input", async ({ input, expected }) => {
  const f = fixture(), adapter = create!(f.options), stderr = join(f.root, "npm-stderr");
  writeFileSync(stderr, `npm ERR! code ${input}\nnpm ERR! path /home/example/node_modules/outer/node_modules/@scope/tool/lib\n`);
  releaseNpm(f, false, { stage: "release", file: stderr, fail: true });
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "npm-install-failed" });
  const receipt = JSON.parse(readFileSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"), "utf8"));
  expect(receipt.diagnostic).toEqual({ step: "release", exitCode: 1, signal: null, npmCode: expected, packageName: "@scope/tool" });
  expect(JSON.stringify(receipt)).not.toContain("/home/example");
}, 10_000);

it.each([
  "/home/example/node_modules/bad%20name",
  "/home/example/node_modules/@scope",
  "/home/example/node_modules/good/../../private",
  "https://box-1.invalid/node_modules/good",
  "/home/example/other/package",
])("does not persist an invalid npm path: %s", async path => {
  const f = fixture(), adapter = create!(f.options), stderr = join(f.root, "npm-stderr");
  writeFileSync(stderr, `npm error code E404\nnpm error path ${path}\n`);
  releaseNpm(f, false, { stage: "global", file: stderr, fail: true });
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "npm-install-failed" });
  const receipt = JSON.parse(readFileSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"), "utf8"));
  expect(receipt.diagnostic).toEqual({ step: "pi", exitCode: 1, signal: null, npmCode: "E404", packageName: null });
  expect(JSON.stringify(receipt)).not.toContain(path);
}, 10_000);

it("extracts structured fields after an oversized stderr line", async () => {
  const f = fixture(), adapter = create!(f.options), stderr = join(f.root, "npm-stderr");
  writeFileSync(stderr, "Z".repeat(30_000) + "\nnpm error code E404\nnpm error path /home/example/node_modules/sample\n");
  releaseNpm(f, false, { stage: "global", file: stderr, fail: true });
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "npm-install-failed" });
  const receipt = JSON.parse(readFileSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"), "utf8"));
  expect(receipt.diagnostic).toEqual({ step: "pi", exitCode: 1, signal: null, npmCode: "E404", packageName: "sample" });
  expect(JSON.stringify(receipt)).not.toContain("Z".repeat(30));
}, 10_000);

it("reports an npm launch failure when npm exists but its interpreter is missing", async () => {
  const f = fixture(), adapter = create!(f.options);
  writeFileSync(join(f.bin, "npm"), "#!/example/no-interpreter\n", { mode: 0o700 });
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "npm-install-failed" });
  const receipt = JSON.parse(readFileSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"), "utf8"));
  expect(receipt).toMatchObject({ state: "failed", reason: "npm-install-failed", diagnostic: {
    step: "pi", exitCode: null, signal: null, npmCode: null, packageName: null,
  } });
  expect(receipt).not.toHaveProperty("stderrTail");
}, 10_000);

it("records an outside npm kill without timeout evidence", async () => {
  const f = fixture();
  writeFileSync(join(f.bin, "npm"), `#!${process.execPath}\nprocess.kill(process.pid, 'SIGTERM');\n`, { mode: 0o700 });
  await expect(create!(f.options).installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "npm-install-failed" });
  const receipt = JSON.parse(readFileSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"), "utf8"));
  expect(receipt.diagnostic).toEqual({ step: "pi", exitCode: null, signal: "SIGTERM", npmCode: null, packageName: null });
}, 10_000);

it("stops a timed-out npm process group and records its signal", async () => {
  const f = fixture(), marker = join(f.root, "late-write");
  const delayed = `import fs from 'node:fs'; setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'late'), 2000);`;
  writeFileSync(join(f.bin, "npm"), `#!${process.execPath}\nimport { spawn } from 'node:child_process';\nspawn(process.execPath, ['-e', ${JSON.stringify(delayed)}], {stdio:['ignore','ignore','inherit']});\nprocess.stderr.write('npm error waiting for fixture\\n');\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const adapter = create!({ ...f.options, limits: { ...f.options.limits, importMs: 600, retryDelaysMs: [50] } });
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "npm-install-failed" });
  const receipt = JSON.parse(readFileSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"), "utf8"));
  expect(receipt.diagnostic).toEqual({ step: "pi", exitCode: null, signal: "SIGKILL", npmCode: null, packageName: null, timedOut: true });
  expect(JSON.stringify(receipt)).not.toContain("npm error waiting for fixture");
  await new Promise(resolve => setTimeout(resolve, 2200));
  expect(existsSync(marker)).toBe(false);
}, 15_000);

it.each(["SIGTERM", "SIGHUP", "SIGINT"] as const)("stops npm and its grandchild when the installer receives %s", async signal => {
  const f = fixture(), ready = join(f.root, "ready"), pids = join(f.root, "pids");
  const grandchild = `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n'); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  writeFileSync(join(f.bin, "npm"), `#!${process.execPath}\nimport fs from 'node:fs'; import { spawn } from 'node:child_process';\nfs.writeFileSync(${JSON.stringify(pids)}, process.pid + '\\n');\nspawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'ignore'});\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  let npmPid = 0, ids: number[] = [], result: { code: number | null; signal: NodeJS.Signals | null } | undefined, survivors: number[] = [];
  f.remote.launchRelease = async (_peer, _operationId, requestFile) => {
    const child = spawn(process.execPath, ["--input-type=module-typescript", "-e", remoteProgram!, requestFile], {
      stdio: "ignore", env: { ...process.env, HOME: f.home, PATH: f.bin, SPIDER_GLOBAL_ROOT: f.globalRoot },
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < deadline) {
        if (existsSync(pids)) npmPid = Number(readFileSync(pids, "utf8").split("\n")[0]);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(existsSync(ready)).toBe(true);
      ids = readFileSync(pids, "utf8").trim().split("\n").map(Number); npmPid = ids[0];
      child.kill(signal);
      if (signal === "SIGTERM") {
        await new Promise(resolve => setTimeout(resolve, 100));
        child.kill(signal);
      }
      result = await exited;
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          if (process.platform === "linux") {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return false;
          }
          return true;
        } catch { return false; }
      };
      const stoppedBy = Date.now() + 2000;
      while (ids.some(alive) && Date.now() < stoppedBy) await new Promise(resolve => setTimeout(resolve, 20));
      survivors = ids.filter(alive);
      throw Object.assign(new Error("launch ended"), { code: "consent-required" });
    } finally {
      if (npmPid) { try { process.kill(-npmPid, "SIGKILL"); } catch { /* Already stopped. */ } }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  };
  await expect(create!(f.options).installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "consent-required" });
  expect(ids).toHaveLength(2);
  expect(result).toEqual({ code: null, signal });
  expect(survivors).toEqual([]);
}, 15_000);

it("does not fail a successful npm command that emits a large stderr stream", async () => {
  const f = fixture(), adapter = create!(f.options), stderr = join(f.root, "npm-stderr");
  writeFileSync(stderr, "npm warn harmless detail\n".repeat(50_000));
  releaseNpm(f, false, { stage: "global", file: stderr, fail: false });
  await expect(adapter.installRelease(f.peer, f.input)).resolves.toEqual({
    pi: f.peer.pi, cli: f.peer.cli, supervisor: f.destination.supervisor,
  });
  expect(() => JSON.parse(f.launchIO[0].stdout)).not.toThrow();
  expect(f.launchIO[0].stdout).not.toContain("npm-stdout-fixture");
  expect(f.launchIO[0].stderr).not.toContain("npm warn harmless detail");
}, 15_000);

it("enrollment short writes converge after a lost reply and reject a changed hub", async () => {
  const f = fixture(), adapter = create!(f.options), hub = "00000000-0000-4000-8000-000000000001";
  const original = f.remote.executeProvision.bind(f.remote); let lost = false;
  f.remote.executeProvision = async (peer, request) => {
    const result = await original(peer, request);
    if (request.action === "enrollment" && !lost) { lost = true; throw Object.assign(new Error("lost"), { code: "cli-timeout" }); }
    return result;
  };
  await adapter.enroll(f.peer, hub, "herdr-core.service");
  expect(JSON.parse(readFileSync(join(f.globalRoot, "roam", "config.json"), "utf8"))).toMatchObject({ enabled: false, machineId: f.peer.machineId, hubMachineId: hub, peers: [] });
  await adapter.enroll(f.peer, hub, "herdr-core.service");
  await expect(adapter.enroll(f.peer, "00000000-0000-4000-8000-000000000003", "herdr-core.service")).rejects.toMatchObject({ code: "operation-arguments-changed" });
  expect(f.requests.filter(row => row.action === "enrollment")).toHaveLength(4);
}, 5000);

it("remote enrollment refuses malformed matching configuration without replacing it", async () => {
  const f = fixture(), hub = "00000000-0000-4000-8000-000000000001", file = join(f.globalRoot, "roam", "config.json");
  const saved = Buffer.from(JSON.stringify({ enabled: "yes", role: "box", machineId: f.peer.machineId, hubMachineId: hub, peers: [], coreUnit: "herdr-core.service" }));
  writeFileSync(file, saved, { mode: 0o600 });
  await expect(create!(f.options).enroll(f.peer, hub, "herdr-core.service")).rejects.toMatchObject({ code: "enrollment-conflict" });
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
  expect(JSON.parse(readFileSync(join(f.root, "pi-release-calls"), "utf8").trim())).toEqual(["--version"]);
  expect(existsSync(join(f.agentDir, "intercom", "broker.sock"))).toBe(false);
  expect(existsSync(f.calls)).toBe(false);
  expect(f.requests.some(row => ["systemctl", "unit-write", "verify", "switchover"].includes(row.action))).toBe(false);
  expect(JSON.stringify(calls)).not.toContain("npm:pi-intercom");
  expect(f.writes.every(item => item.bytes.length <= 32)).toBe(true);
  expect(readdirSync(join(f.globalRoot, "roam", "provision", "op-1")).filter(name => /^release-[a-f0-9]{32}-\d+$/.test(name))).toEqual([]);
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

it("does not relaunch when filtered terminal evidence has no returned labels", async () => {
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

it.each(["ignore", "or"])("refuses label-free terminal evidence when the core uses %s filtering", async filterMode => {
  const f = fixture(), adapter = create!(f.options);
  writeFileSync(f.terminalFile, JSON.stringify({ filterMode, terminals: [{ state: "finished", labels: {
    "spider.operation": "another-op", "spider.machine": f.peer.machineId,
  } }] }));
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "release-evidence-unfiltered" });
  expect(f.launches).toEqual([]);
  expect(existsSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"))).toBe(false);
}, 10_000);

it.each(["exit", "json", "shape"])("refuses label-free evidence if the filter probe has %s failure", async probeFailure => {
  const f = fixture();
  writeFileSync(f.terminalFile, JSON.stringify({ probeFailure, terminals: [{ state: "finished", labels: {
    "spider.operation": "op-1", "spider.machine": f.peer.machineId,
  } }] }));
  await expect(create!(f.options).installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "release-evidence-unavailable" });
  expect(f.launches).toEqual([]);
  expect(existsSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"))).toBe(false);
}, 10_000);

it("uses a fresh operation label with the same machine for every label-free observation", async () => {
  const f = fixture();
  writeFileSync(f.terminalFile, JSON.stringify({ terminals: [{ state: "live", labels: {
    "spider.operation": "op-1", "spider.machine": f.peer.machineId,
  } }] }));
  const request = { action: "release-observe", operationId: "op-1", machineId: f.peer.machineId, home: f.home,
    globalRoot: f.globalRoot, agentDir: f.agentDir, npmPrefix: f.npmPrefix, unitDir: f.unitDir,
    node: f.peer.node, pi: f.peer.pi, cli: f.peer.cli, supervisor: f.destination.supervisor,
    maximum: f.options.limits.agentBytes, chunkBytes: f.options.limits.chunkBytes, sha256: f.input.sha256, piVersion: "1.2.0" };
  expect(await f.remote.executeProvision(f.peer, request)).toEqual({ state: "started" });
  expect(await f.remote.executeProvision(f.peer, request)).toEqual({ state: "started" });
  const lists = readFileSync(f.coreLists, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
  expect(lists).toHaveLength(4);
  for (const args of lists) {
    expect(args.slice(0, 3)).toEqual(["ls", "--all", "--json"]);
    expect(args).toContain(`spider.machine=${f.peer.machineId}`);
  }
  expect(lists[0]).toContain("spider.operation=op-1");
  expect(lists[2]).toContain("spider.operation=op-1");
  const labels = [lists[1], lists[3]].map(args => args.find(arg => arg.startsWith("spider.operation=")));
  for (const label of labels) expect(label).toMatch(/^spider\.operation=[a-f0-9-]{36}$/);
  expect(labels[0]).not.toBe(labels[1]);
  expect(f.launches).toEqual([]);
}, 10_000);

it("ignores a terminal with different server-side labels", async () => {
  const f = fixture(), adapter = create!({ ...f.options, limits: { ...f.options.limits, importMs: 5000, retryDelaysMs: [50] } }), log = releaseNpm(f);
  writeFileSync(f.terminalFile, JSON.stringify({ terminals: [{ state: "live", labels: {
    "spider.operation": "another-op", "spider.machine": f.peer.machineId,
  } }] }));
  await expect(adapter.installRelease(f.peer, f.input)).resolves.toEqual({
    pi: f.peer.pi, cli: f.peer.cli, supervisor: f.destination.supervisor,
  });
  expect(f.launches).toHaveLength(1);
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
}, 15_000);

it.each([
  ["wrong operation", { "spider.operation": "another-op", "spider.machine": "other-box.invalid" }],
  ["wrong machine", { "spider.operation": "op-1", "spider.machine": "wrong-box.invalid" }],
  ["missing machine", { "spider.operation": "op-1" }],
  ["null labels", null],
  ["array labels", []],
])("rejects terminal evidence with %s when labels are returned", async (_name, returnedLabels) => {
  const f = fixture(), adapter = create!(f.options);
  writeFileSync(f.terminalFile, JSON.stringify({ terminals: [{ state: "finished", labels: {
    "spider.operation": "op-1", "spider.machine": f.peer.machineId,
  }, returnedLabels }] }));
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "release-evidence-unavailable" });
  expect(f.launches).toEqual([]);
}, 10_000);

it("accepts terminal evidence when returned labels match", async () => {
  const f = fixture(), adapter = create!(f.options);
  const labels = { "spider.operation": "op-1", "spider.machine": f.peer.machineId };
  writeFileSync(f.terminalFile, JSON.stringify({ terminals: [{ state: "finished", labels, returnedLabels: labels }] }));
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "installer-interrupted" });
  expect(f.launches).toEqual([]);
  expect(readFileSync(f.coreLists, "utf8").trim().split("\n")).toHaveLength(1);
}, 10_000);

it("rejects terminal evidence with an unknown state even when labels are absent", async () => {
  const f = fixture(), adapter = create!(f.options);
  writeFileSync(f.terminalFile, JSON.stringify({ terminals: [{ state: "unknown", labels: {
    "spider.operation": "op-1", "spider.machine": f.peer.machineId,
  } }] }));
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "release-evidence-unavailable" });
  expect(f.launches).toEqual([]);
}, 10_000);

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

it("abandons an old prepared release only after its deadline and an absent terminal observation", async () => {
  const f = fixture(), first = create!(f.options), second = create!({ ...f.options, operationId: "op-2" });
  const delayedLaunch = f.remote.launchRelease.bind(f.remote);
  f.remote.launchRelease = async () => { throw Object.assign(new Error("refused"), { code: "core-changed" }); };
  await expect(first.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "core-changed" });
  const stage = join(f.globalRoot, "roam", "provision", "op-1"), requestFile = join(stage, "release-request");
  expect(existsSync(join(stage, "release-receipt.json"))).toBe(false);
  const old = new Date(Date.now() - 120_000); utimesSync(requestFile, old, old);
  await second.cleanupSecrets(f.peer);
  expect(JSON.parse(readFileSync(join(stage, "release-receipt.json"), "utf8"))).toMatchObject({ state: "failed", reason: "release-abandoned" });
  expect(readdirSync(stage).filter(name => /^release-[a-f0-9]{32}-\d+$/.test(name))).toEqual([]);
  await delayedLaunch(f.peer, "op-1", requestFile);
  expect(JSON.parse(readFileSync(join(stage, "release-receipt.json"), "utf8"))).toMatchObject({ state: "failed", reason: "release-abandoned" });
  f.remote.launchRelease = delayedLaunch; const log = releaseNpm(f);
  expect(await second.installRelease(f.peer, f.input)).toEqual({ pi: f.peer.pi, cli: f.peer.cli, supervisor: f.destination.supervisor });
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
}, 5000);

it("retains an expired prepared release when a labelled terminal or its core evidence is uncertain", async () => {
  const f = fixture(), first = create!(f.options), second = create!({ ...f.options, operationId: "op-2" });
  f.remote.launchRelease = async () => { throw Object.assign(new Error("refused"), { code: "core-changed" }); };
  await expect(first.installRelease(f.peer, f.input)).rejects.toMatchObject({ code: "core-changed" });
  const stage = join(f.globalRoot, "roam", "provision", "op-1"), requestFile = join(stage, "release-request");
  await expect(second.cleanupSecrets(f.peer)).rejects.toMatchObject({ code: "release-in-progress", details: { blockingOperationId: "op-1" } });
  const old = new Date(Date.now() - 120_000); utimesSync(requestFile, old, old);
  for (const state of ["live", "finished"]) {
    writeFileSync(f.terminalFile, JSON.stringify({ terminals: [{ state, labels: { "spider.operation": "op-1", "spider.machine": f.peer.machineId } }] }));
    await expect(second.cleanupSecrets(f.peer)).rejects.toMatchObject({ code: "release-in-progress", details: { blockingOperationId: "op-1" } });
    expect(existsSync(join(stage, "release-receipt.json"))).toBe(false);
  }
  writeFileSync(join(f.bin, "hc"), `#!${process.execPath}\nconsole.log(JSON.stringify({core:{id:'replacement-core'}}));\n`, { mode: 0o700 });
  await expect(second.cleanupSecrets(f.peer)).rejects.toMatchObject({ code: "release-in-progress", details: { blockingOperationId: "op-1" } });
  expect(existsSync(join(stage, "release-receipt.json"))).toBe(false);
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
  const stage = join(f.globalRoot, "roam", "provision", "op-1");
  expect(JSON.parse(readFileSync(join(stage, "release-receipt.json"), "utf8"))).toMatchObject({ state: "failed" });
  expect(readdirSync(stage).filter(name => /^release-[a-f0-9]{32}-\d+$/.test(name))).toEqual([]);
}, 5000);

it("records a failed installer and does not repeat it for the same operation", async () => {
  expect(create).toBeTypeOf("function"); expect(remoteProgram).toBeTypeOf("string");
  const f = fixture(), adapter = create!(f.options);
  writeFileSync(join(f.bin, "npm"), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
  await expect(adapter.installRelease(f.peer, f.input)).rejects.toThrow();
  const receipt = JSON.parse(readFileSync(join(f.globalRoot, "roam", "provision", "op-1", "release-receipt.json"), "utf8"));
  expect(receipt.state).toBe("failed");
  expect(readdirSync(join(f.globalRoot, "roam", "provision", "op-1")).filter(name => /^release-[a-f0-9]{32}-\d+$/.test(name))).toEqual([]);
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

it("the destination refuses a direct attempt to overwrite the core unit", async () => {
  const f = fixture(), core = join(f.unitDir, "herdr-core.service"); writeFileSync(core, "original core unit", { mode: 0o600 });
  await expect(f.remote.executeProvision(f.peer, { action: "unit-write", operationId: "op-1", machineId: f.peer.machineId,
    home: f.home, globalRoot: f.globalRoot, agentDir: f.agentDir, npmPrefix: f.npmPrefix, unitDir: f.unitDir,
    maximum: f.options.limits.agentBytes, chunkBytes: f.options.limits.chunkBytes,
    unit: "herdr-core.service", contents: "replacement" })).rejects.toMatchObject({ code: "invalid-unit" });
  expect(readFileSync(core, "utf8")).toBe("original core unit");
}, 5000);

it("keeps the single remote program argument below Linux's conservative limit", () => {
  expect(Buffer.byteLength(remoteProgram!)).toBeLessThan(120 * 1024);
});

it("installs a valid thinking level through the generated destination program", async () => {
  const f = fixture(), adapter = create!(f.options);
  const file = { path: "settings.json", bytes: Buffer.from('{"defaultThinkingLevel":"xhigh"}'), mode: 0o600 as const };
  const preview = inspectDestinationSettings({ home: f.home, destinationRoot: f.agentDir, entries: selectedSettingsDigests(file), maximum: 1024 * 1024 });
  await adapter.installFiles(f.peer, [file], preview.fingerprint);
  expect(JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8"))).toEqual({ defaultThinkingLevel: "xhigh" });
}, 5000);

it("the generated destination program rejects a substituted invalid thinking level", async () => {
  const f = fixture(); f.options.limits.chunkBytes = 1024;
  const adapter = create!(f.options), remote = f.remote.executeProvision.bind(f.remote);
  const file = { path: "settings.json", bytes: Buffer.from('{"defaultThinkingLevel":"high"}'), mode: 0o600 as const };
  const preview = inspectDestinationSettings({ home: f.home, destinationRoot: f.agentDir, entries: selectedSettingsDigests(file), maximum: 1024 * 1024 });
  const injected = Buffer.from('{"defaultThinkingLevel":"beyond"}');
  f.remote.executeProvision = async (peer, request) => {
    if (request.action !== "install-files") return remote(peer, request);
    const sent = request.file as { path: string; mode: number; chunks: { name: string; size: number; sha256: string }[] };
    expect(sent.chunks).toHaveLength(1);
    writeFileSync(join(f.globalRoot, "roam", "provision", "op-1", sent.chunks[0].name), injected, { mode: 0o600 });
    const chunk = { ...sent.chunks[0], size: injected.length, sha256: createHash("sha256").update(injected).digest("hex") };
    return remote(peer, { ...request, file: { ...sent, chunks: [chunk] } });
  };
  await expect(adapter.installFiles(f.peer, [file], preview.fingerprint)).rejects.toMatchObject({ code: "invalid-file" });
  expect(existsSync(join(f.agentDir, "settings.json"))).toBe(false);
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

it.each(["invalid-limits", "invalid-staging-name", "invalid-release-request", "unknown-provision-action", "provision-transport-failed"] as const)
("preserves the known adapter error %s", async code => {
  const f = fixture();
  f.remote.executeProvision = async () => { throw Object.assign(new Error("untrusted detail"), { code }); };
  await expect(create!(f.options).switchover(f.peer, "op-1")).rejects.toMatchObject({ code });
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

it("disables only the supervisor autostart through the remote systemd adapter", async () => {
  const f = fixture(), adapter = create!(f.options);
  await expect(adapter.systemd.systemctl(["--user", "disable", "spider-roam-supervisor.service"])).resolves.toBeUndefined();
  expect(readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([
    ["--user", "disable", "spider-roam-supervisor.service"],
  ]);
  await expect(adapter.systemd.systemctl(["--user", "disable", "herdr-core.service"])).rejects.toThrow();
  await expect(adapter.systemd.systemctl(["--user", "disable", "--now", "spider-roam-supervisor.service"])).rejects.toThrow();
  const request = { action: "systemctl", operationId: "op-1", machineId: f.peer.machineId, home: f.home, globalRoot: f.globalRoot,
    agentDir: f.agentDir, npmPrefix: f.npmPrefix, unitDir: f.unitDir, pi: f.peer.pi, cli: f.peer.cli, node: f.peer.node,
    supervisor: f.destination.supervisor, maximum: DEFAULT_LIMITS.agentBytes, chunkBytes: 32, timeout: DEFAULT_LIMITS.importMs };
  for (const argv of [["--user", "disable", "herdr-core.service"], ["--user", "disable", "--now", "spider-roam-supervisor.service"]]) {
    await expect(f.remote.executeProvision(f.peer, { ...request, argv })).rejects.toMatchObject({ code: "invalid-systemctl" });
  }
  expect(readFileSync(f.calls, "utf8").trim().split("\n")).toHaveLength(1);
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

async function withReadinessBroker<T>(f: ReturnType<typeof fixture>, features: string[], work: () => Promise<T>, identity = "spider"): Promise<T> {
  const intercom = join(f.agentDir, "intercom"), socket = join(intercom, "broker.sock");
  mkdirSync(intercom, { recursive: true, mode: 0o700 });
  const server = join(f.root, "broker-fixture.mjs");
  writeFileSync(server, `import net from 'node:net'; import fs from 'node:fs';
const server=net.createServer(socket=>{ let data=Buffer.alloc(0); socket.on('error',()=>{}); socket.on('data',chunk=>{
 data=Buffer.concat([data,chunk]); if(data.length<4||data.length<4+data.readUInt32BE(0))return;
 const request=JSON.parse(data.subarray(4,4+data.readUInt32BE(0))); const body=Buffer.from(JSON.stringify({type:'health_ok',requestId:request.requestId,protocol:'pi-intercom',version:1,implementation:${JSON.stringify(identity)},features:${JSON.stringify(features)}}));
 const header=Buffer.alloc(4); header.writeUInt32BE(body.length); socket.write(Buffer.concat([header,body])); }); });
server.listen(${JSON.stringify(socket)},()=>{fs.chmodSync(${JSON.stringify(socket)},0o600); console.log('fixture-ready');});`, { mode: 0o600 });
  const child = startTestBroker(process.execPath, [server], { env: { ...process.env, HOME: f.home, PI_CODING_AGENT_DIR: f.agentDir }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture broker did not start")), 3000);
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture broker exited ${code}`)); });
      child.stdout!.on("data", chunk => { if (String(chunk).includes("fixture-ready")) { clearTimeout(timer); resolve(); } });
    });
    return await work();
  } finally { await stopTestBroker(child); }
}
function readyIntercomDeclarations(f: ReturnType<typeof fixture>): void {
  readyExecutables(f);
  const sdk = join(f.npmPrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
  unlinkSync(sdk); symlinkSync(join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"), sdk);
  const scripts = join(f.releaseRoot, "scripts"), extensions = join(f.agentDir, "extensions");
  mkdirSync(scripts, { mode: 0o700 }); mkdirSync(extensions, { mode: 0o700 });
  copyFileSync(join(process.cwd(), "scripts", "extension-shim.mjs"), join(scripts, "extension-shim.mjs"));
  copyFileSync(join(process.cwd(), "scripts", "intercom-switchover.mjs"), join(scripts, "intercom-switchover.mjs"));
  writeFileSync(join(extensions, "spider.ts"), extensionShim(join(f.releaseRoot, "dist", "extension.js")), { mode: 0o600 });
  writeFileSync(join(f.releaseRoot, "package.json"), JSON.stringify({ name: "@guru-irl/spider", type: "module", pi: { extensions: ["./dist/extension.js"] } }), { mode: 0o600 });
  writeFileSync(join(f.agentDir, "settings.json"), "{}", { mode: 0o600 });
}

it.each([
  ["settings-unique", "intercomUnique"], ["legacy broker drained", "legacyDrained"], ["federation-v1", "federation"],
] as const)("proves %s through real remote verification", async (_label, key) => {
  const f = fixture(true); readyIntercomDeclarations(f);
  await withReadinessBroker(f, ["intercom-exchange-v1", "federation-v1"], async () => {
    const result = await create!(f.options).verifyPeer();
    expect(result[key]).toBe(true);
  });
}, 5000);

it.each([
  ["legacy declaration", "intercomUnique", "settings", "legacy-extension-declared"],
  ["pending legacy ask", "legacyDrained", "legacy", "legacy-pending-asks"],
  ["unsafe agent directory", "legacyDrained", "legacy", "intercom-agent-unsafe"],
  ["unsafe broker socket", "legacyDrained", "legacy", "intercom-socket-unsafe"],
  ["missing federation flag", "federation", "federation", "federation-feature-missing"],
] as const)("keeps %s unready with its named reason", async (scenario, key, evidence, reason) => {
  const f = fixture(true); readyIntercomDeclarations(f);
  if (scenario === "legacy declaration") writeFileSync(join(f.agentDir, "settings.json"), '{"packages":["npm:pi-intercom"]}', { mode: 0o600 });
  if (scenario === "pending legacy ask") {
    mkdirSync(join(f.agentDir, "intercom"), { mode: 0o700 });
    mkdirSync(join(f.agentDir, "intercom", "pending-asks"), { mode: 0o700 });
    writeFileSync(join(f.agentDir, "intercom", "pending-asks", "ask.json"), "{}", { mode: 0o600 });
  }
  await withReadinessBroker(f, scenario === "missing federation flag" ? ["intercom-exchange-v1"] : ["intercom-exchange-v1", "federation-v1"], async () => {
    if (scenario === "unsafe agent directory") chmodSync(f.agentDir, 0o777);
    if (scenario === "unsafe broker socket") chmodSync(join(f.agentDir, "intercom", "broker.sock"), 0o666);
    const result = await create!(f.options).verifyPeer();
    expect(result[key]).toBe(false);
    expect(result).toMatchObject({ intercomEvidence: { [evidence]: reason } });
  });
}, 5000);

it("starts the real Spider broker on a fresh box and then proves broker health", async () => {
  const f = fixture(true); readyIntercomDeclarations(f);
  await create!(f.options).enroll(f.peer, "00000000-0000-4000-8000-000000000001", "herdr-core.service");
  writeFileSync(join(f.globalRoot, "roam", "active-release.json"), JSON.stringify(f.releaseRoot), { mode: 0o600 });
  vi.stubEnv("HOME", f.home); vi.stubEnv("SPIDER_GLOBAL_ROOT", f.globalRoot); vi.stubEnv("PI_CODING_AGENT_DIR", f.agentDir);
  const out: string[] = [], err: string[] = [];
  const { main } = await import("../cli");
  let pid: number | undefined;
  try {
    expect(existsSync(join(f.agentDir, "intercom", "broker.sock"))).toBe(false);
    expect(await main(["--global-root", f.globalRoot, "roam", "intercom", "start-broker"], { out: text => out.push(text), err: text => err.push(text) })).toBe(0);
    const reply = JSON.parse(out.join(""));
    expect(reply).toMatchObject({ version: 1, kind: "intercom-broker-start", ok: true, machineId: f.peer.machineId,
      doctor: { enabled: false, diagnostics: expect.any(Array), consumers: expect.any(Array) } });
    expect(reply.doctor.diagnostics.filter((row: { severity: string; reason: string }) => row.severity === "block" && /^intercom-/.test(row.reason))).toEqual([]);
    pid = Number(readFileSync(join(f.agentDir, "intercom", "broker.pid"), "utf8"));
    expect(Number.isSafeInteger(pid) && pid! > 1).toBe(true);
    expect(await create!(f.options).verifyPeer()).toMatchObject({ intercomUnique: true, legacyDrained: true, federation: true });
    out.length = 0;
    expect(await main(["--global-root", f.globalRoot, "roam", "intercom", "start-broker"], { out: text => out.push(text), err: text => err.push(text) })).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ ok: true, machineId: f.peer.machineId, doctor: { diagnostics: expect.any(Array) } });
    expect(Number(readFileSync(join(f.agentDir, "intercom", "broker.pid"), "utf8"))).toBe(pid);
  } finally { if (pid) try { process.kill(pid, "SIGTERM"); } catch { /* Fixture process already exited. */ } vi.unstubAllEnvs(); }
}, 5000);

it("proves all three intercom checks against the real compiled Spider broker", async () => {
  const f = fixture(true); readyIntercomDeclarations(f);
  const child = startTestBroker(process.execPath, [join(process.cwd(), "dist", "intercom", "broker.mjs")],
    { env: { ...process.env, HOME: f.home, PI_CODING_AGENT_DIR: f.agentDir }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("real fixture broker did not start")), 3000);
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`real fixture broker exited ${code}`)); });
      child.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); resolve(); } });
    });
    expect(await create!(f.options).verifyPeer()).toMatchObject({ intercomUnique: true, legacyDrained: true, federation: true,
      intercomEvidence: { settings: "settings-unique", legacy: "legacy-drained-private-agent", federation: "federation-v1", otherExtensions: [] } });
  } finally { await stopTestBroker(child); }
}, 5000);

it("rejects two enabled Spider extension declarations", async () => {
  const f = fixture(true); readyIntercomDeclarations(f);
  writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ packages: [f.releaseRoot] }), { mode: 0o600 });
  await withReadinessBroker(f, ["federation-v1"], async () => {
    expect(await create!(f.options).verifyPeer()).toMatchObject({ intercomUnique: false, intercomEvidence: { settings: "settings-spider-duplicate" } });
  });
}, 5000);

it("detects a legacy package by its installed manifest even under a different directory name", async () => {
  const f = fixture(true); readyIntercomDeclarations(f);
  const legacy = join(f.agentDir, "other-name"); mkdirSync(legacy, { mode: 0o700 });
  writeFileSync(join(legacy, "package.json"), JSON.stringify({ name: "pi-intercom", pi: { extensions: ["./index.js"] } }), { mode: 0o600 });
  writeFileSync(join(legacy, "index.js"), "export default () => {};", { mode: 0o600 });
  writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ packages: ["./other-name"] }), { mode: 0o600 });
  await withReadinessBroker(f, ["federation-v1"], async () => {
    expect(await create!(f.options).verifyPeer()).toMatchObject({ intercomUnique: false, intercomEvidence: { settings: "legacy-extension-declared" } });
  });
}, 5000);

it("blocks a declared scoped pi-intercom package even when it is not installed", async () => {
  const f = fixture(true); readyIntercomDeclarations(f);
  writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@someone/pi-intercom@1.2.3"] }), { mode: 0o600 });
  await withReadinessBroker(f, ["federation-v1"], async () => {
    expect(await create!(f.options).verifyPeer()).toMatchObject({ intercomUnique: false, intercomEvidence: { settings: "legacy-extension-declared" } });
  });
}, 5000);

it("allows an unrelated extension but lists it as unclassified", async () => {
  const f = fixture(true); readyIntercomDeclarations(f);
  const other = join(f.agentDir, "ordinary-extension"); mkdirSync(other, { mode: 0o700 });
  writeFileSync(join(other, "package.json"), JSON.stringify({ name: "ordinary-extension", pi: { extensions: ["./index.js"] } }), { mode: 0o600 });
  writeFileSync(join(other, "index.js"), "export default () => {};", { mode: 0o600 });
  writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ packages: ["./ordinary-extension"] }), { mode: 0o600 });
  await withReadinessBroker(f, ["federation-v1"], async () => {
    expect(await create!(f.options).verifyPeer()).toMatchObject({ intercomUnique: true,
      intercomEvidence: { settings: "settings-unique", otherExtensions: ["ordinary-extension"] } });
  });
}, 5000);

it("does not trust federation claims from a non-Spider health response", async () => {
  const f = fixture(true); readyIntercomDeclarations(f);
  await withReadinessBroker(f, ["federation-v1"], async () => {
    expect(await create!(f.options).verifyPeer()).toMatchObject({ legacyDrained: false, federation: false,
      intercomEvidence: { legacy: "intercom-broker-not-spider", federation: "intercom-broker-not-spider" } });
  }, "legacy");
}, 5000);

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

it("explicit authenticated provisioning toggles only the enrolled hub's box flag", async () => {
  const f = fixture(), adapter = create!(f.options), hub = "00000000-0000-4000-8000-000000000001", file = join(f.globalRoot, "roam", "config.json");
  await expect(adapter.setEnabled(f.peer, hub, true)).rejects.toThrow();
  expect(existsSync(file)).toBe(false);
  await adapter.enroll(f.peer, hub, "herdr-core.service");
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
  const before = readFileSync(file, "utf8");
  await expect(adapter.setEnabled(f.peer, "00000000-0000-4000-8000-000000000009", true)).rejects.toThrow();
  expect(readFileSync(file, "utf8")).toBe(before);
  await adapter.setEnabled(f.peer, hub, true);
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(true);
  await adapter.setEnabled(f.peer, hub, false);
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
}, 5000);
