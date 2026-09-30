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
  it("tells the controller not to reset a ledger naming another plan", () => {
    expect(read("subagent-driven-development/SKILL.md")).toMatch(/names another plan, stop; do not reset, reuse or delete it/i);
  });
  it("describes Pi discovery above a non-git directory", () => {
    expect(read("using-superpowers/references/pi-tools.md")).toMatch(/filesystem root when not in a repo/);
    expect(read("using-superpowers/SKILL.md")).toMatch(/filesystem root when not in a repo/);
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
  it("sends the final pipeline report through the result, never child intercom", () => {
    expect(md).toMatch(/\{previous\}/);
    expect(md).toMatch(/cannot message or wake/);
    expect(md).not.toMatch(/wake the next stage \(reviewer\) via intercom/);
    const handoff = md.split("## Handoff on green")[1]?.split("## When Stuck")[0] ?? "";
    expect(handoff).not.toMatch(/via (?:spider message|intercom)/i);
  });
});

describe("dispatching-parallel-agents is spider-native", () => {
  const md = read("dispatching-parallel-agents/SKILL.md");
  it("names the async completion event and per-task thinking", () => {
    expect(md).toMatch(/spider\.subagent_done/);
    expect(md).toMatch(/each task[^\n]*thinking:|thinking:[^\n]*each task/i);
    const examples = md.split("\n").filter((line) => line.includes('agent: "worker"') && line.includes('task: "Fix'));
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) expect(example).toMatch(/thinking:/);
  });
});

describe("brainstorming guide", () => {
  it("links the visual companion relative to the skill directory", () => {
    const md = read("brainstorming/SKILL.md");
    expect(md).toContain("[visual-companion.md](visual-companion.md)");
  });
});

describe("requesting-code-review is spider-native", () => {
  const skill = read("requesting-code-review/SKILL.md");
  const tmpl = read("requesting-code-review/code-reviewer.md");
  it("requests review via spider run reviewer role", () => {
    expect(skill).toMatch(/spider run/);
    expect(skill).toMatch(/role:\s*"?reviewer"?|context:\s*"?fresh"?/);
  });
  it("states pipeline ordering, upstream rationalizations and safe worktree cleanup", () => {
    expect(skill).toMatch(/Use a pipeline only when the reviewer's task can be written up front/);
    expect(skill).toMatch(/reviewing the diff inline burns the context window/);
    expect(tmpl).toMatch(/git worktree remove --force/);
  });
  it("template drops old dispatch header and /tmp worktree", () => {
    expect(tmpl).not.toMatch(/Subagent \(general-purpose\):/);
    expect(tmpl).not.toMatch(/\/tmp\/review-/);
  });
});
