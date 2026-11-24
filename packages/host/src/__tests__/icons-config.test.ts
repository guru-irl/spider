import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { paths } from "@spider/db-core";
import { coerce, getField, renderConfig } from "@spider/ui";
import { configValues, controlConfig } from "../control.js";

const scratch = resolve(".spider/scratch/icons-config");
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

const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s, glyph: "🕸" };

describe("icon style configuration", () => {
  it("defaults to text and appears in the config view", () => {
    const values = configValues(project, project, global);
    expect(values.config["ui.icons"]).toBe("text");
    const view = renderConfig(values.config, theme, 120, true).join("\n");
    expect(view).toContain("Icon style");
    expect(view).toContain("text");
  });

  it("accepts nerd and rejects other enum values", () => {
    const field = getField("ui.icons");
    expect(field).toBeDefined();
    expect(coerce(field!, "nerd")).toEqual({ ok: true, value: "nerd" });
    expect(coerce(field!, "emoji").ok).toBe(false);
    expect(() => controlConfig("set", project, "ui.icons", "emoji")).toThrow();
    controlConfig("set", project, "ui.icons", "nerd");
    expect(controlConfig("get", project, "ui.icons")).toBe("nerd");
  });

  it("uses valid local and global values and reports invalid file values", () => {
    writeFileSync(join(global, "config.json"), JSON.stringify({ "ui.icons": "nerd" }));
    expect(configValues(project, project, global).config["ui.icons"]).toBe("nerd");
    writeFileSync(join(project, "config.json"), JSON.stringify({ "ui.icons": "invalid" }));
    const values = configValues(project, project, global);
    expect(values.config["ui.icons"]).toBe("nerd");
    expect(values.errors.join("\n")).toContain("ui.icons");
    writeFileSync(join(project, "config.json"), JSON.stringify({ "ui.icons": "text" }));
    expect(configValues(project, project, global).config["ui.icons"]).toBe("text");
  });
});
