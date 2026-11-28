import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { coerce, getField, renderConfig } from "@spider/ui";
import { configValues, controlConfig } from "../control.js";
import { applyConfigEdit, applyConfigUnset } from "../control/config-cmd.js";
import { testScratchPath } from "../__tests__/testutil.js";
import { ACCENTS } from "./palette.js";

const scratch = testScratchPath("accent-config");
let root: string;
let project: string;
let global: string;
let oldGlobal: string;

beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "fixture-"));
  project = join(root, "project");
  global = join(root, "global");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", project]);
  mkdirSync(global);
  oldGlobal = paths.globalRoot;
  paths.globalRoot = global;
});
afterEach(() => {
  paths.globalRoot = oldGlobal;
  rmSync(root, { recursive: true, force: true });
});

describe("accent configuration", () => {
  it("declares the palette choices and default in the editable config view", () => {
    const field = getField("ui.accent");
    expect(field).toMatchObject({ type: "enum", default: "spider-blue", scope: "global" });
    expect(field?.enum).toEqual(ACCENTS.map(accent => accent.id));
    for (const accent of ACCENTS) expect(coerce(field!, accent.id)).toEqual({ ok: true, value: accent.id });
    expect(coerce(field!, "unknown").ok).toBe(false);
    const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s, glyph: "*" };
    expect(renderConfig(configValues(project, project, global).config, theme, 120, true).join("\n")).toContain("Accent");
  });

  it("edits valid global values, rejects invalid and local values, and unsets", () => {
    expect(applyConfigEdit(project, "ui.accent", "pink", "global")).toMatchObject({ ok: true, scope: "global" });
    expect(controlConfig("get", project, "ui.accent")).toBe("pink");
    expect(applyConfigEdit(project, "ui.accent", "unknown", "global").ok).toBe(false);
    expect(applyConfigEdit(project, "ui.accent", "red").ok).toBe(false);
    expect(() => controlConfig("set", project, "ui.accent", "unknown", "global")).toThrow();
    expect(JSON.parse(readFileSync(join(global, "config.json"), "utf8"))["ui.accent"]).toBe("pink");
    expect(applyConfigUnset(project, "ui.accent", "global").ok).toBe(true);
    expect(JSON.parse(readFileSync(join(global, "config.json"), "utf8"))["ui.accent"]).toBeUndefined();
    expect(controlConfig("get", project, "ui.accent")).toBe("spider-blue");
  });

  it.each(["unknown", null, 42])("falls back for invalid stored global value %s and ignores project overrides", value => {
    writeFileSync(join(global, "config.json"), JSON.stringify({ "ui.accent": value }));
    writeFileSync(join(project, "config.json"), JSON.stringify({ "ui.accent": "red" }));
    const result = configValues(project, project, global);
    expect(result.config["ui.accent"]).toBe("spider-blue");
    expect(result.sources["ui.accent"]).toBe("default");
    expect(result.errors.join("\n")).toContain("invalid ui.accent");
    expect(result.warnings.join("\n")).toContain("global scope only");
    writeFileSync(join(global, "config.json"), JSON.stringify({ "ui.accent": "green" }));
    const valid = configValues(project, project, global);
    expect(valid.config["ui.accent"]).toBe("green");
    expect(valid.sources["ui.accent"]).toBe("global");
  });
});
