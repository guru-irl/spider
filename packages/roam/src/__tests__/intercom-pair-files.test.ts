import { paths } from "@spider/db-core";
import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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
