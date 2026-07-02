// packages/host/src/__tests__/control.test.ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests } from "@spider/db-core";
import { controlDoctor, controlConfig } from "../control.js";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch");
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
    const dir = join(scratch, "cfg"); mkdirSync(dir, { recursive: true });
    controlConfig("set", dir, "ui.footer", true);
    expect(controlConfig("get", dir, "ui.footer")).toBe(true);
    controlConfig("set", dir, "ui.footer", false);
    expect(controlConfig("get", dir, "ui.footer")).toBe(false);
  });

  it("get with no key returns the merged config object", () => {
    const dir = join(scratch, "cfg2"); mkdirSync(dir, { recursive: true });
    const all = controlConfig("get", dir) as Record<string, unknown>;
    expect(typeof all).toBe("object");
  });
});
