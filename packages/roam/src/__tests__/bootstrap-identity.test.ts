import { afterEach, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as bootstrap from "../bootstrap-script";

const roots: string[] = [];
const machineId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const source = (bootstrap as typeof bootstrap & { BOOTSTRAP_IDENTITY_SCRIPT?: string }).BOOTSTRAP_IDENTITY_SCRIPT;

function fixture(coreId = "core-1") {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "bootstrap-identity-")); roots.push(root);
  const home = join(root, "home"), agent = join(home, ".pi", "agent"), globalRoot = join(agent, "spider");
  mkdirSync(agent, { recursive: true, mode: 0o700 });
  const hc = join(home, "fake-hc");
  writeFileSync(hc, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({version:'0.1.16',core:{id:${JSON.stringify(coreId)},privateNote:'fixture-secret'}}));\n`, { mode: 0o700 });
  const request = { globalRoot, machineId, core: hc, coreId: "core-1", operationId: "op-1" };
  function run(input: unknown = request) {
    const child = spawnSync(process.execPath, ["--input-type=module-typescript", "-e", source!], {
      input: JSON.stringify(input), encoding: "utf8", timeout: 3000,
      env: { ...process.env, HOME: home, SPIDER_GLOBAL_ROOT: globalRoot },
    });
    expect(child.status).toBe(0);
    expect(child.stderr).not.toContain("fixture-secret");
    return JSON.parse(child.stdout) as Record<string, unknown>;
  }
  return { root, home, agent, globalRoot, request, run };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("refuses identity publication without a valid operation ID", () => {
  expect(source).toBeTypeOf("string");
  const f = fixture(), { operationId: _operationId, ...missing } = f.request;
  expect(f.run(missing)).toEqual({ version: 1, kind: "identity", error: "invalid-request" });
  expect(existsSync(f.globalRoot)).toBe(false);
}, 5000);

it("creates the requested identity once and returns the verified core ID", () => {
  expect(source).toBeTypeOf("string");
  const f = fixture(), expected = { version: 1, kind: "identity", coreId: "core-1", machineId };
  expect(f.run()).toEqual(expected);
  const file = join(f.globalRoot, "roam", "machine.json"), before = readFileSync(file, "utf8");
  expect(f.run()).toEqual(expected);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(JSON.parse(before)).toEqual({ machineId });
  expect(lstatSync(join(f.globalRoot, "roam")).mode & 0o777).toBe(0o700);
  expect(lstatSync(file).mode & 0o777).toBe(0o600);
}, 5000);

it("refuses an existing different identity without replacing it", () => {
  expect(source).toBeTypeOf("string");
  const f = fixture(); mkdirSync(join(f.globalRoot, "roam"), { recursive: true, mode: 0o700 });
  const file = join(f.globalRoot, "roam", "machine.json"), original = JSON.stringify({ machineId: otherId, note: "fixture-secret" });
  writeFileSync(file, original, { mode: 0o600 });
  const reply = f.run();
  expect(reply).toEqual({ version: 1, kind: "identity", error: "machine-mismatch" });
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(JSON.stringify(reply)).not.toContain("fixture-secret");
}, 5000);

it("does not write an identity when the target core differs", () => {
  expect(source).toBeTypeOf("string");
  const f = fixture("replacement-core"), reply = f.run();
  expect(reply).toEqual({ version: 1, kind: "identity", error: "core-changed" });
  expect(existsSync(f.globalRoot)).toBe(false);
}, 5000);

it("refuses a symlinked root or unsafe identity before writing", () => {
  expect(source).toBeTypeOf("string");
  const f = fixture(), outside = join(f.home, "elsewhere"); mkdirSync(outside, { mode: 0o700 });
  symlinkSync(outside, f.globalRoot, "dir");
  expect(f.run()).toEqual({ version: 1, kind: "identity", error: "unsafe-identity" });
  expect(existsSync(join(outside, "roam"))).toBe(false);
  rmSync(f.globalRoot); mkdirSync(join(f.globalRoot, "roam"), { recursive: true, mode: 0o700 });
  const file = join(f.globalRoot, "roam", "machine.json"), original = JSON.stringify({ machineId });
  writeFileSync(file, original, { mode: 0o600 }); chmodSync(file, 0o644);
  expect(f.run()).toEqual({ version: 1, kind: "identity", error: "unsafe-identity" });
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(lstatSync(file).mode & 0o777).toBe(0o644);
}, 5000);

it("refuses a root outside the destination home", () => {
  expect(source).toBeTypeOf("string");
  const f = fixture();
  expect(f.run({ ...f.request, globalRoot: join(f.root, "outside") })).toEqual({ version: 1, kind: "identity", error: "unsafe-identity" });
  expect(existsSync(join(f.root, "outside"))).toBe(false);
}, 5000);
