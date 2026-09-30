import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { testScratchPath } from "./testutil.js";
const skillsDir = path.resolve(process.env.SKILLS_GUARD_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills"));
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.name === ".git" && e.isDirectory()) continue;
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}
const EXPECTED_14 = ["brainstorming","dispatching-parallel-agents","executing-plans","finishing-a-development-branch","receiving-code-review","requesting-code-review","subagent-driven-development","systematic-debugging","test-driven-development","using-git-worktrees","using-superpowers","verification-before-completion","writing-plans","writing-skills"];
const EXPECTED_15 = [...EXPECTED_14, "upstream-watch"];
describe("skills vendoring guard", () => {
  it("contains all 15 shipped skills, each with a SKILL.md", () => {
    for (const name of EXPECTED_15) {
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
    { name: "claude-dispatch-option", pattern: /\b(?:run_in_background|subagent_type|spawn_agent|wait_agent|send_input|close_agent)\b/ },
    { name: "claude-path-or-environment", pattern: /(?:\.claude(?:-plugin|\/)|\bCLAUDE\.md\b|\bCLAUDE_[A-Z0-9_]+\b|\bClaude Code\b)/i },
    { name: "non-pi-tool-mapping", pattern: /\b(?:claude-code|codex|copilot|gemini|antigravity|hermes|muse)-tools\.md\b/i },
    { name: "volatile-system-temp", pattern: /(?:\/var\/tmp(?:\/|\b)|\/tmp(?:\/|\b)|\$\{?(?:TMPDIR|TMP|TEMP)\}?(?![A-Za-z0-9_]))/ },
    { name: "nonexistent-spider-wait", pattern: /\bspider\s+wait\b/ },
  ];
  const pathRules: Rule[] = [
    { name: "claude-file-path", pattern: /(?:^|\/)(?:\.claude(?:-plugin)?|[^/]*CLAUDE(?:\.|_)MD[^/]*)/i },
    { name: "non-pi-tool-mapping-path", pattern: /(?:^|\/)(?:claude-code|codex|copilot|gemini|antigravity|hermes|muse)-tools\.md$/i },
    { name: "volatile-system-temp-path", pattern: /(?:^|\/)(?:tmp|var\/tmp)(?:\/|$)|\$TMPDIR\b/ },
  ];
  const exemptionMarker = /(?:<!--|#|\/\*|\/\/)\s*guard-allow:\s*prohibition\b/i;
  const tempCalls: Rule = { name: "volatile-system-temp", pattern: /\b(?:mktemp|mkdtemp\(|(?:os\.)?tmpdir\(\)|gettempdir\(|process\.env\.(?:TMPDIR|TMP|TEMP)\b)|\/var\/folders\// };
  const prohibitedTempCall = /\b(?:never|do not|don't|must not|avoid)\s+(?:use\s+)?(?:mktemp|mkdtemp\(|(?:os\.)?tmpdir\(\)|gettempdir\()/gi;
  const tempToken = String.raw`(?:\/var\/tmp(?:\/|\b)|\/tmp(?:\/|\b)|\$\{?(?:TMPDIR|TMP|TEMP)\}?(?![A-Za-z0-9_]))`;
  const governedTemp = new RegExp(String.raw`\b(?:never|do not|don't|must not|avoid)\b\s*(?:(?:use|write\s+to|in)\s+)?[\s` + "`" + String.raw`'"(*]*` + tempToken + String.raw`(?:[` + "`" + String.raw`'")*]*\s*(?:,\s*)?(?:(?:or|and)\s+)?[` + "`" + String.raw`'"(*]*` + tempToken + String.raw`)*`, "gi");
  const messageSubject = /\b(?:completed|finished|running|in-flight|child|children|subagent)\b/i;
  const claimVerb = /\b(?:resume|restart|wake|redirect)\w*\b/gi;
  const lifecycleNegation = /\b(?:does not|doesn't|cannot|can't|never|not)\b/i;
  const paragraphRules = contentRules.filter((rule) => ["claude-tool-name", "claude-capitalized-tool", "claude-path-or-environment", "nonexistent-spider-wait"].includes(rule.name));

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
        for (const rule of [...contentRules, ...(/\.(?:md|sh|bash|js|mjs|cjs|ts|py|html)$|(?:^|\/)[^/.]+$/.test(relativePath) ? [tempCalls] : [])]) {
          if (!rule.pattern.test(line)) continue;
          if (rule === tempCalls && /\.md$/.test(relativePath)) {
            const tokens = [...line.matchAll(new RegExp(rule.pattern.source, "g"))];
            const governed = [...line.matchAll(prohibitedTempCall)].map((match) =>
              (match.index ?? 0) + match[0].search(rule.pattern));
            if (tokens.every((token) => governed.includes(token.index ?? -1))) continue;
          }
          if (rule !== tempCalls && rule.name === "volatile-system-temp" && exemptionMarker.test(line)) {
            const tokens = [...line.matchAll(new RegExp(rule.pattern.source, "g"))];
            const governed = [...line.matchAll(governedTemp)].flatMap((match) =>
              [...match[0].matchAll(new RegExp(rule.pattern.source, "g"))].map((token) => (match.index ?? 0) + (token.index ?? 0)));
            if (tokens.length && tokens.every((token) => governed.includes(token.index ?? -1))) continue;
          }
          const excerpt = line.trim().replace(/\s+/g, " ").slice(0, 240);
          violations.push(`${relativePath}:${index + 1} [${rule.name}] ${excerpt}`);
        }
      });

      // Collapse line wraps within a paragraph without joining unrelated paragraphs.
      for (const paragraph of content.matchAll(/[^\r\n]+(?:\r?\n(?!\s*\r?\n)[^\r\n]+)*/g)) {
        const firstLine = content.slice(0, paragraph.index).split(/\r?\n/).length;
        // Markdown lists and tables are separate assertions, not a single paragraph claim.
        for (const item of paragraph[0].replace(/\r?\n(?=\s*(?:[-*+]\s|\d+\.\s|\|))/g, "\u0000").split("\u0000")) {
          const text = item.replace(/<!--[^]*?-->/g, " ").replace(/&nbsp;|&#(?:160|xA0);/gi, " ")
            .replace(/[\u200b-\u200d\ufeff]/g, "").replace(/[`*_]/g, "").replace(/\s+/g, " ");
          for (const rule of paragraphRules) {
            if (rule.pattern.test(text) && !item.split(/\r?\n/).some((line) => rule.pattern.test(line))) {
              violations.push(`${relativePath}:${firstLine} [${rule.name}] ${text.slice(0, 240)}`);
            }
          }
          for (const sentence of text.split(/[.!?](?=\s|$)/)) {
            if (!/\bspider\s+message\b/i.test(sentence) || !messageSubject.test(sentence)) continue;
            for (const verb of sentence.matchAll(claimVerb)) {
              const prefix = sentence.slice(0, verb.index);
              if (lifecycleNegation.test(prefix.slice(-80)) &&
                  /(?:does not|doesn't|cannot|can't|never|not)\s+$|\bcannot be\s+\w+\s+or\s+$|\b(?:cannot|does not)\s+[^;,.]*\s+or\s+$/.test(prefix)) continue;
              violations.push(`${relativePath}:${firstLine} [false-spider-message-resume] ${sentence.trim().slice(0, 240)}`);
              break;
            }
          }
        }
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

  it("pins the single marked prohibition in the shipped skills", () => {
    const marked = walk(skillsDir).flatMap((file) => readFileSync(file, "utf8").split(/\r?\n/)
      .filter((line) => exemptionMarker.test(line)).map(() => path.relative(skillsDir, file)));
    expect(marked).toEqual(["requesting-code-review/code-reviewer.md"]);
  });

  it("allows only marked prohibitions, not actual temporary-path uses or foreign tools", () => {
    const root = testScratchPath(`guard-fixture-${process.pid}`);
    fs.mkdirSync(root, { recursive: true });
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    try {
      fs.writeFileSync(path.join(root, "examples.md"), [
        "Never use /tmp or $TMPDIR. <!-- guard-allow: prohibition -->",
        "Never use /tmp; const path = '/tmp/work'; <!-- guard-allow: prohibition -->",
        "Never use Task tool. <!-- guard-allow: prohibition -->",
        "spider message wakes a running child",
        "Ordinary task, agent, and skill. .superpowers/sdd/progress.md",
        "spider message can wake a\ncompleted child",
        "Never use /tmp without the marker.",
      ].join("\n\n"));
      const hits = scan(root);
      expect(hits.some((h) => h.startsWith("examples.md:1 ")), hits.join("\n")).toBe(false);
      expect(hits.some((h) => h.includes("examples.md:3") && h.includes("volatile-system-temp"))).toBe(true);
      expect(hits.some((h) => h.includes("examples.md:5") && h.includes("claude-tool-name"))).toBe(true);
      expect(hits.some((h) => h.includes("examples.md:7") && h.includes("false-spider-message-resume"))).toBe(true);
      expect(hits.some((h) => h.includes("examples.md:9"))).toBe(false);
      expect(hits.some((h) => h.includes("examples.md:11") && h.includes("false-spider-message-resume"))).toBe(true);
      expect(hits.some((h) => h.includes("examples.md:14") && h.includes("volatile-system-temp"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects marked use, indirect negation, and unmarked temp idioms", () => {
    const root = testScratchPath(`guard-mutants-${process.pid}`);
    fs.mkdirSync(root, { recursive: true });
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    try {
      const mutants: [string, string, string][] = [
        ["cp.md", "cp report.md /tmp/report.md # guard-allow: prohibition (avoid clobber)", "volatile-system-temp"],
        ["redirect.md", "echo hi > /var/tmp/x.log # guard-allow: prohibition never", "volatile-system-temp"],
        ["worktree.md", "git worktree add /tmp/review HEAD, do not skip review. <!-- guard-allow: prohibition -->", "volatile-system-temp"],
        ["worry.md", "Use $TMPDIR for logs; don't worry. <!-- guard-allow: prohibition -->", "volatile-system-temp"],
        ["compound.md", "Never use /tmp; write logs to /var/tmp/run. <!-- guard-allow: prohibition -->", "volatile-system-temp"],
        ...[
          "Do not use /tmp, write logs to /var/tmp/logs or /tmp/cache instead.",
          "Never use /tmp for artifacts, cp build output to /var/tmp/out and /tmp/x",
          "Avoid /tmp? No! Always write to /var/tmp/out and /tmp/out",
          "The old rule 'never use /tmp' is obsolete, use /tmp/work and /var/tmp freely",
          "Don't use /tmp unless you want speed, and /tmp/fast is fine then",
          "Never use /tmp, create the dir with mktemp -d and /var/tmp/x as fallback",
          "# Never use /tmp or $TMPDIR, prefer mktemp -d and /var/tmp",
        ].map((text, i): [string, string, string] => [`chain-${i}.md`, `${text} <!-- guard-allow: prohibition -->`, "volatile-system-temp"]),
        ["marked-call.sh", "# Never use /tmp; mktemp -d # guard-allow: prohibition", "volatile-system-temp"],
        ["node.ts", "process.env.TMPDIR", "volatile-system-temp"],
        ["node.mjs", "os.tmpdir()", "volatile-system-temp"],
        ["node.html", "<script>os.tmpdir()</script>", "volatile-system-temp"],
        ["shell.bash", "mktemp -d", "volatile-system-temp"],
        ["python.py", "tempfile.mkdtemp()", "volatile-system-temp"],
        ["gettemp.cjs", "tempfile.gettempdir()", "volatile-system-temp"],
        ["naked-tool", "mktemp -d", "volatile-system-temp"],
        ["emphasis.md", "Use **Task** tool; _Task_ tool; Task <!-- x --> tool", "claude-tool-name"],
        ["entity.md", "Use Claude&nbsp;Code", "claude-path-or-environment"],
        ["em-wait.md", "Call spider **wait**", "nonexistent-spider-wait"],
        ["verb-first.md", "To resume a completed child, use spider message.", "false-spider-message-resume"],
        ["neg-other.md", "spider message does not need a peer name and resumes the completed child.", "false-spider-message-resume"],
        ["neg-after.md", "spider message resumes and does not just ping the completed child.", "false-spider-message-resume"],
        ["mixed-neg.md", "spider message cannot restart a crashed child, but it resumes a finished one.", "false-spider-message-resume"],
        ["also.md", "spider message is not only for peers; it also resumes completed children.", "false-spider-message-resume"],
        ["braces.sh", "printf '%s' \"${TMPDIR}/brainstorm\"", "volatile-system-temp"],
        ["tmp.sh", "printf '%s' \"$TMP\"", "volatile-system-temp"],
        ["temp.sh", "printf '%s' \"$TEMP\"", "volatile-system-temp"],
        ["mktemp.sh", "mktemp -d", "volatile-system-temp"],
        ["mktemp.md", "Run mktemp -d for the working copy.", "volatile-system-temp"],
        ["node.cjs", "os.tmpdir()", "volatile-system-temp"],
        ["node.md", "Use os.tmpdir() for scratch.", "volatile-system-temp"],
        ["plain.js", "tmpdir()", "volatile-system-temp"],
        ["task.md", "Use the `Task`\ntool to dispatch.", "claude-tool-name"],
        ["skill.md", "Use the `Skill` tool to load.", "claude-tool-name"],
        ["claude.md", "Use Claude\nCode to review.", "claude-path-or-environment"],
        ["plugin.md", "Use CLAUDE_PLUGIN_ROOT", "claude-path-or-environment"],
        ["agent.md", "Call spawn_agent and wait_agent", "claude-dispatch-option"],
        ["waiting.md", "Call spider  wait", "nonexistent-spider-wait"],
        ["message-three.md", "spider message can\nwake the\ncompleted child", "false-spider-message-resume"],
        ["message-file.md", "spider message (see pi-tools.md) resumes the completed child", "false-spider-message-resume"],
        ["message-negation.md", "spider message resumes a completed child but does not redirect a running child.", "false-spider-message-resume"],
      ];
      for (const [name, text, rule] of mutants) {
        const file = path.join(root, name);
        fs.writeFileSync(file, text);
        expect(scan(root).some((hit) => hit.startsWith(`${name}:`) && hit.includes(`[${rule}]`)), name).toBe(true);
        fs.unlinkSync(file);
      }
      fs.writeFileSync(path.join(root, "safe.md"), [
        "spider message cannot resume a completed child.",
        "Never use /tmp. <!-- guard-allow: prohibition -->",
        "Never use mktemp -d.",
        "Never use `/tmp`, `$TMPDIR`, or `/var/tmp`. <!-- guard-allow: prohibition -->",
        "Must not use /tmp. <!-- guard-allow: prohibition -->",
        "- `spider message` reaches a live peer\n- to restart work after a child finished, dispatch a new run",
        "| spider message | reaches a live peer |\n| Resume a completed child | not supported |",
      ].join("\n"));
      fs.writeFileSync(path.join(root, "safe.sh"), "# Never use /tmp # guard-allow: prohibition\n");
      expect(scan(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
