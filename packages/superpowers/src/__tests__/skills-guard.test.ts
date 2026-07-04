import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}
const EXPECTED_14 = ["brainstorming","dispatching-parallel-agents","executing-plans","finishing-a-development-branch","receiving-code-review","requesting-code-review","subagent-driven-development","systematic-debugging","test-driven-development","using-git-worktrees","using-superpowers","verification-before-completion","writing-plans","writing-skills"];
describe("skills vendoring guard", () => {
  it("contains the 14 upstream skills, each with a SKILL.md", () => {
    for (const name of EXPECTED_14) {
      expect(fs.existsSync(path.join(skillsDir, name, "SKILL.md")), `${name}/SKILL.md`).toBe(true);
    }
  });
  it("keeps ONLY pi-tools.md under using-superpowers/references", () => {
    const refs = path.join(skillsDir, "using-superpowers", "references");
    const files = fs.readdirSync(refs).sort();
    expect(files).toEqual(["pi-tools.md"]);
  });
  it("has no non-pi harness reference-tool files anywhere", () => {
    const banned = /(claude-code|codex|copilot|gemini|antigravity)-tools\.md$/;
    expect(walk(skillsDir).filter((f) => banned.test(f))).toEqual([]);
  });
  it("has no cross-harness plugin/hook artifacts", () => {
    const banned = /(\.claude-plugin|\.codex-plugin|\.cursor-plugin|\.kimi-plugin|\.opencode|GEMINI\.md|gemini-extension\.json|hooks-codex\.json|hooks-cursor\.json)/;
    expect(walk(skillsDir).filter((f) => banned.test(f))).toEqual([]);
  });
});

describe("using-superpowers is pi-only (v6.1.0)", () => {
  const md = readFileSync(path.join(skillsDir, "using-superpowers", "SKILL.md"), "utf8");
  it("drops all non-pi harness prose", () => {
    for (const harness of ["Claude Code", "Codex", "Copilot CLI", "Gemini CLI", "OpenCode", "Antigravity"]) {
      expect(md.includes(harness), `mentions ${harness}`).toBe(false);
    }
  });
  it("references only pi-tools.md", () => {
    const refLinks = [...md.matchAll(/references\/([a-z-]+)\.md/g)].map((m) => m[1]).sort();
    expect(new Set(refLinks)).toEqual(new Set(["pi-tools"]));
  });
  it("keeps the invocation rule and red-flags table", () => {
    expect(md).toMatch(/1% chance/i);
    expect(md).toMatch(/Red Flags/i);
  });
});
