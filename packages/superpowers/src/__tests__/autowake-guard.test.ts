import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");
const read = (rel: string) => readFileSync(path.join(skillsDir, rel), "utf8");
const AUTOWAKE_SKILLS = [
  "subagent-driven-development/SKILL.md",
  "test-driven-development/SKILL.md",
  "dispatching-parallel-agents/SKILL.md",
  "requesting-code-review/SKILL.md",
];
describe("auto-wake rewrite guard", () => {
  it("subagent-driven-development uses spider run + intercom handoff", () => {
    const md = read("subagent-driven-development/SKILL.md");
    expect(md).toMatch(/spider run/);
    expect(md).toMatch(/handoff:\s*"?intercom"?/);
    expect(md).not.toMatch(/Subagent \(general-purpose\):/);
  });
  it("no auto-wake skill fabricates the old Task/Subagent dispatch syntax", () => {
    for (const rel of AUTOWAKE_SKILLS) {
      const md = read(rel);
      expect(md, rel).not.toMatch(/Subagent \(general-purpose\):/);
    }
  });
});

describe("test-driven-development is spider-native", () => {
  const md = read("test-driven-development/SKILL.md");
  it("runs suites via spider exec and preserves the Iron Law", () => {
    expect(md).toMatch(/spider exec/);
    expect(md).toMatch(/NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST/);
  });
  it("notes intercom hand-off on green", () => {
    expect(md).toMatch(/handoff|intercom|wake/i);
  });
});

describe("dispatching-parallel-agents is spider-native", () => {
  const md = read("dispatching-parallel-agents/SKILL.md");
  it("uses spider run parallel form", () => {
    expect(md).toMatch(/spider run/);
    expect(md).toMatch(/tasks:\s*\[|parallel/i);
  });
});

describe("requesting-code-review is spider-native", () => {
  const skill = read("requesting-code-review/SKILL.md");
  const tmpl = read("requesting-code-review/code-reviewer.md");
  it("requests review via spider run reviewer role", () => {
    expect(skill).toMatch(/spider run/);
    expect(skill).toMatch(/role:\s*"?reviewer"?|context:\s*"?fresh"?/);
  });
  it("template drops old dispatch header and /tmp worktree", () => {
    expect(tmpl).not.toMatch(/Subagent \(general-purpose\):/);
    expect(tmpl).not.toMatch(/\/tmp\/review-/);
  });
});
