import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const skillsDir = path.resolve(process.env.SKILLS_GUARD_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills"));
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
  it("has exactly 14 upstream skills plus upstream-watch", () => {
    expect(fs.readdirSync(skillsDir).filter((name) => fs.statSync(path.join(skillsDir, name)).isDirectory()).sort()).toEqual(EXPECTED_15.sort());
  });
  it("ships the intended TDD, SDD, and writing-plans supporting files", () => {
    expect(fs.existsSync(path.join(skillsDir, "test-driven-development", "writing-good-tests.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, "test-driven-development", "testing-anti-patterns.md"))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, "subagent-driven-development", "re-review-prompt.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, "writing-plans", "plan-document-reviewer-prompt.md"))).toBe(false);
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

describe("all shipped skill files are Pi-portable", () => {
  type Rule = { name: string; pattern: RegExp };

  const contentRules: Rule[] = [
    { name: "claude-dispatch-header", pattern: /Subagent \(general-purpose\):/ },
    { name: "claude-general-purpose-agent", pattern: /(?:\b(?:agent|subagent)(?:\s+type|_type)?\b[^\n]{0,40}\bgeneral-purpose\b|\bgeneral-purpose\b[^\n]{0,40}\b(?:agent|subagent)(?:\s+type)?\b)/i },
    { name: "claude-call-syntax", pattern: /\b(?:Task|Agent|Skill)\(/ },
    { name: "claude-tool-name", pattern: /\b(?:Task|Agent|Skill) tool\b/ },
    { name: "claude-control-tool", pattern: /\b(?:TodoWrite|AskUserQuestion|EnterPlanMode|ExitPlanMode|EnterWorktree)\b/ },
    { name: "claude-capitalized-tool", pattern: /\b(?:Bash|Read|Write|Edit|Glob|Grep) tool\b/ },
    { name: "claude-dispatch-option", pattern: /\b(?:run_in_background|subagent_type)\b/ },
    { name: "claude-path-or-environment", pattern: /(?:\.claude(?:-plugin|\/)|\bCLAUDE\.md\b|\bCLAUDE_CODE_[A-Z0-9_]*\b|\bClaude Code\b)/i },
    { name: "non-pi-tool-mapping", pattern: /\b(?:claude-code|codex|copilot|gemini|antigravity|hermes|muse)-tools\.md\b/i },
    { name: "volatile-system-temp", pattern: /(?:\/var\/tmp(?:\/|\b)|\/tmp(?:\/|\b)|\$TMPDIR\b)/ },
    { name: "nonexistent-spider-wait", pattern: /\bspider wait\b/ },
  ];
  const pathRules: Rule[] = [
    { name: "claude-file-path", pattern: /(?:^|\/)(?:\.claude(?:-plugin)?|[^/]*CLAUDE(?:\.|_)MD[^/]*)/i },
    { name: "non-pi-tool-mapping-path", pattern: /(?:^|\/)(?:claude-code|codex|copilot|gemini|antigravity|hermes|muse)-tools\.md$/i },
    { name: "volatile-system-temp-path", pattern: /(?:^|\/)(?:tmp|var\/tmp)(?:\/|$)|\$TMPDIR\b/ },
  ];
  const exemptionMarker = /(?:<!--|#|\/\*|\/\/)\s*guard-allow:\s*prohibition\b/i;
  const prohibitionWording = /\b(?:never|do not|don't|must not|prohibit(?:ed|s)?|forbid(?:den)?|avoid)\b/i;
  const falseMessageLifecycle = /(?:\bspider message\b[^.!?\n]{0,240}\b(?:resume|restart|wake|redirect)\w*\b[^.!?\n]{0,240}\b(?:completed|finished|running|in-flight|child|subagent)\b|\b(?:completed|finished|running|in-flight|child|subagent)\b[^.!?\n]{0,240}\bspider message\b[^.!?\n]{0,240}\b(?:resume|restart|wake|redirect)\w*\b)/gi;
  const lifecycleNegation = /\b(?:does not|doesn't|cannot|can't|never|not)\s+(?:actually\s+)?(?:resume|restart|wake|redirect)\w*\b/i;

  function scan(root: string): string[] {
    const violations: string[] = [];

    for (const absolutePath of walk(root).sort()) {
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      for (const rule of pathRules) {
        if (rule.pattern.test(relativePath)) {
          violations.push(`${relativePath}:1 [${rule.name}] ${relativePath}`);
        }
      }

      const content = readFileSync(absolutePath, "utf8");
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const rule of contentRules) {
          if (!rule.pattern.test(line)) continue;
          const isMarkedProhibition = exemptionMarker.test(line) && prohibitionWording.test(line)
            && !/(?:=|:)\s*['"`]?(?:\/tmp|\/var\/tmp|\$TMPDIR)\b|\b(?:mkdir|cd|rm|touch|mktemp)\s+[^;]*(?:\/tmp|\/var\/tmp|\$TMPDIR)\b/.test(line);
          if (isMarkedProhibition && rule.name === "volatile-system-temp") continue;
          const excerpt = line.trim().replace(/\s+/g, " ").slice(0, 240);
          violations.push(`${relativePath}:${index + 1} [${rule.name}] ${excerpt}`);
        }
      });

      lines.forEach((line, index) => {
        if (index + 1 >= lines.length) return;
        const joined = `${line} ${lines[index + 1]}`;
        for (const match of joined.matchAll(falseMessageLifecycle)) {
          if (lifecycleNegation.test(match[0])) continue;
          // Single-line matches are already reported by the complete-content pass.
          if (match.index >= line.length || match.index + match[0].length <= line.length) continue;
          violations.push(`${relativePath}:${index + 1} [false-spider-message-resume] ${match[0].trim().replace(/\s+/g, " ").slice(0, 240)}`);
        }
      });

      for (const match of content.matchAll(falseMessageLifecycle)) {
        const excerpt = match[0].trim().replace(/\s+/g, " ").slice(0, 240);
        if (lifecycleNegation.test(excerpt)) continue;
        const line = content.slice(0, match.index).split(/\r?\n/).length;
        violations.push(`${relativePath}:${line} [false-spider-message-resume] ${excerpt}`);
      }
    }

    return violations;
  }

  it("has no forbidden path or textual content", () => {
    const violations = scan(skillsDir);
    if (violations.length > 0) {
      throw new Error(`Found ${violations.length} forbidden skill location(s):\n${violations.join("\n")}`);
    }
  });

  it("allows only marked prohibitions, not actual temporary-path uses or foreign tools", () => {
    const root = path.resolve(skillsDir, "../../../.spider/scratch/superpowers-sync/guard-fixture");
    fs.mkdirSync(root, { recursive: true });
    try {
      fs.writeFileSync(path.join(root, "examples.md"), [
        "Never use /tmp or $TMPDIR. <!-- guard-allow: prohibition -->",
        "Never use /tmp; const path = '/tmp/work'; <!-- guard-allow: prohibition -->",
        "Never use Task tool. <!-- guard-allow: prohibition -->",
        "spider message wakes a running child",
        "Ordinary task, agent, and skill. .superpowers/sdd/progress.md",
        "spider message can wake a",
        "completed child",
        "Never use /tmp without the marker.",
      ].join("\n"));
      const hits = scan(root);
      expect(hits.some((h) => h.includes("examples.md:1"))).toBe(false);
      expect(hits.some((h) => h.includes("examples.md:2") && h.includes("volatile-system-temp"))).toBe(true);
      expect(hits.some((h) => h.includes("examples.md:3") && h.includes("claude-tool-name"))).toBe(true);
      expect(hits.some((h) => h.includes("examples.md:4") && h.includes("false-spider-message-resume"))).toBe(true);
      expect(hits.some((h) => h.includes("examples.md:5"))).toBe(false);
      expect(hits.some((h) => h.includes("examples.md:6") && h.includes("false-spider-message-resume"))).toBe(true);
      expect(hits.some((h) => h.includes("examples.md:8") && h.includes("volatile-system-temp"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
