// packages/host/src/__tests__/control.test.ts
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, existsSync, realpathSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests, paths, assertTestConfigPath } from "@spider/db-core";
import { controlDoctor, controlConfig } from "../control";
import { applyConfigEdit } from "../control/config-cmd";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync), writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync) };
});

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `ctrl-${process.pid}`);
function configFixture(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}
beforeEach(() => { mkdirSync(scratch, { recursive: true }); setGlobalDbPathForTests(join(scratch, `g-${Date.now()}.db`)); });
afterEach(() => { setGlobalDbPathForTests(null); rmSync(scratch, { recursive: true, force: true }); });

describe("control doctor", () => {
  it("reports native deps, DB health, sqlite-vec, and registry", () => {
    const dir = join(scratch, "proj"); mkdirSync(dir, { recursive: true });
    const res = controlDoctor(dir);
    const text = res.lines.join("\n");
    expect(text).toMatch(/better-sqlite3/);
    expect(text).toMatch(/sqlite-vec/);
    expect(text).toMatch(/migrations|schema/i);
    expect(text).toMatch(/registry/i);
    expect(typeof res.ok).toBe("boolean");
  });
});

describe("control config", () => {
  it("refuses a malformed global file without changing any bytes", () => {
    const dir = configFixture("bad-global");
    const previous = paths.globalRoot;
    paths.globalRoot = join(dir, "global");
    mkdirSync(paths.globalRoot, { recursive: true });
    const file = join(paths.globalRoot, "config.json");
    const original = '{"exec.enforce":false,"organism.enabled":false, }\n';
    writeFileSync(file, original);
    try {
      expect(() => controlConfig("set", dir, "models.defaults", { worker: "provider/model" }, "global")).toThrow(/config\.json.*parse|parse.*config\.json/i);
      expect(readFileSync(file, "utf8")).toBe(original);
      expect(readdirSync(paths.globalRoot)).toEqual(["config.json"]);
    } finally { paths.globalRoot = previous; }
  });

  it("writes a same-directory temporary config then renames it over the target", () => {
    const dir = configFixture("atomic-global");
    const previous = paths.globalRoot;
    paths.globalRoot = join(dir, "global");
    try {
      vi.mocked(renameSync).mockClear();
      controlConfig("set", dir, "models.defaults", { worker: "provider/model" }, "global");
      const file = join(paths.globalRoot, "config.json");
      expect(vi.mocked(renameSync)).toHaveBeenCalledWith(expect.stringMatching(/global\/config\.json\..+\.tmp$/), file);
      expect(JSON.parse(readFileSync(file, "utf8"))["models.defaults"]).toEqual({ worker: "provider/model" });
    } finally { paths.globalRoot = previous; }
  });

  it.each(["local", "global"] as const)("unsets a model id in %s by removing it, not storing unlimited", (scope) => {
    const dir = configFixture(`unset-model-${scope}`);
    const previous = paths.globalRoot;
    paths.globalRoot = join(dir, "global");
    try {
      controlConfig("set", dir, "memory.reviewer.model", "provider/global", "global");
      controlConfig("set", dir, "memory.reviewer.model", "provider/local");
      controlConfig("unset", dir, "memory.reviewer.model", undefined, scope);
      const file = join(scope === "global" ? paths.globalRoot : paths.projectRoot(dir), "config.json");
      expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("memory.reviewer.model");
      expect(controlConfig("get", dir, "memory.reviewer.model")).toBe(scope === "global" ? "provider/local" : "provider/global");
    } finally { paths.globalRoot = previous; }
  });

  it.each(["set", "unset"] as const)("rejects an invalid writer scope for %s before creating a config directory", (op) => {
    const dir = configFixture(`bad-scope-${op}`);
    const localRoot = paths.projectRoot(dir);
    expect(() => controlConfig(op, dir, "ui.footer", false, "globla" as never)).toThrow(/scope.*global.*local|scope.*local.*global/i);
    expect(existsSync(localRoot)).toBe(false);
  });

  it("returns a default when unset, then round-trips a set", () => {
    const dir = configFixture("cfg");
    controlConfig("set", dir, "ui.footer", true);
    expect(controlConfig("get", dir, "ui.footer")).toBe(true);
    controlConfig("set", dir, "ui.footer", false);
    expect(controlConfig("get", dir, "ui.footer")).toBe(false);
  });

  it("rejects config reads and writes through a symlink escaping the fixture", () => {
    const dir = configFixture("symlink-escape");
    // Sibling of scratch, not a real config and not inside any allowed fixture root.
    const outside = join(scratch, "..", "..", `ctrl-outside-${process.pid}`);
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(dir, ".spider"), "dir");
    expect(paths.projectRoot(dir)).toBe(join(dir, ".spider"));
    expect(realpathSync(join(dir, ".spider"))).toBe(realpathSync(outside));
    expect(() => assertTestConfigPath(join(paths.projectRoot(dir), "config.json"))).toThrow(/config: refusing/);
    const mkdir = vi.mocked(mkdirSync);
    const write = vi.mocked(writeFileSync);
    try {
      for (const [name, action] of [
        ["get", () => controlConfig("get", dir, "ui.footer")],
        ["set", () => controlConfig("set", dir, "ui.footer", false)],
        ["unset", () => controlConfig("unset", dir, "ui.footer")],
        ["edit", () => applyConfigEdit(dir, "ui.footer", "false")],
      ] as const) {
        mkdir.mockClear(); write.mockClear();
        expect(action, name).toThrow(/config: refusing path outside a Vitest fixture/);
        expect(mkdir).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(existsSync(join(outside, "config.json"))).toBe(false);
      }
    } finally {
      mkdir.mockClear(); write.mockClear();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps legacy UI keys loadable without inventing a configurable grid shortcut", () => {
    const dir = configFixture("legacy-ui");
    expect(controlConfig("get", dir, "ui.grid_hotkey")).toBeUndefined();
    controlConfig("set", dir, "ui.gridHotkey", "ctrl+g");
    controlConfig("set", dir, "ui.theme", "dark");
    expect(controlConfig("get", dir, "ui.gridHotkey")).toBe("ctrl+g");
    expect(controlConfig("get", dir, "ui.theme")).toBe("dark");
  });

  it("get with no key returns the merged config object", () => {
    const dir = configFixture("cfg2");
    const all = controlConfig("get", dir) as Record<string, unknown>;
    expect(typeof all).toBe("object");
  });
});
