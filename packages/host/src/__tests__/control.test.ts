// packages/host/src/__tests__/control.test.ts
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests, paths, assertTestConfigPath } from "@spider/db-core";
import { controlDoctor, controlConfig } from "../control";
import { applyConfigEdit } from "../control/config-cmd";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync), writeFileSync: vi.fn(actual.writeFileSync) };
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

  it("get with no key returns the merged config object", () => {
    const dir = configFixture("cfg2");
    const all = controlConfig("get", dir) as Record<string, unknown>;
    expect(typeof all).toBe("object");
  });
});
