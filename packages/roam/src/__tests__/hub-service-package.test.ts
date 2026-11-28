import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { buildRoamEntries } from "../../../../scripts/build-roam.mjs";
import { assertRoamBundle } from "../../../../scripts/check-roam-bundle.mjs";
import roamEntries from "../../../../scripts/roam-entries.json" with { type: "json" };
const entryFiles = Object.keys(roamEntries).map(mode => `${mode}.mjs`);
import { openDb, migrate } from "@spider/db-core";
import { buildViteFixture as build } from "../../../../scripts/test-bundle.js";

let root: string, packageRoot: string;
beforeAll(async () => {
  root = mkdtempSync(join(resolve(".spider/scratch"), "hubp-"));
  packageRoot = join(root, "package"); mkdirSync(packageRoot);
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@guru-irl/spider" }));
  await buildRoamEntries(join(packageRoot, "dist/roam"));
  writeFileSync(join(packageRoot, "dist/extension.js"), "// SPIDER_BUILD_ID=aaaaaaaa@2026-01-01T00:00:00.000Z v0.1.0\n");
  for (const mode of ["remote-runtime", "pane-endpoint"]) await build({ configFile: resolve("vite.herdr.config.mjs"), mode, logLevel: "error", build: { outDir: join(packageRoot, "dist/herdr") } });
});
afterAll(() => { vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });

it("packaged enable installs the executable CLI dispatcher rather than its imported module", async () => {
  const home = join(root, "home"), globalRoot = join(home, "global");
  mkdirSync(join(globalRoot, "roam"), { recursive: true, mode: 0o700 });
  const machineId = "00000000-0000-4000-8000-000000000001";
  writeFileSync(join(globalRoot, "roam/config.json"), JSON.stringify({ enabled: false, role: "hub", machineId,
    hubMachineId: machineId, peers: [], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  writeFileSync(join(globalRoot, "roam/machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  mkdirSync(join(globalRoot, "herdr"), { mode: 0o700 });
  writeFileSync(join(globalRoot, "herdr/config.json"), JSON.stringify({ version: 1, mode: "core-only",
    core: { binary: process.execPath, config: join(root, "core.json") }, globalRoot,
    agentDirectory: join(root, "agent"), shellRc: join(root, "shellrc"), resume: "offer", machines: [] }), { mode: 0o600 });
  const db = openDb(join(globalRoot, "spider.db")); migrate(db, "global", { machineId, globalRoot }); db.close();
  const launchctl = join(root, "service-manager");
  writeFileSync(launchctl, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  vi.stubEnv("HOME", home); vi.stubEnv("SPIDER_GLOBAL_ROOT", globalRoot);
  vi.stubEnv("HC_SOCKET", join(root, "unused-core.sock")); vi.stubEnv("HC_SESSION", "fixture");
  vi.stubEnv("SPIDER_ROAM_PI", process.execPath); vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl);
  const out: string[] = [], err: string[] = [];
  try {
    const cli = await import(/* @vite-ignore */ pathToFileURL(join(packageRoot, "dist/roam/cli-main.mjs")).href);
    const code = await cli.main(["roam", "enable"], { out: (text: string) => out.push(text), err: (text: string) => err.push(text) });
    expect({ code, out, err }).toMatchObject({ code: 0 });
    const directory = join(home, "Library/LaunchAgents"), files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const plist = readFileSync(join(directory, files[0]), "utf8");
    const args = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map(match => match[1]);
    expect(args.slice(1, 5)).toEqual([process.execPath, join(packageRoot, "dist/roam/cli.mjs"), "roam", "hub-v0"]);
    const entry = spawnSync(args[1], [...args.slice(2, 5), "--help"], { cwd: join(packageRoot, "dist"), encoding: "utf8", timeout: 2000 });
    expect(entry.status).toBe(2);
    expect(entry.stderr).toContain("Use spider roam hub-v0.");
    expect(entry.stderr).not.toContain("ENOENT");
    expect(entry.stderr).not.toContain("runtime request");
  } finally { vi.unstubAllEnvs(); }
});

it.each(["file", "directory", "preserved main"])("the packaged supervisor runs through a symlinked %s entry", kind => {
  const executable = join(packageRoot, "dist/roam/supervisor.mjs"), link = join(root, `supervisor-${kind.replaceAll(" ", "-")}`);
  symlinkSync(kind === "directory" ? join(packageRoot, "dist/roam") : executable, link);
  const result = spawnSync(process.execPath, [
    ...(kind === "preserved main" ? ["--preserve-symlinks-main"] : []),
    kind === "directory" ? join(link, "supervisor.mjs") : link, "--help",
  ], { cwd: root, encoding: "utf8", timeout: 2000 });
  expect(result.error).toBeUndefined();
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
    status: 0,
    stdout: "Usage: spider-roam-supervisor [--help]\nHosts sessions only for an enrolled box with initialized capture and hub-issued intent.\n",
    stderr: "",
  });
});

it("imports the bundled supervisor without Node type stripping support", () => {
  const entry = pathToFileURL(join(packageRoot, "dist/roam/supervisor.mjs")).href;
  const script = `
    import * as module from "node:module";
    const exports = Object.keys(module).filter(name => name !== "stripTypeScriptTypes");
    const withoutStrip = Object.fromEntries(exports.map(name => [name, module[name]]));
    const getBuiltin = process.getBuiltinModule.bind(process);
    process.getBuiltinModule = id => id === "node:module" ? withoutStrip : getBuiltin(id);
    const shim = "data:text/javascript," + encodeURIComponent("export { " + exports.join(", ") + " } from 'node:module';");
    module.registerHooks({ resolve(specifier, context, nextResolve) {
      if ((specifier === "node:module" || specifier === "module") && context.parentURL !== shim)
        return nextResolve(shim, context);
      return nextResolve(specifier, context);
    }});
    const supervisor = await import(${JSON.stringify(entry)});
    const out = [], err = [];
    const code = await supervisor.main(["--help"], { out: text => out.push(text), err: text => err.push(text) });
    console.log(JSON.stringify({ code, out, err }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 2000 });
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
    status: 0,
    stdout: JSON.stringify({ code: 0, out: ["Usage: spider-roam-supervisor [--help]\nHosts sessions only for an enrolled box with initialized capture and hub-issued intent.\n"], err: [] }) + "\n",
    stderr: "",
  });
});

it("executing the bundled CLI library never starts a remote runtime", () => {
  const result = spawnSync(process.execPath, [join(packageRoot, "dist/roam/cli-main.mjs"), "roam", "hub-v0", "--help"],
    { cwd: join(packageRoot, "dist"), encoding: "utf8", timeout: 2000 });
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
});

it("importing the bundled CLI ignores runtime-shaped process arguments", () => {
  const entry = join(packageRoot, "dist/roam/cli-main.mjs");
  const script = `process.argv[1]=${JSON.stringify(entry)}; process.argv[2]="roam"; const cli=await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log(typeof cli.main);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 2000 });
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 0, stdout: "function\n", stderr: "" });
});

it("the dedicated packaged remote runtime still installs and probes a fixture directory", () => {
  const entry = join(packageRoot, "dist/herdr/remote-runtime.mjs"), directory = join(root, "programs");
  for (const operation of ["--install", "--probe"]) {
    const result = spawnSync(process.execPath, [entry, operation, directory], { encoding: "utf8", timeout: 2000 });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ directory });
  }
  const missing = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 2000 });
  expect(missing.status).toBe(127); expect(missing.stderr).toContain("A runtime request file is required");
  const consoleUsage = spawnSync(process.execPath, [entry, "--console", directory, "fixture", "--unknown", "fixture"], { encoding: "utf8", timeout: 2000 });
  expect(consoleUsage.status).toBe(127); expect(consoleUsage.stderr).toContain("Invalid console view arguments");
});

it.each(entryFiles)("the bundle check rejects a remote main body in %s", entry => {
  const file = join(packageRoot, "dist/roam", entry), original = readFileSync(file, "utf8");
  expect(() => assertRoamBundle(packageRoot)).not.toThrow();
  try {
    writeFileSync(file, original + '\nif (process.argv[1]) process.stderr.write("A runtime request file is required\\n");\n');
    expect(() => assertRoamBundle(packageRoot)).toThrow(/unexpected remote runtime main/i);
  } finally { writeFileSync(file, original); }
});

it.each(entryFiles)("the bundle check rejects a pane main body in %s", entry => {
  const file = join(packageRoot, "dist/roam", entry), original = readFileSync(file, "utf8");
  expect(() => assertRoamBundle(packageRoot)).not.toThrow();
  try {
    writeFileSync(file, original + '\nif (process.argv[1]) await runPaneEndpointCli(process.argv.slice(2), () => ({}));\n');
    expect(() => assertRoamBundle(packageRoot)).toThrow(/unexpected pane endpoint main/i);
  } finally { writeFileSync(file, original); }
});

it("the dedicated pane endpoint rejects invalid CLI input and preserves its import API", () => {
  const entry = join(packageRoot, "dist/herdr/pane-endpoint.mjs");
  const invalid = spawnSync(process.execPath, [entry, "--help"], { encoding: "utf8", timeout: 2000 });
  expect({ status: invalid.status, stderr: invalid.stderr }).toEqual({ status: 1, stderr: "invalid-pane-command\n" });
  const script = `const endpoint=await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log(typeof endpoint.createProductionPaneEndpointPorts);`;
  const imported = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 2000 });
  expect({ status: imported.status, stdout: imported.stdout, stderr: imported.stderr }).toEqual({ status: 0, stdout: "function\n", stderr: "" });
});
