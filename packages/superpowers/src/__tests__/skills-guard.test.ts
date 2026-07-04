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
const EXPECTED_15 = [...EXPECTED_14, "upstream-watch"];
describe("skills vendoring guard", () => {
  it("contains the 14 upstream skills, each with a SKILL.md", () => {
    for (const name of EXPECTED_14) {
      expect(fs.existsSync(path.join(skillsDir, name, "SKILL.md")), `${name}/SKILL.md`).toBe(true);
    }
  });
  it("contains the upstream-watch skill", () => {
    expect(fs.existsSync(path.join(skillsDir, "upstream-watch", "SKILL.md"))).toBe(true);
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

describe("pi-tools.md leads with spider verbs", () => {
  const md = readFileSync(path.join(skillsDir, "using-superpowers", "references", "pi-tools.md"), "utf8");
  it("maps actions to the spider mega-tool", () => {
    for (const verb of ["spider search", "spider run", "spider exec", "spider remember", "spider todo"]) {
      expect(md.includes(verb), `mentions ${verb}`).toBe(true);
    }
  });
  it("does not present ctx_* / pi-subagents / pi-todo-sqlite as separate installs", () => {
    expect(md).not.toMatch(/If the `context-mode` package is installed/);
    expect(md).not.toMatch(/from `pi-subagents`/);
    expect(md).not.toMatch(/`pi-todo-sqlite`/);
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

describe("no residual non-pi dispatch syntax or broken tool-ref links", () => {
  const files = walk(skillsDir).filter((f) => /\.(md|sh|cjs)$|sdd-workspace$/.test(f));
  it("has no `Subagent (general-purpose):` dispatch header anywhere", () => {
    const hits = files.filter((f) => readFileSync(f, "utf8").includes("Subagent (general-purpose):"));
    expect(hits).toEqual([]);
  });
  it("has no markdown links to the deleted per-harness tool refs", () => {
    const banned = /\]\([^)]*(claude-code|codex|copilot|gemini|antigravity)-tools\.md\)/;
    const hits = files.filter((f) => banned.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
