import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as piSpawn from "../pi-spawn";
import { getPiSpawnCommand } from "../pi-spawn";
import { piRpcCompatibility } from "../pi-version";
import { freshDb } from "./helpers/testutil";

const roots: string[] = [];
let base: string | undefined;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(version = "0.85.0") {
  if (!base) {
    const db = freshDb(); const file = db.raw.name; base = dirname(file); db.close(); rmSync(file, { force: true });
  }
  const root = join(base, `pi-entry-${randomUUID()}`); roots.push(root);
  mkdirSync(join(root, "dist"), { recursive: true });
  const entry = join(root, "dist", "cli.js");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, bin: { pi: "dist/cli.js" } }));
  writeFileSync(entry, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ node: process.execPath, args: process.argv.slice(2), loaded: globalThis.loaded }));\n"); chmodSync(entry, 0o755);
  return { root, entry, packageJson: join(root, "package.json") };
}

it("runs the parent pi entry on the parent runtime even when PATH selects another node", () => {
  const { root, entry } = fixture();
  const bin = join(root, "bin"); mkdirSync(bin);
  const alias = join(bin, "pi"); symlinkSync(entry, alias);
  const wrongNode = join(bin, "node"); writeFileSync(wrongNode, "#!/bin/sh\nexit 88\n"); chmodSync(wrongNode, 0o755);
  const command = getPiSpawnCommand(["hello"], { argv1: alias, env: {} });
  expect(command.command).toBe(process.execPath);
  expect(command.args).toEqual([entry, "hello"]);
  const result = spawnSync(command.command, command.args, { cwd: root, env: { PATH: bin, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") }, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ node: process.execPath, args: ["hello"] });
});

it("keeps the running entry even when the package declares another executable", () => {
  const { entry, packageJson } = fixture();
  writeFileSync(packageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { other: "dist/cli.js" } }));
  const command = getPiSpawnCommand(["hello"], { argv1: entry, env: {} });
  expect(command).toEqual({ command: process.execPath, args: [entry, "hello"], piEntry: entry });
});

it("keeps a source entry inside the pi package rather than a separate build", () => {
  const { root } = fixture();
  mkdirSync(join(root, "src"));
  const entry = join(root, "src", "cli.ts"); writeFileSync(entry, "// source entry\n");
  expect(getPiSpawnCommand(["hello"], { argv1: entry, env: {} })).toEqual({ command: process.execPath, args: [entry, "hello"], piEntry: entry });
});

it("selects compatibility from the pi entry rather than a Node flag", () => {
  const { root, entry } = fixture();
  expect(piRpcCompatibility({ command: process.execPath, args: ["--require", "loader.cjs", entry], piEntry: entry }, root).fallback).toBe(true);
});

it("reads CLI metadata when Node can run a non-executable script", () => {
  const { root, entry } = fixture(); chmodSync(entry, 0o644);
  const command = getPiSpawnCommand(["hello"], { argv1: entry, env: {} });
  expect(command).toEqual({ command: process.execPath, args: [entry, "hello"], piEntry: entry });
  expect(spawnSync(command.command, command.args, { cwd: root, env: { PATH: join(root, "missing"), HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") } }).status).toBe(0);
  expect(piRpcCompatibility(command, root).fallback).toBe(true);
});

it("keeps a custom binary override first and leaves its arguments untouched", () => {
  const { entry } = fixture();
  const command = getPiSpawnCommand(["hello"], { argv1: entry, env: { PI_SUBAGENT_PI_BINARY: "  custom-pi  " }, isSea: () => true });
  expect(command).toEqual({ command: "custom-pi", args: ["hello"] });
  const normal = getPiSpawnCommand(["hello"], { argv1: entry, env: {} });
  expect(normal).toEqual({ command: process.execPath, args: [entry, "hello"], piEntry: entry });
});

it("keeps the published Windows CLI resolver available", () => {
  const { entry } = fixture();
  const resolver = (piSpawn as Record<string, unknown>).resolveWindowsPiCliScript;
  expect(typeof resolver).toBe("function");
  if (typeof resolver === "function") expect(resolver({ argv1: entry })).toBe(entry);
});

it("runs the wrapper entry with the parent Node when PATH selects another pi and Node", () => {
  const { root, entry, packageJson } = fixture();
  mkdirSync(join(root, "dist", "bundle"));
  writeFileSync(join(root, "dist", "bundle", "cli.js"), "throw new Error('wrong entry');\n");
  writeFileSync(packageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/bundle/cli.js" } }));
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 91\n"); chmodSync(join(bin, "pi"), 0o755);
  writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 92\n"); chmodSync(join(bin, "node"), 0o755);
  const command = getPiSpawnCommand(["hello"], { argv1: entry, env: {} });
  expect(command.command).toBe(process.execPath);
  expect(command.args).toEqual([entry, "hello"]);
  const result = spawnSync(command.command, command.args, { cwd: root, env: { PATH: bin, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") }, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ node: process.execPath, args: ["hello"] });
});

it("a running pi parent launches its entry on the same Node without its flags", () => {
  const { root, entry, packageJson } = fixture();
  writeFileSync(packageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", bin: { pi: "dist/other.js" } }));
  const moduleUrl = new URL("../pi-spawn.ts", import.meta.url).href;
  writeFileSync(entry, `import { spawnSync } from 'node:child_process';
import { getPiSpawnCommand } from ${JSON.stringify(moduleUrl)};
if (process.argv[2] === 'child') {
  process.stdout.write(JSON.stringify({ node: process.execPath, loaded: globalThis.loaded ?? false }));
} else {
  const launch = getPiSpawnCommand(['child'], { env: {} });
  if (launch.command !== process.execPath || launch.args.length !== 2 || launch.args[0] !== process.argv[1] || launch.args[1] !== 'child') process.exit(45);
  const result = spawnSync(launch.command, launch.args, { env: process.env, encoding: 'utf8' });
  if (result.status !== 0) process.exit(46);
  process.stdout.write(result.stdout);
}
`);
  const preload = join(root, "preload.mjs"); writeFileSync(preload, "globalThis.loaded = true;\n");
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 91\n"); chmodSync(join(bin, "pi"), 0o755);
  writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 92\n"); chmodSync(join(bin, "node"), 0o755);
  const result = spawnSync(process.execPath, ["--import", preload, "--max-old-space-size=256", entry], {
    cwd: root, env: { HOME: root, PATH: bin, PI_CODING_AGENT_DIR: join(root, "agent") }, encoding: "utf8", timeout: 10000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ node: process.execPath, loaded: false });
});

it.each(["bun", "electron"] as const)("uses PATH for a %s parent", runtime => {
  const { root, entry } = fixture();
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "pi"), "#!/bin/sh\nprintf path-pi\n"); chmodSync(join(bin, "pi"), 0o755);
  Object.defineProperty(process.versions, runtime, { value: "1.0.0", configurable: true });
  try {
    const command = getPiSpawnCommand(["hello"], { argv1: entry, env: {} });
    expect(command).toEqual({ command: "pi", args: ["hello"] });
    const result = spawnSync(command.command, command.args, { cwd: root, env: { PATH: bin, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") }, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("path-pi");
  } finally { delete (process.versions as unknown as Record<string, string>)[runtime]; }
});

it("uses PATH for a single-executable parent", () => {
  const { entry } = fixture();
  const command = getPiSpawnCommand(["hello"], { argv1: entry, env: {}, isSea: () => true });
  expect(command).toEqual({ command: "pi", args: ["hello"] });
});

it("uses PATH when the runtime release is not Node", () => {
  const { entry } = fixture();
  const release = Object.getOwnPropertyDescriptor(process, "release")!;
  Object.defineProperty(process, "release", { value: { name: "other" }, configurable: true });
  try {
    expect(getPiSpawnCommand(["hello"], { argv1: entry, env: {} })).toEqual({ command: "pi", args: ["hello"] });
  } finally { Object.defineProperty(process, "release", release); }
});

it("uses PATH for an SDK host even when another pi package is available", () => {
  const { root } = fixture();
  const host = join(dirname(root), `host-${randomUUID()}.js`); roots.push(host);
  writeFileSync(host, "// host\n");
  const command = getPiSpawnCommand(["hello"], { argv1: host, env: {} });
  expect(command).toEqual({ command: "pi", args: ["hello"] });
});

it("uses PATH when the nearest package belongs to another program", () => {
  const { root } = fixture();
  const nested = join(root, "dist", "nested"); mkdirSync(nested);
  writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "other-package" }));
  const entry = join(nested, "cli.js"); writeFileSync(entry, "// other program\n");
  expect(getPiSpawnCommand(["hello"], { argv1: entry, env: {} })).toEqual({ command: "pi", args: ["hello"] });
});

it("uses PATH when an entry inside pi resolves outside the package", () => {
  const { root } = fixture();
  const other = join(dirname(root), `outside-${randomUUID()}.js`); roots.push(other); writeFileSync(other, "// other program\n");
  const alias = join(root, "dist", "alias.js"); symlinkSync(other, alias);
  expect(getPiSpawnCommand(["hello"], { argv1: alias, env: {} })).toEqual({ command: "pi", args: ["hello"] });
});

it("does not copy the parent's import or heap flags to the child", () => {
  const { root, entry } = fixture();
  const preload = join(root, "preload.mjs"); writeFileSync(preload, "globalThis.loaded = 'yes';\n");
  const previous = process.execArgv;
  process.execArgv = ["--import", preload, "--max-old-space-size=256"];
  try {
    const command = getPiSpawnCommand(["hello"], { argv1: entry, env: {} });
    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual([entry, "hello"]);
    const result = spawnSync(command.command, command.args, { cwd: root, env: { PATH: join(root, "missing"), HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") }, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ node: process.execPath, args: ["hello"] });
  } finally { process.execArgv = previous; }
});

it("runs the installed pi entry with PATH unavailable", () => {
  const { root } = fixture();
  const installed = join(dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")))), "dist", "cli.js");
  const command = getPiSpawnCommand(["--version"], { argv1: installed, env: {} });
  expect(command).toEqual({ command: process.execPath, args: [installed, "--version"], piEntry: installed });
  const result = spawnSync(command.command, command.args, { cwd: root, env: { PATH: join(root, "missing"), HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "agent") }, encoding: "utf8", timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
});

it("uses the parent executable and rejects an unrelated parent script", () => {
  const { root, entry } = fixture();
  const other = join(dirname(root), `other-${randomUUID()}.js`); roots.push(other); writeFileSync(other, "// other program\n");
  const command = getPiSpawnCommand(["hello"], { argv1: entry, execPath: "node.exe", env: {} });
  expect(command).toMatchObject({ command: "node.exe", args: [entry, "hello"] });
  const fallback = getPiSpawnCommand(["hello"], { argv1: other, execPath: "node.exe", env: {} });
  expect(fallback).toEqual({ command: "pi", args: ["hello"] });
});
