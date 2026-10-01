import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scratchRoot = join(repoRoot, "packages/db-core/.spider/scratch", String(process.pid));
const fixtures: string[] = [];

function fixture() {
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(join(scratchRoot, "fixture-"));
  fixtures.push(root);
  const home = join(root, "home");
  const cwd = join(root, "package");
  const initCwd = join(root, "consumer");
  for (const dir of [home, cwd, initCwd]) mkdirSync(dir);
  return { root, home, cwd, initCwd, defaultRoot: join(home, ".pi/agent/spider") };
}

type Fixture = ReturnType<typeof fixture>;

function profileEnv(home: string): NodeJS.ProcessEnv {
  const drive = parse(home).root.replace(/[\\/]$/, "");
  return { HOME: home, USERPROFILE: home, HOMEDRIVE: drive, HOMEPATH: home.slice(drive.length) };
}

function runPostinstall(f: Fixture, globalRoot?: string, flags: NodeJS.ProcessEnv = {}, platform?: "win32") {
  const env: NodeJS.ProcessEnv = { ...process.env, ...profileEnv(f.home), INIT_CWD: f.initCwd };
  for (const key of [
    "PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_DB_PATH", "PI_SPIDER_SESSION_ID",
    "SPIDER_GLOBAL_ROOT", "VITEST", "VITEST_WORKER_ID", "VITEST_POOL_ID", "CI",
  ]) delete env[key];
  if (globalRoot !== undefined) env.SPIDER_GLOBAL_ROOT = globalRoot;
  Object.assign(env, flags);
  // Exercise the real script's Windows guard on every OS, using Windows absolute-path
  // semantics but keeping filesystem operations native and all writes in fixtures.
  const platformArgs = platform ? ["--import", `data:text/javascript,${encodeURIComponent(`
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    Object.defineProperty(process, "platform", { value: "win32" });
    path.isAbsolute = path.win32.isAbsolute;
    syncBuiltinESMExports();
  `)}`] : [];
  const result = spawnSync(process.execPath, [...platformArgs, join(repoRoot, "scripts/postinstall.mjs")], {
    cwd: f.cwd,
    env,
    encoding: "utf8",
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(readdirSync(f.cwd)).toEqual([]);
  expect(readdirSync(f.initCwd)).toEqual([]);
  return result;
}

async function dbCoreRoot(home: string, globalRoot?: string) {
  for (const [key, value] of Object.entries(profileEnv(home))) vi.stubEnv(key, value);
  vi.stubEnv("SPIDER_GLOBAL_ROOT", globalRoot);
  // Only read paths: no DB is opened, even for the default-root case.
  vi.stubEnv("VITEST", "");
  vi.resetModules();
  return (await import("../paths")).paths.globalRoot;
}

function expectBootstrap(root: string) {
  const dbPath = join(root, "spider.db");
  expect(existsSync(dbPath)).toBe(true);
  const db = new Database(dbPath, { readonly: true });
  try {
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  } finally {
    db.close();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("postinstall global DB bootstrap", () => {
  it("honours an absolute override without stray cwd writes and stays in sync with db-core", async () => {
    const f = fixture();
    const override = join(f.root, "override");
    const resolvedRoot = await dbCoreRoot(f.home, override);
    expect(resolvedRoot).toBe(override);
    runPostinstall(f, override);
    expectBootstrap(resolvedRoot);
    expect(readdirSync(f.home)).toEqual([]);
  });

  it.each(["relative-root", "~/override", " ", "\t \n"])("skips non-absolute override %j without writes", async (override) => {
    const f = fixture();
    // db-core deliberately does not trim or expand tilde, and resolves at runtime cwd.
    expect(await dbCoreRoot(f.home, override)).toBe(resolve(process.cwd(), override));
    const result = runPostinstall(f, override);
    expect(result.stderr).toContain("SPIDER_GLOBAL_ROOT is not absolute; skipped global DB bootstrap");
    expect(result.stderr).not.toContain("global DB file ready");
    expect(readdirSync(f.home)).toEqual([]);
    expect(readdirSync(f.root).sort()).toEqual(["consumer", "home", "package"]);
  });

  it.each(["\\", "/"])("skips Windows root-relative %j paths without writes", (separator) => {
    const f = fixture();
    // Even the pre-fix RED run can only create a path within this fixture.
    const override = `${f.root.replace(/^[A-Za-z]:/, "").replace(/^[\\/]+/, "")}/override`
      .replace(/[\\/]/g, separator);
    const rootRelativeOverride = separator + override;
    const result = runPostinstall(f, rootRelativeOverride, {}, "win32");
    expect(result.stderr).toContain("SPIDER_GLOBAL_ROOT is not absolute; skipped global DB bootstrap");
    expect(result.stderr).not.toContain("global DB file ready");
    expect(readdirSync(f.home)).toEqual([]);
    expect(readdirSync(f.root).sort()).toEqual(["consumer", "home", "package"]);
  });

  it("allows a fully qualified fixture root with Windows path semantics", () => {
    const f = fixture();
    const root = join(f.root, "override");
    // On POSIX, //checkout/... has Windows UNC semantics but still names our
    // native fixture. On Windows, the native fixture is already drive-qualified.
    const override = process.platform === "win32" ? root : `/${root}`;
    const result = runPostinstall(f, override, {}, "win32");
    expect(result.stderr).not.toContain("SPIDER_GLOBAL_ROOT is not absolute;");
    expectBootstrap(root);
    expect(readdirSync(f.home)).toEqual([]);
  });

  it.each([undefined, ""])("uses db-core's default when the override is %j", async (override) => {
    const f = fixture();
    const resolvedRoot = await dbCoreRoot(f.home, override);
    expect(resolvedRoot).toBe(f.defaultRoot);
    runPostinstall(f, override);
    expectBootstrap(resolvedRoot);
  });

  it("warns and exits zero when the bootstrap root is a regular file", () => {
    const f = fixture();
    const override = join(f.root, "afile");
    writeFileSync(override, "not a directory");
    const result = runPostinstall(f, override);
    expect(result.stderr).toContain("global DB file bootstrap skipped:");
    expect(result.stderr).not.toContain("global DB file ready");
    expect(readdirSync(f.home)).toEqual([]);
    expect(readdirSync(f.root).sort()).toEqual(["afile", "consumer", "home", "package"]);
  });

  it.each([
    { CI: "true" },
    { VITEST: "true" },
    { VITEST: "false" },
  ])("skips the entire bootstrap under %j", (flags) => {
    const f = fixture();
    const override = join(f.root, "override");
    const result = runPostinstall(f, override, flags);
    expect(result.stderr).toContain("global DB bootstrap skipped (");
    expect(existsSync(override)).toBe(false);
    expect(readdirSync(f.home)).toEqual([]);
  });

  it.each(["false", "1"])("does not treat CI=%s as a skip", (CI) => {
    const f = fixture();
    const override = join(f.root, "override");
    runPostinstall(f, override, { CI });
    expectBootstrap(override);
    expect(readdirSync(f.home)).toEqual([]);
  });
});
