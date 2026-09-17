import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { paths } from "@spider/db-core";
import { readOrganismConfig } from "@spider/organism";
import { controlConfig } from "../control.js";

// G3a: control.ts's DEFAULTS injects a literal top-level "organism.enabled": true.
// readOrganismConfig's dottedOrNested treats ANY defined dotted leaf (including
// this injected default) as an explicit user choice, so a real nested
// {"organism":{"enabled":false}} in project config.json is silently defeated —
// the organism keeps running with the master switch reported "off" by the user.

const scratch = resolve(".spider/scratch/config-precedence");
const roots: string[] = [];
let originalGlobalRoot: string;

beforeEach(() => {
  originalGlobalRoot = paths.globalRoot;
  mkdirSync(scratch, { recursive: true });
  // Isolated global config root — this test must never read/write the real
  // ~/.pi/agent/spider config.json, even though the file did not previously exist.
  const isolatedGlobal = mkdtempSync(join(scratch, "global-"));
  roots.push(isolatedGlobal);
  paths.globalRoot = isolatedGlobal;
});
afterEach(() => {
  paths.globalRoot = originalGlobalRoot;
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureProject(): string {
  const dir = mkdtempSync(join(scratch, "project-"));
  roots.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

function writeProjectConfig(cwd: string, config: Record<string, unknown>): void {
  const projRoot = join(cwd, ".spider");
  mkdirSync(projRoot, { recursive: true });
  writeFileSync(join(projRoot, "config.json"), JSON.stringify(config, null, 2));
}

describe("organism config precedence — master enable switch (G3a)", () => {
  it("a nested organism.enabled:false in project config.json is not defeated by an injected flat default", () => {
    const cwd = fixtureProject();
    writeProjectConfig(cwd, { organism: { enabled: false } });
    const cfg = controlConfig("get", cwd);
    expect(readOrganismConfig(cfg).enabled).toBe(false);
  });

  it("an explicit dotted organism.enabled override still wins over a conflicting nested value", () => {
    const cwd = fixtureProject();
    writeProjectConfig(cwd, { organism: { enabled: true } });
    controlConfig("set", cwd, "organism.enabled", false);
    expect(readOrganismConfig(controlConfig("get", cwd)).enabled).toBe(false);
  });

  it("an explicit dotted organism.enabled=true override still wins over a nested false", () => {
    const cwd = fixtureProject();
    writeProjectConfig(cwd, { organism: { enabled: false } });
    controlConfig("set", cwd, "organism.enabled", true);
    expect(readOrganismConfig(controlConfig("get", cwd)).enabled).toBe(true);
  });

  it("with no organism config at all, the master switch still defaults to enabled", () => {
    const cwd = fixtureProject();
    expect(readOrganismConfig(controlConfig("get", cwd)).enabled).toBe(true);
  });

  it("other organism/curator keys are unaffected by the fix (nested passes still honored)", () => {
    const cwd = fixtureProject();
    writeProjectConfig(cwd, { organism: { passes: { reflection: false } } });
    const cfg = readOrganismConfig(controlConfig("get", cwd));
    expect(cfg.passes.reflection).toBe(false);
    expect(cfg.passes.learning).toBe(true);
  });
});
