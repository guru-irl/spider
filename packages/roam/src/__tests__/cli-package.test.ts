import { afterEach, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { processStartTime } from "../../../subagents/src/process-identity";
import { pathToFileURL } from "node:url";
import { buildFixture } from "../../../../scripts/test-bundle";
import * as dbCore from "@spider/db-core";
import { scratchDbPath } from "@spider/db-core/testutil";
import { build } from "vite";
import { assertRoamBundle } from "../../../../scripts/check-roam-bundle.mjs";
import { buildRoamEntries } from "../../../../scripts/build-roam.mjs";
import { main } from "../cli";
import { loadConfig } from "../config";
import { DEFAULT_LIMITS } from "../contracts";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(dirname(scratchDbPath("roam-cli")), "roam-cli-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const hubId = "00000000-0000-4000-8000-000000000001";
const peerId = "00000000-0000-4000-8000-000000000002";
function peer(): Record<string, unknown> {
  return { machineId: peerId, alias: "box-1.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/spider", core: "/fixture/hc", globalRoot: "/fixture/global" };
}
function config(): Record<string, unknown> {
  return { enabled: false, role: "hub", machineId: hubId, hubMachineId: hubId, peers: [peer()], discoveryRoots: ["/fixture/repos"], coreUnit: "herdr.service" };
}
function save(root: string, value: unknown): string {
  const file = join(root, "config.json");
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}
function capture(): { io: { out(text: string): void; err(text: string): void }; out: string[]; err: string[] } {
  const out: string[] = [], err: string[] = [];
  return { io: { out: text => out.push(text), err: text => err.push(text) }, out, err };
}

it("help opens no DB and makes no hc call", async () => {
  const root = fixture();
  const marker = join(root, "hc-called");
  const binary = join(root, "hc");
  writeFileSync(binary, `#!/bin/sh\nprintf called > '${marker}'\nexit 1\n`, { mode: 0o700 });
  vi.stubEnv("PATH", `${root}:${process.env.PATH ?? ""}`);
  vi.stubEnv("SPIDER_GLOBAL_ROOT", join(root, "global"));
  const opened = vi.spyOn(dbCore, "openDb");
  const output = capture();
  const helpExit = await main(["--help"], output.io);
  const openedDbs = opened.mock.calls.length;
  const hcCalls = existsSync(marker) ? ["called"] : [];
  expect(helpExit).toBe(0);
  expect(openedDbs).toBe(0);
  expect(hcCalls).toEqual([]);
  expect(output.out.join("")).toMatch(/usage:/i);
  expect(output.out.join("")).toMatch(/0.*complete/i);
  expect(output.out.join("")).toMatch(/1.*refus/i);
  expect(output.out.join("")).toMatch(/2.*invalid/i);
  expect(output.out.join("")).toMatch(/3.*durable pending/i);
  expect(output.err).toEqual([]);
  expect(existsSync(join(root, "global"))).toBe(false);
}, 5000);

it("box rejects outbound peers", () => {
  const root = fixture();
  const value = { ...config(), role: "box", machineId: peerId, peers: [{ ...peer(), machineId: "00000000-0000-4000-8000-000000000003" }] };
  expect(() => loadConfig(save(root, value))).toThrow(/box.*peers/i);
  const accepted = loadConfig(save(root, { ...value, peers: [] }));
  expect(accepted.peers).toEqual([]);
}, 5000);

it("rejects aliases and malformed UUIDs as machine identities", () => {
  const root = fixture();
  expect(() => loadConfig(save(root, { ...config(), machineId: "box-1.invalid", hubMachineId: "box-1.invalid" }))).toThrow(/identity/i);
  expect(() => loadConfig(save(root, { ...config(), peers: [{ ...peer(), machineId: "box-1.invalid" }] }))).toThrow(/identity/i);
  expect(() => loadConfig(save(root, { ...config(), hubMachineId: "00000000-0000-1000-8000-000000000001" }))).toThrow(/identity/i);
}, 5000);

it("invalid arguments exit two", async () => {
  for (const args of [["nonsense"], ["roam", "status", "--unknown"], ["roam", "repo", "map", "only-key"], ["move", "session-1"], ["roam", "memory", "tag"]]) {
    const output = capture();
    expect(await main(args, output.io), args.join(" ")).toBe(2);
    expect(output.err.join("")).toMatch(/usage|invalid/i);
  }
}, 5000);

it("future commands refuse without attempting work", async () => {
  for (const args of [["roam", "sync"], ["move", "session-1", "box-1.invalid"]]) {
    const output = capture();
    expect(await main(args, output.io)).toBe(1);
    expect(output.err.join("")).toMatch(/unavailable/i);
  }
}, 5000);

it("uses fixed transfer defaults and permits explicit raises", () => {
  const root = fixture();
  const defaults = loadConfig(save(root, config()));
  expect(defaults.enabled).toBe(false);
  expect(defaults.syncMs).toBe(120_000);
  expect(defaults.limits).toEqual({
    chunkBytes: 393_216, replyBytes: 1_048_576, manifestBytes: 524_288,
    targetBatchBytes: 4_194_304, hardBatchBytes: 16_777_216, applyTargetMs: 250,
    workspaceBytes: 268_435_456, sessionBytes: 1_073_741_824, agentBytes: 268_435_456, stagingBytes: 4_294_967_296,
    fileMs: 30_000, controlMs: 60_000, exportMs: 120_000, importMs: 600_000,
    directMs: 600_000, launchMs: 60_000, readyMs: 60_000, transferMs: 1_800_000,
    peerConcurrency: 2, retryDelaysMs: [1_000, 2_000, 4_000], retentionMs: 604_800_000,
  });
  const raised = loadConfig(save(root, { ...config(), limits: { chunkBytes: 400_000 } }));
  expect(raised.limits.chunkBytes).toBe(400_000);
  expect(raised.limits.replyBytes).toBe(1_048_576);
  expect(DEFAULT_LIMITS.chunkBytes).toBe(393_216);
}, 5000);

it.each(["box-1.invalid;box-2.invalid", "$(id);box-1.invalid", "-box-1.invalid", "box 1.invalid"]) ("preserves shell punctuation in a peer alias: %s", alias => {
  const root = fixture();
  const parsed = loadConfig(save(root, { ...config(), peers: [{ ...peer(), alias }] }));
  expect(parsed.peers[0].alias).toBe(alias);
}, 5000);

it.each(["node", "pi", "cli", "core", "globalRoot"]) ("requires an absolute peer %s path", key => {
  const root = fixture();
  const missing = { ...peer() };
  delete missing[key];
  expect(() => loadConfig(save(root, { ...config(), peers: [missing] }))).toThrow(/path/i);
  expect(() => loadConfig(save(root, { ...config(), peers: [{ ...peer(), [key]: "relative/path" }] }))).toThrow(/path/i);
}, 5000);

it.each([
  { chunkBytes: 0 }, { replyBytes: -1 }, { applyTargetMs: 0.5 },
  { retryDelaysMs: [1000, -1] }, { chunkBytes: 2_000_000 },
  { targetBatchBytes: 20_000_000 }, { hardBatchBytes: 0 },
])("rejects invalid limits without silently substituting defaults", limits => {
  const root = fixture();
  expect(() => loadConfig(save(root, { ...config(), limits }))).toThrow(/limit/i);
}, 5000);

it("does not leak secret-bearing values in config diagnostics", () => {
  const root = fixture();
  const secret = "private-config-value";
  const file = save(root, { ...config(), peers: [{ ...peer(), alias: secret + "\n" }] });
  let diagnostic = "";
  try { loadConfig(file); } catch (error) { diagnostic = String(error); }
  expect(diagnostic).toMatch(/alias/i);
  expect(diagnostic).not.toContain(secret);
  writeFileSync(file, `{"secret":"${secret}",`);
  expect(() => loadConfig(file)).toThrow(/config/i);
  try { loadConfig(file); } catch (error) { expect(String(error)).not.toContain(secret); }
}, 5000);

it.each([
  ["side effect", "cli.mjs", 'import /* marker */ "@earendil-works/pi-tui";'],
  ["re-export", "supervisor.mjs", 'export { x } from "@earendil-works/pi-coding-agent";'],
  ["dynamic", "cli.mjs", 'import("@earendil-works/pi-ai");'],
  ["require", "supervisor.mjs", 'require("@earendil-works/pi-coding-agent");'],
  ["aliased require", "cli.mjs", 'const load = createRequire(import.meta.url); load("@earendil-works/pi-tui");'],
  ["computed dynamic", "supervisor.mjs", 'const name = "pi-" + "tui"; import(name);'],
  ["inlined", "cli.mjs", '// node_modules/@earendil-works/pi-coding-agent/index.js'],
])("rejects %s pi imports in a roaming entry", async (_name, file, statement) => {
  const root = fixture(), directory = join(root, "dist/roam");
  mkdirSync(directory, { recursive: true });
  for (const entry of ["cli.mjs", "supervisor.mjs"]) writeFileSync(join(directory, entry), "#!/usr/bin/env node\nexport {};\n");
  expect(() => assertRoamBundle(root)).not.toThrow();
  writeFileSync(join(directory, file), `#!/usr/bin/env node\n${statement}\n`);
  expect(() => assertRoamBundle(root)).toThrow(/pi import/i);
}, 5000);

it("the roaming bundler refuses pi and keeps native SQLite external", async () => {
  const root = fixture(), entry = join(root, "entry.ts"), outDir = join(root, "out");
  const factory = (await import(new URL("../../../../vite.roam.config.mjs", import.meta.url).href)).default as
    (env: { mode: string; command: string }) => import("vite").UserConfig;
  const settings = factory({ mode: "cli", command: "build" });
  const options: import("vite").InlineConfig = {
    ...settings, configFile: false, logLevel: "silent",
    build: { ...settings.build, ssr: entry, outDir, emptyOutDir: true },
  };
  writeFileSync(entry, 'import "@earendil-works/pi-coding-agent"; export const ready = true;\n');
  await expect(build(options)).rejects.toThrow(/cannot import pi/i);
  writeFileSync(entry, 'import Database from "better-sqlite3"; export { Database };\n');
  await build(options);
  const bundle = readFileSync(join(outDir, "cli.mjs"), "utf8");
  expect(bundle).toMatch(/from ["']better-sqlite3["']/);
  expect(bundle).not.toContain("node_modules/better-sqlite3/");
}, 5000);

it("the journal workspace subpath bundles without pi or inlined SQLite", async () => {
  const root = fixture(), entry = join(root, "entry.ts"), outDir = join(root, "dist/roam");
  const factory = (await import(new URL("../../../../vite.roam.config.mjs", import.meta.url).href)).default as
    (env: { mode: string; command: string }) => import("vite").UserConfig;
  const settings = factory({ mode: "cli", command: "build" });
  writeFileSync(entry, 'export { openJournal } from "@spider/roam/journal";\n');
  await build({ ...settings, configFile: false, logLevel: "silent", build: { ...settings.build, ssr: entry, outDir, emptyOutDir: true } });
  writeFileSync(join(outDir, "supervisor.mjs"), "#!/usr/bin/env node\nexport {};\n");
  const bundle = readFileSync(join(outDir, "cli.mjs"), "utf8");
  expect(bundle).toContain('"better-sqlite3"');
  expect(bundle).not.toContain("node_modules/better-sqlite3/");
  expect(() => assertRoamBundle(root)).not.toThrow();
}, 5000);

it("the intercom exchange codec bundles without pi or SQLite", async () => {
  const root = fixture(), entry = join(root, "codec.ts"), bundle = join(root, "codec.mjs");
  writeFileSync(entry, 'export { encodeExchange, decodeExchange } from "@spider/roam/intercom-codec";\n');
  const result = await buildFixture({ entryPoints: [entry], outfile: bundle, external: ["better-sqlite3", "sqlite-vec"] });
  const inputs = Object.keys(result.metafile.inputs), output = readFileSync(bundle, "utf8");
  expect(inputs.some(path => path.endsWith("packages/intercom/src/protocol.ts"))).toBe(true);
  expect(inputs.filter(path => path.includes("/packages/db-core/src/"))).toEqual([]);
  expect(output).not.toContain("better-sqlite3");
  expect(output).not.toContain("@earendil-works/pi-");
  const loaded = await import(pathToFileURL(bundle).href) as { encodeExchange: unknown; decodeExchange: unknown };
  expect(loaded.encodeExchange).toBeTypeOf("function");
  expect(loaded.decodeExchange).toBeTypeOf("function");
}, 5000);

it("the intercom store and codec subpaths bundle without pi or inlined SQLite", async () => {
  const root = fixture(), entry = join(root, "entry.ts"), outDir = join(root, "dist/roam");
  writeFileSync(entry, 'export { openIntercomStore } from "@spider/roam/intercom-store"; export { encodeFrame } from "@spider/roam/intercom-codec";\n');
  const factory = (await import(new URL("../../../../vite.roam.config.mjs", import.meta.url).href)).default as
    (env: { mode: string; command: string }) => import("vite").UserConfig;
  const settings = factory({ mode: "cli", command: "build" });
  await build({ ...settings, configFile: false, logLevel: "silent", build: { ...settings.build, ssr: entry, outDir, emptyOutDir: true } });
  writeFileSync(join(outDir, "supervisor.mjs"), "#!/usr/bin/env node\nexport {};\n");
  const bundle = readFileSync(join(outDir, "cli.mjs"), "utf8");
  expect(bundle).toContain('"better-sqlite3"');
  expect(bundle).not.toContain("node_modules/better-sqlite3/");
  expect(() => assertRoamBundle(root)).not.toThrow();
  const fixtureBundle = join(root, "fixture-intercom.mjs");
  const result = await buildFixture({ entryPoints: [entry], outfile: fixtureBundle, external: ["better-sqlite3", "sqlite-vec"] });
  expect(Object.keys(result.metafile.inputs).some(path => path.endsWith("packages/intercom/src/protocol.ts"))).toBe(true);
  const loaded = await import(pathToFileURL(fixtureBundle).href) as { openIntercomStore: unknown; encodeFrame: unknown };
  expect(loaded.openIntercomStore).toBeTypeOf("function");
  expect(loaded.encodeFrame).toBeTypeOf("function");
}, 5000);

it("the standalone hub subpath bundles without pi in the roaming and fixture builders", async () => {
  const root = fixture(), entry = join(root, "entry.ts"), outDir = join(root, "dist/roam");
  writeFileSync(entry, 'export { runStandaloneHub } from "@spider/roam/hub";\n');
  const factory = (await import(new URL("../../../../vite.roam.config.mjs", import.meta.url).href)).default as
    (env: { mode: string; command: string }) => import("vite").UserConfig;
  const settings = factory({ mode: "cli", command: "build" });
  await build({ ...settings, configFile: false, logLevel: "silent", build: { ...settings.build, ssr: entry, outDir, emptyOutDir: true } });
  writeFileSync(join(outDir, "supervisor.mjs"), "#!/usr/bin/env node\nexport {};\n");
  expect(() => assertRoamBundle(root)).not.toThrow();
  const fixtureBundle = join(root, "fixture-hub.mjs");
  const result = await buildFixture({ entryPoints: [entry], outfile: fixtureBundle, external: ["better-sqlite3", "sqlite-vec"] });
  expect(Object.keys(result.metafile.inputs).some(path => path.endsWith("packages/roam/src/hub.ts"))).toBe(true);
  expect(typeof (await import(pathToFileURL(fixtureBundle).href)).runStandaloneHub).toBe("function");
}, 5000);

it("importing the CLI in a directly executed host bundle does not run the CLI", async () => {
  const root = fixture(), entry = join(root, "host.ts"), bundle = join(root, "host.mjs");
  writeFileSync(entry, 'import { main } from "@spider/roam/cli"; console.log(typeof main === "function" ? "host ready" : "missing");\n');
  await buildFixture({ entryPoints: [entry], outfile: bundle, external: ["better-sqlite3", "sqlite-vec"] });
  const result = spawnSync(process.execPath, [bundle, "--spider-usage-server"], {
    cwd: root, env: { ...process.env, HOME: root, SPIDER_GLOBAL_ROOT: join(root, "global") }, encoding: "utf8", timeout: 2000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("host ready");
  expect(result.stderr).toBe("");
  expect(existsSync(join(root, "global"))).toBe(false);
}, 5000);

it("the roaming CLI subpath bundles and runs through the fixture builder", async () => {
  const root = fixture(), entry = join(root, "entry.ts"), bundle = join(root, "fixture-cli.mjs"), globalRoot = join(root, "global");
  writeFileSync(entry, 'export { main } from "@spider/roam/cli";\n');
  const result = await buildFixture({ entryPoints: [entry], outfile: bundle, external: ["better-sqlite3", "sqlite-vec"] });
  expect(Object.keys(result.metafile.inputs).some(path => path.endsWith("packages/roam/src/cli.ts"))).toBe(true);
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", globalRoot);
  const packaged = await import(pathToFileURL(bundle).href) as { main: typeof main };
  const output = capture();
  expect(await packaged.main(["roam", "doctor"], output.io)).toBe(0);
  expect(output.out.join("")).toMatch(/roam.*disabled/i);
  expect(output.err).toEqual([]);
  expect(existsSync(globalRoot)).toBe(false);
}, 5000);

it("workspace dependencies and lock metadata resolve the roaming package", () => {
  const workspace = JSON.parse(readFileSync("packages/roam/package.json", "utf8"));
  const host = JSON.parse(readFileSync("packages/host/package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  expect(workspace.dependencies).toEqual({ "@spider/db-core": "0.0.0", "@spider/herdr": "0.0.0", "@spider/intercom": "0.0.0", "@spider/memory": "0.0.0" });
  expect(host.dependencies["@spider/roam"]).toBe("0.0.0");
  expect(lock.packages["node_modules/@spider/roam"]).toEqual({ resolved: "packages/roam", link: true });
  expect(lock.packages["packages/roam"]).toMatchObject({ name: "@spider/roam", version: "0.0.0", dependencies: workspace.dependencies });
  expect(lock.packages["packages/host"].dependencies["@spider/roam"]).toBe("0.0.0");
  expect(lock.packages[""].bin.spider).toBe("dist/roam/cli.mjs");
}, 5000);

it("the package gate refuses a missing roaming executable or link script", () => {
  const skills = ["packages/superpowers/skills", "packages/pstack/skills", "packages/intercom/skills"].flatMap(dir =>
    readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(file => file === "SKILL.md" || file.endsWith("/SKILL.md")).map(file => `${dir}/${file}`));
  const files = ["dist/extension.js", "dist/intercom/broker.mjs", "dist/dashboard/index.html", "dist/dashboard/assets/app-aaaaaaaa.js", "dist/dashboard/assets/app-aaaaaaaa.css",
    "README.md", "LICENSE", "NOTICE.md", "packages/context/LICENSE", "packages/pstack/LICENSE", "packages/intercom/LICENSE", "packages/intercom/ORIGIN.md", ...skills,
    "dist/roam/cli.mjs", "dist/roam/cli-main.mjs", "dist/roam/intercom-helper.mjs", "dist/roam/supervisor.mjs", "scripts/link.mjs", "scripts/dev-link.mjs", "scripts/intercom-switchover.mjs",
    "scripts/link-roam.mjs", "scripts/extension-shim.mjs", "scripts/pi-agent-dir.mjs"];
  const gate = (present: string[]) => spawnSync(process.execPath, ["scripts/check-package-files.cjs"], {
    input: JSON.stringify([{ files: present.map(path => ({ path })) }]), encoding: "utf8", timeout: 2000,
  });
  expect(gate(files).status).toBe(0);
  for (const missing of ["dist/roam/cli.mjs", "dist/roam/cli-main.mjs", "dist/roam/intercom-helper.mjs", "dist/roam/supervisor.mjs", "scripts/link.mjs", "scripts/dev-link.mjs",
    "scripts/link-roam.mjs", "scripts/extension-shim.mjs", "scripts/pi-agent-dir.mjs", "dist/intercom/broker.mjs",
    "packages/intercom/LICENSE", "packages/intercom/ORIGIN.md", "scripts/intercom-switchover.mjs", "packages/intercom/skills/pi-intercom/SKILL.md"]) {
    const result = gate(files.filter(file => file !== missing));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(missing);
  }
}, 5000);

it("the packaged roaming doctor reads actual loaded builds and leaves stores unchanged", async () => {
  const root = fixture(), globalRoot = join(root, "global"), bundleRoot = join(root, "built"), bin = join(root, "bin");
  mkdirSync(globalRoot, { recursive: true });
  mkdirSync(bin);
  const db = dbCore.openDb(join(globalRoot, "spider.db"));
  try {
    dbCore.migrate(db, "global", { machineId: hubId, globalRoot });
    db.exec("DROP TRIGGER roam_global_memory_capture_ai");
  } finally { db.close(); }
  const startIdentity = processStartTime(process.pid);
  expect(startIdentity).not.toBeNull();
  const presence = createProcessPresence(join(globalRoot, "herdr"));
  const live = { pid: process.pid, startIdentity: startIdentity!, sessionFile: null, sessionName: null,
    kind: "top-level" as const, hcAddress: null, capabilities: { roamSchema: 14 } };
  await presence.record({ ...live, build: { sha: "1234567", builtAt: "2026-01-02T03:04:05.000Z", version: "1.0.0", dirty: false } });
  writeFileSync(join(bin, "sqlite3"), "#!/bin/sh\nprintf '3.37.9\\n'\n", { mode: 0o700 });
  await buildRoamEntries(join(bundleRoot, "roam"));
  writeFileSync(join(bundleRoot, "extension.js"), "// SPIDER_BUILD_ID=abcdef1@2026-01-02T03:04:05.000Z v1.0.0\n");
  const snapshot = (directory: string): Array<[string, string]> => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? snapshot(path) : [[relative(globalRoot, path), createHash("sha256").update(readFileSync(path)).digest("hex")] as [string, string]];
  }).sort((a, b) => a[0].localeCompare(b[0]));
  const before = snapshot(globalRoot);
  const result = spawnSync(process.execPath, [join(bundleRoot, "roam", "cli.mjs"), "roam", "doctor"], {
    cwd: root, env: { ...process.env, HOME: root, SPIDER_GLOBAL_ROOT: globalRoot, PATH: `${bin}:${process.env.PATH ?? ""}` },
    encoding: "utf8", timeout: 3000,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("roam_global_memory_capture_ai");
  expect(result.stdout).toMatch(/capture.*disabled/i);
  expect(result.stdout).toMatch(/sqlite3.*3\.38.*migrated/i);
  expect(result.stdout).toMatch(/loaded build 1234567/);
  expect(snapshot(globalRoot)).toEqual(before);
  const status = spawnSync(process.execPath, [join(bundleRoot, "roam", "cli.mjs"), "roam", "status", "--json"], {
    cwd: root, env: { ...process.env, HOME: root, SPIDER_GLOBAL_ROOT: globalRoot, PATH: `${bin}:${process.env.PATH ?? ""}` },
    encoding: "utf8", timeout: 3000,
  });
  expect(status.status).toBe(0);
  expect(status.stderr).toBe("");
  expect(JSON.parse(status.stdout)).toMatchObject({ enabled: false, cached: true, available: true, stores: [expect.objectContaining({ key: "global" })] });
  expect(snapshot(globalRoot)).toEqual(before);
  await presence.record({ ...live, build: { sha: "abcdef1", builtAt: "2026-01-02T03:04:05.000Z", version: "1.0.0", dirty: false } });
  const compatibleBefore = snapshot(globalRoot);
  const compatible = spawnSync(process.execPath, [join(bundleRoot, "roam", "cli.mjs"), "roam", "doctor"], {
    cwd: root, env: { ...process.env, HOME: root, SPIDER_GLOBAL_ROOT: globalRoot, PATH: `${bin}:${process.env.PATH ?? ""}` },
    encoding: "utf8", timeout: 3000,
  });
  expect(compatible.status).toBe(0);
  expect(compatible.stderr).toBe("");
  expect(compatible.stdout).toMatch(/loaded build abcdef1@2026-01-02T03:04:05\.000Z v1\.0\.0, roaming schema 14/);
  expect(compatible.stdout).not.toMatch(/without the required release/);
  expect(snapshot(globalRoot)).toEqual(compatibleBefore);
}, 5000);

it("packed entries have no pi imports", async () => {
  const root = fixture();
  const cwd = resolve(".");
  const env = { ...process.env, HOME: root, TMPDIR: root };
  const buildOut = join(root, "built", "roam");
  await buildRoamEntries(buildOut);
  const packageRoot = join(root, "package"), unpacked = join(root, "unpacked"), archive = join(root, "fixture.tgz");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  mkdirSync(unpacked);
  cpSync(buildOut, join(packageRoot, "dist", "roam"), { recursive: true });
  cpSync(join(cwd, "package.json"), join(packageRoot, "package.json"));
  execFileSync("tar", ["-czf", archive, "-C", root, "package"], { timeout: 2000 });
  const paths = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", timeout: 2000 }).split("\n");
  execFileSync("tar", ["-xzf", archive, "-C", unpacked], { timeout: 2000 });
  const manifest = JSON.parse(readFileSync(join(unpacked, "package", "package.json"), "utf8")) as { bin: { spider: string }; files: string[] };
  expect(manifest.bin.spider).toBe("dist/roam/cli.mjs");
  expect(manifest.files).toContain("dist");
  expect(paths).toEqual(expect.arrayContaining(["package/dist/roam/cli.mjs", "package/dist/roam/supervisor.mjs"]));
  expect(() => assertRoamBundle(join(unpacked, "package"))).not.toThrow();
  for (const file of ["dist/roam/cli.mjs", "dist/roam/supervisor.mjs"]) {
    const entry = join(unpacked, "package", file);
    const source = readFileSync(entry, "utf8");
    expect(source).not.toMatch(/(?:from\s*|import\s*\(|require\s*\()\s*["']@earendil-works\/pi-/);
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
    if (process.platform !== "win32") expect(statSync(join(buildOut, file.split("/").at(-1)!)).mode & 0o777).toBe(0o700);
    const result = spawnSync(process.execPath, [entry, "--help"], { cwd: root, env: { ...env, SPIDER_GLOBAL_ROOT: join(root, "global") }, encoding: "utf8", timeout: 2000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/usage:/i);
    expect(result.stderr).toBe("");
  }
  const supervisor = spawnSync(process.execPath, [join(unpacked, "package", "dist/roam/supervisor.mjs")], { cwd: root, env, encoding: "utf8", timeout: 2000 });
  expect(supervisor.status).toBe(1);
  expect(supervisor.stderr).toMatch(/hosting.*unavailable/i);
  expect(existsSync(join(root, "global"))).toBe(false);
}, 5000);
