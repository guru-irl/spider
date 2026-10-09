import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
afterEach(cleanupFixtureDashboards);
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { controlDoctor } from "../control";
import { createFixtureDashboard, cleanupFixtureDashboards } from "../usage/__tests__/fixtures/dashboard-assets.js";
import * as build from "../../../../scripts/build-id.mjs";
import * as runtime from "../build-id";

const root = join(fileURLToPath(new URL("../../../../", import.meta.url)), ".");
const scratch = join(root, ".spider/scratch/build-id", `tests-${process.pid}`);
mkdirSync(scratch, { recursive: true });
vi.stubEnv("GIT_CEILING_DIRECTORIES", join(scratch, ".."));
afterAll(() => { vi.unstubAllEnvs(); rmSync(scratch, { recursive: true, force: true }); });
const builtAt = "2026-10-01T02:31:00.000Z";
const loaded = { sha: "bbe9f61", dirty: false, builtAt, version: "0.1.0" };
const marker = `SPIDER_BUILD_ID=bbe9f61@${builtAt} v0.1.0`;

function fixture(name: string, content?: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "extension.js");
  if (content !== undefined) writeFileSync(file, content);
  return file;
}

describe("build identity", () => {
  it("formats clean, dirty and unknown identities", () => {
    expect(build.formatBuildId).toBeTypeOf("function");
    expect(build.formatBuildId(loaded)).toBe(marker);
    expect(build.formatBuildId({ ...loaded, dirty: true })).toBe(marker.replace("bbe9f61", "bbe9f61-dirty"));
    expect(build.formatBuildId({ ...loaded, sha: "unknown" })).toBe(marker.replace("bbe9f61", "unknown"));
  });
  it("parses only complete, valid markers", () => {
    expect(build.parseBuildId).toBeTypeOf("function");
    expect(build.parseBuildId(`// ${marker}\ncode`)).toEqual({ sha: loaded.sha, dirty: false, builtAt, version: "0.1.0" });
    expect(build.parseBuildId(`// ${marker.replace("bbe9f61", "bbe9f61-dirty")}\n`)).toEqual({ sha: loaded.sha, dirty: true, builtAt, version: "0.1.0" });
    expect(build.parseBuildId(marker.replace("bbe9f61", "unknown"))).toEqual({ sha: "unknown", dirty: false, builtAt, version: "0.1.0" });
    for (const value of ["", marker.replace("bbe9f61", "nope"), marker.replace("2026-10-01", "2026-02-30"), marker + "junk", marker.replace(".000Z", "Z"), "x" + marker]) {
      expect(build.parseBuildId(value), value).toBeNull();
    }
  });
  it("captures git failure without failing the build", () => {
    expect(build.captureBuildId).toBeTypeOf("function");
    const calls: string[][] = [];
    const identity = build.captureBuildId({ version: "0.1.0", cwd: root, now: () => new Date(builtAt), git: (args: string[]) => { calls.push(args); throw new Error("git unavailable"); } });
    expect(identity).toEqual({ ...loaded, sha: "unknown" });
    expect(calls.length).toBeGreaterThan(0);
  });
  it("loads the build config when no git executable is available", () => {
    const configUrl = new URL("../../../../vite.config.mjs", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `const { default: config } = await import(${JSON.stringify(configUrl)}); const plugin = config.plugins.find(p => p.name === "spider-build-id"); plugin.buildStart(); const { parseBuildId } = await import(new URL("./scripts/build-id.mjs", ${JSON.stringify(configUrl)})); console.log(JSON.stringify(parseBuildId(plugin.renderChunk("__SPIDER_BUILD_ID_PLACEHOLDER__").code)));`], {
      cwd: scratch, env: { ...process.env, PATH: scratch }, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ sha: "unknown", dirty: false, version: "0.1.0" });
  });
  it("captures dirty status and version", () => {
    expect(build.captureBuildId).toBeTypeOf("function");
    const identity = build.captureBuildId({ version: "0.1.0", cwd: root, now: () => new Date(builtAt), git: (args: string[]) => args.includes("--show-toplevel") ? root : args.includes("rev-parse") ? "bbe9f61\n" : " M README.md\n" });
    expect(identity).toEqual({ ...loaded, dirty: true });
  });
  it("runs git in the checkout rather than the caller cwd, without optional locks or untracked status", () => {
    const bin = join(scratch, "fake-bin");
    mkdirSync(bin, { recursive: true });
    const git = join(bin, "git");
    writeFileSync(git, `#!${process.execPath}
const args = process.argv.slice(2); if (process.cwd() !== ${JSON.stringify(root)} || args[0] !== "--no-optional-locks") process.exit(1); if (args.includes("--show-toplevel")) console.log(process.cwd()); else if (args.includes("rev-parse")) console.log("abcdef0"); else if (args.includes("--untracked-files=no")) console.log(""); else console.log("?? spider.db");
`);
    chmodSync(git, 0o755);
    const url = new URL("../../../../vite.config.mjs", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `const { default: config } = await import(${JSON.stringify(url)}); const plugin = config.plugins.find(p => p.name === "spider-build-id"); plugin.buildStart(); const { parseBuildId } = await import(new URL("./scripts/build-id.mjs", ${JSON.stringify(url)})); console.log(JSON.stringify(parseBuildId(plugin.renderChunk("__SPIDER_BUILD_ID_PLACEHOLDER__").code)));`], {
      cwd: scratch, env: { ...process.env, PATH: bin }, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ sha: "abcdef0", dirty: false });
  });
  it("does not attribute an unpacked checkout to its parent repository", () => {
    const nested = join(scratch, "unpacked");
    mkdirSync(nested, { recursive: true });
    const identity = build.captureBuildId({ cwd: nested, version: "0.1.0", now: () => new Date(builtAt), git: (args: string[]) => args.includes("--show-toplevel") ? root : "abcdef0" });
    expect(identity).toEqual({ ...loaded, sha: "unknown" });
  });
  it("pins the extension's comparison URL to the loaded entry, not cwd or an assumed dist directory", async () => {
    const { loadedBundle } = await import("../extension");
    expect(loadedBundle.url).toBe(new URL("../extension.ts", import.meta.url).href);
  });
});

describe("doctor bundle line", () => {
  afterEach(() => { vi.stubEnv("PI_SUBAGENT_CHILD", "0"); });
  it.each([
    ["new shim", "?build=1-2", "0", "RELOAD NEEDED, /reload to load it"],
    ["old shim", "", "0", "RESTART NEEDED, restart pi to load it"],
    ["direct package", "", "0", "RESTART NEEDED, restart pi to load it"],
    ["fallback load", "", "0", "RESTART NEEDED, restart pi to load it"],
    ["subagent child", "", "1", "the next dispatched subagent will load the new bundle"],
    ["child precedence", "?build=1-2", "1", "the next dispatched subagent will load the new bundle"],
  ])("gives an actionable mismatch remedy for %s", (name, query, child, remedy) => {
    vi.stubEnv("PI_SUBAGENT_CHILD", child);
    const file = fixture(`layout-${name}`, `// SPIDER_BUILD_ID=abcdef0@${builtAt} v0.1.0\n`);
    const line = runtime.bundleDoctorLine({ identity: loaded, url: new URL(`file://${file}${query}`).href });
    expect(line).toContain(remedy);
    if (!query || child === "1") expect(line).not.toContain("/reload to load it");
    if (child === "1") {
      expect(line).not.toContain("restart pi to load it");
      expect(line).not.toContain("loaded without reload support");
    }
  });
  it.each(["current", "mismatch", "missing", "unreadable"])("shows the shim regeneration hint without a query even when %s", state => {
    const content = state === "unreadable" ? undefined : state === "missing" ? "// old bundle\n"
      : `// ${state === "mismatch" ? marker.replace("bbe9f61", "abcdef0") : marker}\n`;
    const file = fixture(`hint-${state}`, content);
    const context = { identity: loaded, url: new URL(`file://${file}`).href };
    expect(runtime.bundleDoctorLine(context)).toContain("loaded without reload support: for a linked checkout run npm run link, then restart pi once");
    expect(runtime.bundleDoctorLine({ ...context, url: context.url + "?build=1-2" })).not.toContain("run npm run link");
  });
  it.each([
    ["current", `// ${marker}\nthrow new Error('must not execute');`, "- bundle: current ("],
    ["different", `// SPIDER_BUILD_ID=abcdef0@${builtAt} v0.1.0\n`, "- bundle: RELOAD NEEDED, /reload to load it"],
    ["rebuilt", `// SPIDER_BUILD_ID=bbe9f61@2026-10-02T02:31:00.000Z v0.1.0\n`, "- bundle: RELOAD NEEDED"],
    ["dirty", `// ${marker.replace("bbe9f61", "bbe9f61-dirty")}\n`, "installed bbe9f61-dirty"],
    ["missing marker", "// old bundle\n", "build marker unavailable"],
    ["unreadable", undefined, "- bundle: unreadable"],
  ])("reports %s from a fixture, without changing health status", (name, content, expected) => {
    const file = fixture(name, content);
    const context = { identity: loaded, url: new URL(`file://${file}?build=1-2`).href };
    const before = controlDoctor(scratch);
    const report = controlDoctor(scratch, undefined, context);
    expect(report.lines.join("\n")).toContain(`bbe9f61 built ${builtAt}, v0.1.0`);
    expect(report.lines.join("\n")).toContain(expected);
    expect(report.ok).toBe(before.ok);
  });
  it("re-reads the file after replacement while retaining its loaded identity", () => {
    expect(runtime.bundleDoctorLine).toBeTypeOf("function");
    const file = fixture("replacement", `// ${marker}\n`);
    const context = { identity: loaded, url: new URL(`file://${file}?build=1-2`).href };
    expect(runtime.bundleDoctorLine(context)).toContain("- bundle: current (");
    writeFileSync(file, `// SPIDER_BUILD_ID=abcdef0@${builtAt} v0.1.0\n`);
    expect(runtime.bundleDoctorLine(context)).toContain("installed abcdef0");
    expect(runtime.bundleDoctorLine(context)).toContain("loaded bbe9f61");
  });
  it("does not read a marker beyond the first 16 KiB", () => {
    const file = fixture("bounded", " ".repeat(16 * 1024) + `// ${marker}\n`);
    expect(runtime.bundleDoctorLine({ identity: loaded, url: new URL(`file://${file}?build=1-2`).href })).toContain("build marker unavailable");
  });
  it("includes the verdict before long metadata so collapsed doctor output retains it", () => {
    const file = fixture("verdict", `// SPIDER_BUILD_ID=abcdef0@${builtAt} v0.1.0\n`);
    const line = runtime.bundleDoctorLine({ identity: loaded, url: new URL(`file://${file}?build=1-2`).href });
    expect(line.slice(0, 80)).toContain("RELOAD NEEDED");
    expect(line.slice(0, 80)).toContain("/reload to load it");
  });
  it("compares the installed version as well as the commit and build time", () => {
    const file = fixture("version", `// ${marker.replace("v0.1.0", "v0.2.0")}\n`);
    expect(runtime.bundleDoctorLine({ identity: loaded, url: new URL(`file://${file}?build=1-2`).href })).toContain("RELOAD NEEDED");
  });
});

describe("assert-bundle marker gate", () => {
  it("rejects a natively linkable marked bundle whose default export is not a function", () => {
    const dir = join(scratch, "non-function-export", "dist");
    mkdirSync(dir, { recursive: true });
    createFixtureDashboard(undefined, join(dir, "dashboard"));
    writeFileSync(join(dir, "extension.js"), `// ${marker}\nexport default { fixture: true };\n`);
    const result = spawnSync(process.execPath, [join(root, "scripts/assert-bundle.mjs")], { cwd: join(dir, ".."), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("default export is not a function");
  });
  it("rejects a marked bundle that cannot link natively", () => {
    const dir = join(scratch, "native-link-failure", "dist");
    mkdirSync(dir, { recursive: true });
    createFixtureDashboard(undefined, join(dir, "dashboard"));
    writeFileSync(join(dir, "extension.js"), `// ${marker}\nimport { missing } from 'node:fs';\nexport default function spiderExtension() { return missing; }\n`);
    const result = spawnSync(process.execPath, [join(root, "scripts/assert-bundle.mjs")], { cwd: join(dir, ".."), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("native import failed");
    expect(result.stderr).toContain("missing");
  });
  it.each([
    ["valid", `// ${marker}\n`, 0],
    ["dropped marker mutant", "", 1],
    ["invalid timestamp", "// SPIDER_BUILD_ID=bbe9f61@invalid v0.1.0\n", 1],
    ["invalid sha", `// SPIDER_BUILD_ID=garbage@${builtAt} v0.1.0\n`, 1],
  ])("checks %s", (name, banner, exitCode) => {
    const dir = join(scratch, name, "dist");
    mkdirSync(dir, { recursive: true });
    createFixtureDashboard(undefined, join(dir, "dashboard"));
    writeFileSync(join(dir, "extension.js"), `${banner}export default function spiderExtension() {}\n`);
    const result = spawnSync(process.execPath, [join(root, "scripts/assert-bundle.mjs")], { cwd: join(dir, ".."), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(exitCode);
    if (exitCode) expect(result.stderr).toContain("build marker");
  });
});
