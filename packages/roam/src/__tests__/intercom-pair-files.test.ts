import { paths } from "@spider/db-core";
import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IntercomEnrollmentPair } from "../provision-contracts";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const key = (n: number) => {
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, n)]);
  return { type: "ssh-ed25519", base64: bytes.toString("base64") };
};
function fixture() {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "pair-files-")); roots.push(root);
  const global = join(root, "global"), targetGlobal = join(root, "target-global"), home = join(root, "home");
  mkdirSync(global, { mode: 0o700 }); mkdirSync(targetGlobal, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 });
  const peer = (machineId: string, alias: string, globalRoot: string) => ({ machineId, alias, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot });
  const pair: IntercomEnrollmentPair = { pairId: "pair-1", edgeEpoch: "edge-1", source: peer(A, "box-1.invalid", global), target: peer(B, "box-2.invalid", targetGlobal),
    sshUser: "fixture", hostKey: key(7), hostKeyAlias: `spider-${"a".repeat(32)}`, connector: { tunnelId: "tunnel", remotePort: 22, session: "default" } };
  return { root, global, home, pair };
}
async function api() {
  return await import("../intercom-pair-files").catch(() => ({})) as typeof import("../intercom-pair-files");
}

it("creates one private key per pair using an argv-only fake generator and converges on retry", async () => {
  const f = fixture(), mod = await api(); expect(mod.ensurePairKey).toBeTypeOf("function");
  const calls: string[][] = [], pub = key(8);
  const run = async (_binary: string, args: readonly string[]) => {
    calls.push([...args]); const file = args[args.indexOf("-f") + 1];
    writeFileSync(file, "fixture-private", { mode: 0o600 }); writeFileSync(`${file}.pub`, `${pub.type} ${pub.base64} comment\n`, { mode: 0o644 });
    return { code: 0, stdout: "" };
  };
  const first = await mod.ensurePairKey(f.pair, { binary: "/fixture/keygen", run });
  const second = await mod.ensurePairKey(f.pair, { binary: "/fixture/keygen", run });
  expect(first).toEqual({ publicKey: `${pub.type} ${pub.base64}`, privateMode: 0o600, privateOwned: true }); expect(second).toEqual(first);
  expect(calls).toHaveLength(1); expect(calls[0]).toContain("ed25519"); expect(calls[0]).toContain("-f");
  expect(lstatSync(mod.pairPaths(f.pair).privateKey).mode & 0o777).toBe(0o600);
}, 5000);

it("pins the observed host key and the via process uses strict, isolated SSH argv", async () => {
  const f = fixture(), mod = await api(); expect(mod.writePairRoute).toBeTypeOf("function");
  const ssh = join(f.root, "fake-ssh"), output = join(f.root, "ssh-argv.json");
  writeFileSync(ssh, `#!${process.execPath}\nimport('node:fs').then(fs => fs.writeFileSync(process.env.TEST_PAIR_ARGV, JSON.stringify(process.argv.slice(2))));\n`, { mode: 0o700 });
  const route = mod.writePairRoute(f.pair, { node: process.execPath, ssh, localPort: 23222 });
  expect(readFileSync(route.knownHosts, "utf8")).toBe(`${f.pair.hostKeyAlias} ${f.pair.hostKey.type} ${f.pair.hostKey.base64}\n`);
  expect(lstatSync(route.knownHosts).mode & 0o777).toBe(0o600); expect(lstatSync(route.via).mode & 0o777).toBe(0o700);
  expect(mod.writePairRoute(f.pair, { node: process.execPath, ssh, localPort: 23222 })).toEqual(route);
  execFileSync(route.via, ["fixture remote command"], { env: { ...process.env, TEST_PAIR_ARGV: output }, timeout: 2000 });
  const argv: string[] = JSON.parse(readFileSync(output, "utf8"));
  for (const option of ["IdentitiesOnly=yes", "StrictHostKeyChecking=yes", `HostKeyAlias=${f.pair.hostKeyAlias}`,
    `UserKnownHostsFile=${route.knownHosts}`, "ControlMaster=no", "ControlPath=none"]) expect(argv).toContain(option);
  expect(argv.slice(0, 2)).toEqual(["-F", "/dev/null"]);
  expect(argv).toContain(route.privateKey); expect(argv).toContain("23222"); expect(argv).toContain("fixture@127.0.0.1");
  expect(argv.at(-1)).toBe(`spider-intercom:pair-1:edge-1:${Buffer.from("fixture remote command").toString("base64")}`);
  expect(argv.at(-1)).toBe(mod.encodePairCommand(f.pair, "fixture remote command"));
  expect(Buffer.from(argv.at(-1)!.split(":").at(-1)!, "base64").toString("utf8")).toBe("fixture remote command");
  expect(() => mod.writePairRoute({ ...f.pair, hostKey: key(9) }, { node: process.execPath, ssh, localPort: 23222 })).toThrow("host-key-changed");
  expect(readFileSync(route.knownHosts, "utf8")).toContain(f.pair.hostKey.base64);
}, 5000);

it("authorizes and removes only the exact restricted pair key while preserving other keys", async () => {
  const f = fixture(), mod = await api(); expect(mod.authorizePairKey).toBeTypeOf("function");
  const dir = join(f.home, ".ssh"), file = join(dir, "authorized_keys"); mkdirSync(dir, { mode: 0o700 });
  const unrelated = `ssh-ed25519 ${key(3).base64} other\n`; writeFileSync(file, unrelated, { mode: 0o600 });
  const pub = `${key(4).type} ${key(4).base64}`;
  await mod.authorizePairKey(f.home, f.pair, pub); await mod.authorizePairKey(f.home, f.pair, pub);
  const line = mod.authorizedPairLine(f.pair, pub);
  expect(line).toMatch(/^from="127\.0\.0\.1",restrict,command="/);
  expect(readFileSync(file, "utf8")).toBe(`${unrelated}${line}\n`);
  await mod.removePairKey(f.home, f.pair, pub); await mod.removePairKey(f.home, f.pair, pub);
  expect(readFileSync(file, "utf8")).toBe(unrelated); expect(lstatSync(file).mode & 0o777).toBe(0o600);
}, 5000);

it.each(["directory absent", "file absent", "unrelated key"] as const)("proves an unrecorded pair key absent with %s", async state => {
  const f = fixture(), mod = await api(), directory = join(f.home, ".ssh"), file = join(directory, "authorized_keys");
  const unrelated = `ssh-ed25519 ${key(3).base64} spider-intercom:pair-10\n`;
  if (state !== "directory absent") mkdirSync(directory, { mode: 0o700 });
  if (state === "unrelated key") writeFileSync(file, unrelated, { mode: 0o600 });
  expect(mod.pairKeyAbsent(f.home, f.pair, null)).toBe(true);
  expect(mod.pairKeyAbsent(f.home, f.pair, null)).toBe(true);
  expect(existsSync(directory)).toBe(state !== "directory absent");
  expect(existsSync(file)).toBe(state === "unrelated key");
  if (state === "unrelated key") expect(readFileSync(file, "utf8")).toBe(unrelated);
});

it("validates pair identity before proving an unrecorded key absent", async () => {
  const f = fixture(), mod = await api();
  expect(() => mod.pairKeyAbsent(f.home, { ...f.pair, pairId: "../other" }, null)).toThrow("invalid-intercom-pair");
});

it.each(["restricted", "unexpected", "trailing whitespace", "extra comment"] as const)("refuses an unrecorded pair key when a %s pair authorization remains", async shape => {
  const f = fixture(), mod = await api(), directory = join(f.home, ".ssh"), file = join(directory, "authorized_keys");
  mkdirSync(directory, { mode: 0o700 });
  const pub = `ssh-ed25519 ${key(4).base64}`;
  const suffix = shape === "trailing whitespace" ? " \t" : shape === "extra comment" ? " retained" : "";
  const contents = `${shape === "restricted" ? mod.authorizedPairLine(f.pair, pub) : `${pub} spider-intercom:pair-1${suffix}`}\n`;
  writeFileSync(file, contents, { mode: 0o600 });
  expect(() => mod.pairKeyAbsent(f.home, f.pair, null)).toThrow("intercom-authorized-key-conflict");
  expect(readFileSync(file, "utf8")).toBe(contents);
});

it.each(["directory mode", "file mode", "symlink"] as const)("refuses unrecorded key absence with unsafe %s", async failure => {
  const f = fixture(), mod = await api(), directory = join(f.home, ".ssh"), file = join(directory, "authorized_keys");
  mkdirSync(directory, { mode: 0o700 });
  const contents = `ssh-ed25519 ${key(3).base64} other\n`;
  if (failure === "symlink") {
    const outside = join(f.root, "other-keys"); writeFileSync(outside, contents, { mode: 0o600 }); symlinkSync(outside, file);
  } else {
    writeFileSync(file, contents, { mode: 0o600 });
    chmodSync(failure === "directory mode" ? directory : file, failure === "directory mode" ? 0o755 : 0o644);
  }
  expect(() => mod.pairKeyAbsent(f.home, f.pair, null)).toThrow();
  expect(readFileSync(file, "utf8")).toBe(contents);
});

it("refuses symlinked or unsafe key destinations without modifying their targets", async () => {
  const f = fixture(), mod = await api(); expect(mod.authorizePairKey).toBeTypeOf("function");
  const dir = join(f.home, ".ssh"), outside = join(f.root, "other-keys"); mkdirSync(dir, { mode: 0o700 });
  writeFileSync(outside, "untouched\n", { mode: 0o600 }); symlinkSync(outside, join(dir, "authorized_keys"));
  await expect(mod.authorizePairKey(f.home, f.pair, `${key(4).type} ${key(4).base64}`)).rejects.toThrow();
  expect(readFileSync(outside, "utf8")).toBe("untouched\n");
  rmSync(join(dir, "authorized_keys")); writeFileSync(join(dir, "authorized_keys"), "untouched\n", { mode: 0o644 });
  await expect(mod.authorizePairKey(f.home, f.pair, `${key(4).type} ${key(4).base64}`)).rejects.toThrow();
  expect(readFileSync(join(dir, "authorized_keys"), "utf8")).toBe("untouched\n");
}, 5000);

it("binds a pair key's forced command to its own pair and epoch and refuses a revoked registration", async () => {
  const f = fixture(), mod = await api(); f.pair.target.node = process.execPath;
  const { createIntercomRegistry } = await import("../intercom-registry");
  const registry = createIntercomRegistry(f.pair.target.globalRoot);
  await registry.register(f.pair, "approval", "a".repeat(64)); await registry.bind(f.pair, "approval");
  const pub = `${key(4).type} ${key(4).base64}`;
  await mod.authorizePairKey(f.home, f.pair, pub);
  const line = readFileSync(join(f.home, ".ssh", "authorized_keys"), "utf8");
  expect(line).toMatch(/restrict,command="/);
  const gate = join(f.pair.target.globalRoot, "roam", "intercom", "pairs", f.pair.pairId, f.pair.edgeEpoch, "command.mjs");
  const env = (pair = f.pair.pairId, epoch = f.pair.edgeEpoch) => ({ ...process.env, SSH_ORIGINAL_COMMAND: `spider-intercom:${pair}:${epoch}:${Buffer.from("printf pair-ok").toString("base64")}` });
  expect(execFileSync(process.execPath, [gate], { env: env(), timeout: 2000, encoding: "utf8" })).toBe("pair-ok");
  expect(() => execFileSync(process.execPath, [gate], { env: env("other-pair"), timeout: 2000 })).toThrow();
  expect(() => execFileSync(process.execPath, [gate], { env: env("xxxxxx"), timeout: 2000 })).toThrow();
  expect(() => execFileSync(process.execPath, [gate], { env: env(f.pair.pairId, "other-epoch"), timeout: 2000 })).toThrow();
  await registry.beginRevocation(f.pair.pairId, "00000000-0000-4000-8000-000000000009");
  expect(() => execFileSync(process.execPath, [gate], { env: env(), timeout: 2000 })).toThrow();
}, 5000);

it("requires exact fresh consent before a pending inherited fence permits command access", async () => {
  const f = fixture(), mod = await api(); f.pair.target.node = process.execPath;
  const { createIntercomRegistry } = await import("../intercom-registry");
  const registry = createIntercomRegistry(f.pair.target.globalRoot), fenceId = "00000000-0000-4000-8000-000000000009";
  await registry.register(f.pair, "approval-1", "a".repeat(64)); await registry.bind(f.pair, "approval-1");
  await registry.beginRevocation("pair-1", fenceId); await registry.finishRevocation("pair-1", null);
  const fresh = { ...f.pair, edgeEpoch: "edge-2" };
  await registry.register(fresh, "approval-2", "b".repeat(64)); await registry.bind(fresh, "approval-2");
  await mod.authorizePairKey(f.home, fresh, `${key(4).type} ${key(4).base64}`);
  const gate = join(fresh.target.globalRoot, "roam", "intercom", "pairs", fresh.pairId, fresh.edgeEpoch, "command.mjs");
  const execute = () => execFileSync(process.execPath, [gate], { env: { ...process.env, SSH_ORIGINAL_COMMAND: mod.encodePairCommand(fresh, "printf command-ok") }, timeout: 2000, encoding: "utf8" });
  const approval = { operationId: "approval-2", graphDigest: "b".repeat(64), edgeEpoch: "edge-2", expectedFenceId: fenceId };
  for (const mismatch of [{ operationId: "approval-1" }, { graphDigest: "a".repeat(64) }, { edgeEpoch: "edge-1" },
    { expectedFenceId: "00000000-0000-4000-8000-000000000008" }]) {
    await expect(registry.approveCommands("pair-1", { ...approval, ...mismatch })).rejects.toThrow("fresh-peer-consent-required");
    expect(execute).toThrow();
  }
  await registry.approveCommands("pair-1", approval);
  expect(execute()).toBe("command-ok");
  expect(await registry.fences([fresh])).toEqual({ "pair-1": fenceId });
}, 5000);

it.each([{}, { fenceId: "", commandApprovalFenceId: "" }, { fenceId: 7, commandApprovalFenceId: 7 }])(
  "refuses malformed pending fence approval %j", async fields => {
    const f = fixture(), mod = await api(); f.pair.target.node = process.execPath;
    const { createIntercomRegistry } = await import("../intercom-registry");
    const registry = createIntercomRegistry(f.pair.target.globalRoot);
    await registry.register(f.pair, "approval-1", "a".repeat(64)); await registry.bind(f.pair, "approval-1");
    await mod.authorizePairKey(f.home, f.pair, `${key(4).type} ${key(4).base64}`);
    const file = join(f.pair.target.globalRoot, "roam", "intercom", "enrollments", "pair-1.json");
    const record = JSON.parse(readFileSync(file, "utf8")); delete record.fenceId; delete record.commandApprovalFenceId;
    writeFileSync(file, JSON.stringify({ ...record, ...fields }), { mode: 0o600 });
    const gate = join(f.pair.target.globalRoot, "roam", "intercom", "pairs", "pair-1", "edge-1", "command.mjs");
    const result = spawnSync(process.execPath, [gate], { env: { ...process.env, SSH_ORIGINAL_COMMAND: mod.encodePairCommand(f.pair, "printf forbidden") }, timeout: 2000, encoding: "utf8" });
    expect(result.status).toBe(126);
    expect(result.stdout).toBe("");
  }, 5000);

it("cleans abandoned command upgrades on authorization without changing installed access", async () => {
  const f = fixture(), mod = await api(); f.pair.target.node = process.execPath;
  const pub = `${key(4).type} ${key(4).base64}`;
  await mod.authorizePairKey(f.home, f.pair, pub);
  const directory = join(f.pair.target.globalRoot, "roam", "intercom", "pairs", "pair-1", "edge-1");
  const abandoned = [".command.00000000-0000-4000-8000-000000000008.new", ".command.00000000-0000-4000-8000-000000000009.new.part"];
  for (const name of abandoned) writeFileSync(join(directory, name), "partial", { mode: 0o600 });
  const unrelated = join(directory, ".command.keep.new"); writeFileSync(unrelated, "keep", { mode: 0o600 });
  const gate = join(directory, "command.mjs"), keys = join(f.home, ".ssh", "authorized_keys");
  const commandBefore = readFileSync(gate), keysBefore = readFileSync(keys);
  await mod.authorizePairKey(f.home, f.pair, pub);
  for (const name of abandoned) expect(existsSync(join(directory, name))).toBe(false);
  expect(readFileSync(unrelated, "utf8")).toBe("keep");
  expect(readFileSync(gate)).toEqual(commandBefore);
  expect(readFileSync(keys)).toEqual(keysBefore);
}, 5000);

it("refuses an unrecognized command artifact without replacing it or changing authorized keys", async () => {
  const f = fixture(), mod = await api(); f.pair.target.node = process.execPath;
  const pub = `${key(4).type} ${key(4).base64}`;
  await mod.authorizePairKey(f.home, f.pair, pub);
  const gate = join(f.pair.target.globalRoot, "roam", "intercom", "pairs", f.pair.pairId, f.pair.edgeEpoch, "command.mjs");
  const file = join(f.home, ".ssh", "authorized_keys"), before = readFileSync(file);
  writeFileSync(gate, "process.exitCode = 126;\n", { mode: 0o600 });
  await expect(mod.authorizePairKey(f.home, f.pair, pub)).rejects.toThrow();
  expect(readFileSync(gate, "utf8")).toBe("process.exitCode = 126;\n");
  expect(readFileSync(file)).toEqual(before);
}, 5000);
