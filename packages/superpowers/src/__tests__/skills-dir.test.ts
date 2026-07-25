import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { testScratchPath } from "./testutil.js";
import { baselineSkillsDir, projectSkillsDir, contributeSkillPaths } from "../skills-dir.js";

describe("skills-dir", () => {
  it("baselineSkillsDir points at the packaged skills with using-superpowers", () => {
    const d = baselineSkillsDir();
    expect(fs.existsSync(path.join(d, "using-superpowers", "SKILL.md"))).toBe(true);
  });
  it("contributeSkillPaths returns baseline only when no project skills dir exists", () => {
    const cwd = testScratchPath( `noskills-${process.pid}`);
    fs.mkdirSync(cwd, { recursive: true });
    expect(contributeSkillPaths(cwd)).toEqual([baselineSkillsDir()]);
  });
  it("contributeSkillPaths appends the project tier when .spider/skills exists", () => {
    const cwd = testScratchPath( `withskills-${process.pid}`);
    fs.mkdirSync(projectSkillsDir(cwd), { recursive: true });
    expect(contributeSkillPaths(cwd)).toEqual([baselineSkillsDir(), projectSkillsDir(cwd)]);
  });
});
