import { afterEach, expect, it } from "vitest";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROVISION_REMOTE_SCRIPT } from "../provision-remote-script";

const roots: string[] = [];
function fixture() {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "prefix-modes-")); roots.push(root);
  const home = join(root, "home"), globalRoot = join(home, "global"), parent = join(home, "install"), npmPrefix = join(parent, "prefix");
  const agentDir = join(home, "agent"), unitDir = join(home, "units"), roam = join(globalRoot, "roam"), bin = join(npmPrefix, "bin");
  for (const path of [home, globalRoot, parent, npmPrefix, agentDir, unitDir, roam, bin]) mkdirSync(path, { mode: 0o700 });
  const machineId = "11111111-1111-4111-8111-111111111111", sha256 = "a".repeat(64), core = join(home, "core");
  writeFileSync(join(roam, "machine.json"), JSON.stringify({ version: 1, machineId, label: "box-1.invalid" }), { mode: 0o600 });
  writeFileSync(core, `#!${process.execPath}\nconsole.log(JSON.stringify({core:{id:'fixture-core'},pid:4321,version:'0.1.16'}));\n`, { mode: 0o700 });
  const release = join(npmPrefix, "spider-releases", sha256, "node_modules", "@guru-irl", "spider");
  const request = { action: "release-prepare", home, globalRoot, agentDir, npmPrefix, unitDir, machineId, operationId: "op-1", maximum: 1024,
    chunkBytes: 32, core, coreId: "fixture-core", node: process.execPath, pi: join(bin, "pi"), cli: join(release, "dist/roam/cli.mjs"),
    supervisor: join(release, "dist/roam/supervisor.mjs"), sha256, piVersion: "1.2.0", timeout: 1000,
    chunks: [{ name: "release-" + "b".repeat(32) + "-0", size: 1, sha256: "c".repeat(64) }] };
  return { home, parent, npmPrefix, bin, request, receipt: join(roam, "provision/op-1/release-request"),
    run(prelude = "") {
      const child = spawnSync(process.execPath, ["--input-type=module-typescript", "-e", prelude + PROVISION_REMOTE_SCRIPT], {
        input: JSON.stringify(request), encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 4000,
      });
      expect(child.status, child.stderr).toBe(0); return JSON.parse(child.stdout);
    } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("accepts a same-owner 0775 bin protected by a 0700 prefix without chmod", () => {
  const f = fixture(); chmodSync(f.bin, 0o775);
  expect(f.run()).toEqual({ kind: "provision", version: 1, value: true });
  expect(lstatSync(f.bin).mode & 0o7777).toBe(0o775); expect(existsSync(f.receipt)).toBe(true);
  expect(f.run()).toEqual({ kind: "provision", version: 1, value: true });
});

it("accepts a protected group-writable executable without modifying its bytes or mode", () => {
  const f = fixture(), file = f.request.pi; chmodSync(f.bin, 0o775);
  writeFileSync(file, "retained executable", { mode: 0o700 }); chmodSync(file, 0o775);
  expect(f.run()).toEqual({ kind: "provision", version: 1, value: true });
  expect(lstatSync(file).mode & 0o7777).toBe(0o775); expect(readFileSync(file, "utf8")).toBe("retained executable");
});

it("refuses a writable shared parent even when the prefix is private, and chmod advice resolves it", () => {
  const f = fixture(); chmodSync(f.parent, 0o775);
  expect(f.run()).toMatchObject({ error: "unsafe-destination", details: { path: f.parent, mode: 0o775, uid: process.getuid!(), problem: "writable-parent" } });
  expect(lstatSync(f.parent).mode & 0o7777).toBe(0o775); expect(existsSync(f.receipt)).toBe(false);
  chmodSync(f.parent, 0o755); expect(f.run()).toMatchObject({ value: true });
});

it("refuses an injected foreign owner beneath a private prefix with path and metadata", () => {
  const f = fixture(), uid = process.getuid!() + 1; chmodSync(f.bin, 0o775);
  const prelude = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.lstatSync; fs.lstatSync=(file,...args)=>{const s=original(file,...args); if(file===${JSON.stringify(f.bin)}) Object.defineProperty(s,'uid',{value:${uid}}); return s;}; syncBuiltinESMExports();\n`;
  expect(f.run(prelude)).toMatchObject({ error: "unsafe-destination", details: { path: f.bin, mode: 0o775, uid, problem: "owner" } });
  expect(lstatSync(f.bin).mode & 0o7777).toBe(0o775); expect(existsSync(f.receipt)).toBe(false);
});

it("does not treat a later private directory as protection for a writable prefix", () => {
  const f = fixture(); chmodSync(f.npmPrefix, 0o775);
  expect(f.run()).toMatchObject({ error: "unsafe-destination", details: { path: f.npmPrefix, mode: 0o775, uid: process.getuid!(), problem: "writable-parent" } });
  expect(existsSync(f.receipt)).toBe(false);
});

it("accepts protection beginning below a safe non-private prefix", () => {
  const f = fixture(); chmodSync(f.npmPrefix, 0o755);
  writeFileSync(f.request.pi, "retained", { mode: 0o700 }); chmodSync(f.request.pi, 0o775);
  expect(f.run()).toMatchObject({ value: true }); expect(lstatSync(f.request.pi).mode & 0o7777).toBe(0o775);
});

it("refuses a group-writable executable without a private install ancestor", () => {
  const f = fixture(); chmodSync(f.npmPrefix, 0o755); chmodSync(f.bin, 0o755);
  writeFileSync(f.request.pi, "retained", { mode: 0o700 }); chmodSync(f.request.pi, 0o775);
  expect(f.run()).toMatchObject({ error: "unsafe-destination", details: { path: f.request.pi, mode: 0o775, uid: process.getuid!(), problem: "writable-parent" } });
  expect(readFileSync(f.request.pi, "utf8")).toBe("retained"); expect(existsSync(f.receipt)).toBe(false);
});

it("accepts protected runtime package files but still refuses hard links inside them", () => {
  const f = fixture(), runtime = join(f.npmPrefix, "lib/node_modules/@earendil-works/pi-coding-agent"), file = join(runtime, "cli.js");
  mkdirSync(runtime, { recursive: true, mode: 0o700 }); chmodSync(runtime, 0o775);
  writeFileSync(file, "retained runtime", { mode: 0o700 }); chmodSync(file, 0o775);
  symlinkSync("../lib/node_modules/@earendil-works/pi-coding-agent/cli.js", f.request.pi);
  expect(f.run()).toMatchObject({ value: true }); expect(lstatSync(file).mode & 0o7777).toBe(0o775);
  linkSync(file, join(f.home, "external-alias"));
  expect(f.run()).toMatchObject({ error: "unsafe-destination", details: { path: file, mode: 0o775, uid: process.getuid!(), problem: "hard-link" } });
  expect(readFileSync(file, "utf8")).toBe("retained runtime");
});

it.each(["hard-link", "symlink"] as const)("refuses an executable %s escaping private protection", kind => {
  const f = fixture(), outside = join(f.home, "outside"); writeFileSync(outside, "retained", { mode: 0o600 }); chmodSync(outside, 0o775);
  if (kind === "hard-link") linkSync(outside, f.request.pi); else symlinkSync(outside, f.request.pi);
  expect(f.run()).toMatchObject({ error: "unsafe-destination", details: { path: f.request.pi, mode: lstatSync(f.request.pi).mode & 0o7777, uid: process.getuid!(), problem: kind } });
  expect(lstatSync(outside).mode & 0o7777).toBe(0o775); expect(readFileSync(outside, "utf8")).toBe("retained");
  expect(existsSync(f.receipt)).toBe(false);
});
