import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testScratchPath } from "./testutil.js";
import { baselineSkillsDir, projectSkillsDir, contributeSkillPaths } from "../skills-dir.js";

describe("skills-dir", () => {
  it.each(["dev", "bundle"])("discovers every bundled collection in an isolated %s layout", layout => {
    const root = fs.mkdtempSync(testScratchPath(`layout-${layout}-`));
    const modulePath = path.join(root, layout === "dev" ? "packages/superpowers/src/skills-dir.ts" : "dist/extension.ts");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.copyFileSync(fileURLToPath(new URL("../skills-dir.ts", import.meta.url)), modulePath);
    const superpowers = path.join(root, "packages/superpowers/skills");
    const pstack = path.join(root, "packages/pstack/skills");
    const intercom = path.join(root, "packages/intercom/skills");
    for (const [dir, probe] of [[superpowers, "using-superpowers"], [pstack, "how"], [intercom, "pi-intercom"]]) {
      fs.mkdirSync(path.join(dir, probe), { recursive: true });
      fs.writeFileSync(path.join(dir, probe, "SKILL.md"), "# Probe");
    }
    // A directory without how/SKILL.md must not win over the bundle candidate.
    if (layout === "bundle") {
      fs.mkdirSync(path.resolve(root, "..", "pstack/skills"), { recursive: true });
      fs.mkdirSync(path.resolve(root, "..", "intercom/skills"), { recursive: true });
    }
    const output = execFileSync(process.execPath, ["--input-type=module", "-e",
      `const { contributeSkillPaths } = await import(${JSON.stringify(pathToFileURL(modulePath).href)}); console.log(JSON.stringify(contributeSkillPaths(${JSON.stringify(root)})));`,
    ], { encoding: "utf8" });
    expect(JSON.parse(output)).toEqual([superpowers, pstack, intercom]);
  });

  it("baselineSkillsDir points at the packaged skills with using-superpowers", () => {
    const d = baselineSkillsDir();
    expect(fs.existsSync(path.join(d, "using-superpowers", "SKILL.md"))).toBe(true);
  });
  it("contributeSkillPaths returns every bundled collection when no project skills dir exists", () => {
    const cwd = testScratchPath( `noskills-${process.pid}`);
    fs.mkdirSync(cwd, { recursive: true });
    expect(contributeSkillPaths(cwd)).toEqual([baselineSkillsDir(), path.resolve("packages/pstack/skills"), path.resolve("packages/intercom/skills")]);
  });
  it("contributeSkillPaths appends the project tier when .spider/skills exists", () => {
    const cwd = testScratchPath( `withskills-${process.pid}`);
    fs.mkdirSync(projectSkillsDir(cwd), { recursive: true });
    expect(contributeSkillPaths(cwd)).toEqual([baselineSkillsDir(), path.resolve("packages/pstack/skills"), path.resolve("packages/intercom/skills"), projectSkillsDir(cwd)]);
  });
});
