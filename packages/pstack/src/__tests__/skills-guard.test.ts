import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { pkgRoot, testScratchPath } from "./testutil.js";

const skillsDir = path.join(pkgRoot, "skills");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".spider" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

const EXPECTED_31 = [
  "bro", "how", "show-me-your-work", "teach", "technical-writing", "unslop", "why",
  "principle-attack-the-premise", "principle-boundary-discipline", "principle-build-the-lever",
  "principle-encode-lessons-in-structure", "principle-exhaust-the-design-space", "principle-experience-first",
  "principle-explain-the-number", "principle-fix-root-causes", "principle-foundational-thinking",
  "principle-guard-the-context-window", "principle-laziness-protocol", "principle-make-operations-idempotent",
  "principle-migrate-callers-then-delete-legacy-apis", "principle-minimize-reader-load", "principle-model-the-domain",
  "principle-never-block-on-the-human", "principle-outcome-oriented-execution", "principle-prove-it-works",
  "principle-redesign-from-first-principles", "principle-separate-before-serializing-shared-state",
  "principle-sequence-verifiable-units", "principle-subtract-before-you-add",
  "principle-test-behavior-not-implementation", "principle-type-system-discipline",
];

// pstack skills and agents at the vendored commit that spider does not ship.
const UNSHIPPED_HYPHENATED = [
  "automate-me", "benchmark-checklist", "blast-radius", "create-verification-skill", "figure-it-out", "fix-ci",
  "fix-merge-conflicts", "get-pr-comments", "in-your-own-words", "maintain-verification-skill",
  "make-pr-easy-to-review", "no-comments", "poteto-help", "poteto-mode", "setup-pstack",
  "thermo-nuclear-code-quality-review", "thermo-nuclear-review", "typescript-best-practices", "what-did-i-get-done",
  "comment-sicko", "poteto-agent",
];
// Single-word names are ordinary English too, so only flag them when written as a skill reference.
const UNSHIPPED_WORDS = ["architect", "arena", "babysit", "correct", "deslop", "interrogate", "ketchup", "recall", "reflect", "sharpen", "swarm", "tdd", "thermos"];

type Rule = { name: string; pattern: RegExp };
const RULES: Rule[] = [
  { name: "host-dispatch-tool", pattern: /\b(?:Task|Agent|Skill) tool\b|`(?:Task|Agent)`|\b(?:Task|Agent|Skill)\(/ },
  { name: "host-dispatch-option", pattern: /\b(?:subagent_type|run_in_background|spawn_agent|wait_agent|send_input|close_agent|reasoning_effort)\b|\breadonly\s*:\s*(?:true|false)\b|["`]general-purpose["`]/ },
  { name: "host-control-tool", pattern: /\b(?:AskUserQuestion|TodoWrite|EnterPlanMode|ExitPlanMode|EnterWorktree|WebFetch|WebSearch|ScheduleWakeup|schedule_wakeup)\b/ },
  { name: "host-file-tool", pattern: /\b(?:Bash|Glob|Grep)\b|\b(?:Read|Write|Edit|Bash|Glob|Grep) tool\b|\bUse Read\b/ },
  { name: "host-slash-loop", pattern: /(?:^|[\s`(])\/loop\b/ },
  { name: "host-name-or-path", pattern: /\bClaude\b|\bCLAUDE(?:\.md|_[A-Z0-9_]+)\b|\.claude(?:-plugin)?\/|\bmcp__|\bclaude mcp\b|\b(?:Codex|Copilot|Cursor|Gemini|OpenCode|Antigravity)\b/i },
  { name: "pstack-machinery", pattern: /\bpstack\b|\bpoteto\b|\bmodels\.json\b|tools\/generate\.mjs/i },
  { name: "unshipped-skill", pattern: new RegExp(String.raw`\b(?:${UNSHIPPED_HYPHENATED.join("|")})\b`) },
  { name: "unshipped-skill-ref", pattern: new RegExp(String.raw`(?:\*\*|\x60|\/)(?:${UNSHIPPED_WORDS.join("|")})(?:\*\*|\x60)|\.\.\/(?:${UNSHIPPED_WORDS.join("|")})\/|(?:^|[\s\x60(])\/recall(?=\s)`) },
  { name: "model-name", pattern: /\b(?:opus|sonnet|haiku|codex|gpt-?\d[\w.-]*|o[134](?:-mini)?|gemini|llama|mistral|grok|(?:deepseek|qwen|kimi)[\w.-]*)\b/i },
  { name: "system-temp", pattern: /(?:\/var\/tmp|\/tmp)(?:\/|\b)|\$\{?(?:TMPDIR|TMP|TEMP)\}?(?![A-Za-z0-9_])|\bTMPDIR\b|\bos\.tmpdir\b|%TEMP%|\bmktemp\b|tmpdir\(\)|\/var\/folders\// },
];

// This exact sentence uses "cursor" as an editor position, not a vendor.
const WHY_CURSOR_SENTENCE = 'If the target is vague ("why do we do it this way?" with no clear referent), make your best guess from conversation context (open files, recent edits, cursor location, what was just discussed). State your interpretation briefly so the user can redirect if you\'re off, then proceed.';

function scan(root: string): string[] {
  const hits: string[] = [];
  for (const file of walk(root).sort()) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
      for (const rule of RULES) {
        const checked = rule.name === "host-name-or-path" && rel === "why/SKILL.md" && line === WHY_CURSOR_SENTENCE
          ? line.replace("cursor location", "caret location") : line;
        if (rule.pattern.test(checked)) hits.push(`${rel}:${i + 1} [${rule.name}] ${line.trim().slice(0, 200)}`);
      }
    });
  }
  return hits;
}

function frontmatter(md: string): Record<string, string> | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith("\"") && v.endsWith("\"")) v = JSON.parse(v) as string;
    out[kv[1]] = v;
  }
  return out;
}

describe("pstack skills: shipped set", () => {
  it("ships exactly the 31 pinned skills, each with a SKILL.md", () => {
    const dirs = fs.readdirSync(skillsDir).filter((n) => fs.statSync(path.join(skillsDir, n)).isDirectory()).sort();
    expect(dirs).toEqual([...EXPECTED_31].sort());
    for (const name of EXPECTED_31) expect(fs.existsSync(path.join(skillsDir, name, "SKILL.md")), name).toBe(true);
  });

  it("keeps each frontmatter name equal to its directory, with a description pi accepts", () => {
    for (const name of EXPECTED_31) {
      const fm = frontmatter(fs.readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8"));
      expect(fm, name).not.toBeNull();
      expect(fm!.name, name).toBe(name);
      // pi's skill loader caps descriptions at 1024 characters.
      expect(fm!.description?.trim().length ?? 0, name).toBeGreaterThan(0);
      expect(fm!.description.length, name).toBeLessThanOrEqual(1024);
      // pi ignores other keys (e.g. user-invocable), so the copies carry only these two.
      expect(Object.keys(fm!).sort(), name).toEqual(["description", "name"]);
    }
  });
});

describe("pstack skills: spider terms only", () => {
  it("has no other hosts' terms, unshipped pstack skills, model names, or system temp paths", () => {
    const hits = scan(skillsDir);
    if (hits.length > 0) throw new Error(`Found ${hits.length} forbidden term(s):\n${hits.join("\n")}`);
  });

  it.each([
    ...["claude", "codex", "copilot", "cursor", "gemini", "opencode", "antigravity"]
      .flatMap(vendor => [vendor, vendor.toUpperCase()].map(term => [`Ask ${term} to do it.`, "host-name-or-path"])),
    ["Read ~/.CLAUDE/projects/x.", "host-name-or-path"],
    ["Set TMPDIR to a scratch directory.", "system-temp"],
    ["Use os.tmpdir as the directory provider.", "system-temp"],
    ["Write under %TEMP%.", "system-temp"],
    ["Use deepseek for this.", "model-name"],
    ["Use qwen for this.", "model-name"],
    ["Use kimi for this.", "model-name"],
    ["Use DeepSeek-V3 for this.", "model-name"],
    ["Use Qwen3 for this.", "model-name"],
    ["Use Kimi-K2 for this.", "model-name"],
    ["Run /recall previous decisions.", "unshipped-skill-ref"],
  ])("catches the review regression fixture %s", (text, rule) => {
    const root = testScratchPath(`pstack-guard-review-${process.pid}`);
    fs.mkdirSync(root, { recursive: true });
    try {
      fs.writeFileSync(path.join(root, "fixture.md"), text);
      expect(scan(root).some(hit => hit.includes(`[${rule}]`)), `${rule}: ${text}`).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows only the existing why skill cursor-location sentence", () => {
    const root = testScratchPath(`pstack-guard-cursor-${process.pid}`);
    const original = fs.readFileSync(path.join(skillsDir, "why/SKILL.md"), "utf8")
      .split(/\r?\n/).find(line => line.includes("cursor location"))!;
    expect(original).toBeTruthy();
    fs.mkdirSync(path.join(root, "why"), { recursive: true });
    const file = path.join(root, "why/SKILL.md");
    try {
      fs.writeFileSync(file, original);
      expect(scan(root)).toEqual([]);
      for (const altered of [
        `${original} Ask claude.`,
        original.replace("cursor location", "Cursor location"),
        `${original}\nAsk cursor to do it.`,
      ]) {
        fs.writeFileSync(file, altered);
        expect(scan(root).some(hit => hit.includes("[host-name-or-path]"))).toBe(true);
      }
      fs.unlinkSync(file);
      fs.writeFileSync(path.join(root, "other.md"), original);
      expect(scan(root).some(hit => hit.includes("[host-name-or-path]"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("catches each forbidden term in a fixture", () => {
    const root = testScratchPath(`pstack-guard-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true });
    try {
      const mutants: [string, string][] = [
        ["Spawn an `Agent` subagent.", "host-dispatch-tool"],
        ["Use the Task tool.", "host-dispatch-tool"],
        ["with subagent_type: \"x\"", "host-dispatch-option"],
        ["Set readonly: true.", "host-dispatch-option"],
        ["Ask with AskUserQuestion.", "host-control-tool"],
        ["Track it in TodoWrite.", "host-control-tool"],
        ["Fetch it with WebFetch.", "host-control-tool"],
        ["Call ScheduleWakeup.", "host-control-tool"],
        ["Run it in Bash.", "host-file-tool"],
        ["Use Read, Grep, and Glob.", "host-file-tool"],
        ["Run /loop 5m check.", "host-slash-loop"],
        ["Ask Claude to do it.", "host-name-or-path"],
        ["Edit CLAUDE.md.", "host-name-or-path"],
        ["Read ~/.claude/projects/x.", "host-name-or-path"],
        ["On Codex, read this.", "host-name-or-path"],
        ["Run /setup-pstack.", "pstack-machinery"],
        ["See the poteto-mode skill.", "unshipped-skill"],
        ["Use the benchmark-checklist skill.", "unshipped-skill"],
        ["Run the **sharpen** skill.", "unshipped-skill-ref"],
        ["See [x](../deslop/SKILL.md).", "unshipped-skill-ref"],
        ["Default model: `opus`.", "model-name"],
        ["subagent_type: `general-purpose`", "host-dispatch-option"],
        ["Use gpt-5.1 for this.", "model-name"],
        ["Write to /tmp/x.", "system-temp"],
        ["Use $TMPDIR.", "system-temp"],
        ["mktemp -d", "system-temp"],
      ];
      for (const [text, rule] of mutants) {
        const file = path.join(root, "m.md");
        fs.writeFileSync(file, text);
        expect(scan(root).some((h) => h.includes(`[${rule}]`)), `${rule}: ${text}`).toBe(true);
        fs.unlinkSync(file);
      }
      fs.writeFileSync(path.join(root, "safe.md"), [
        "Dispatch with `spider run` and track with `spider todo`.",
        "Read the actual error. Correct the log. Recall the rule.",
        "Use the **show-me-your-work** skill and the `how` skill.",
        "Write it under .spider/scratch/decisions.tsv.",
        "Pick a capable model for the reviewer role.",
        "the text caret location",
        "Keep general-purpose mechanism inside.",
      ].join("\n"));
      expect(scan(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("why: only sources spider can reach", () => {
  const whyDir = path.join(skillsDir, "why");
  it("keeps only the git, gh and codebase source guides", () => {
    expect(fs.readdirSync(path.join(whyDir, "references", "sources")).sort()).toEqual(["code-archaeology.md", "incident-postmortem.md"]);
  });
  it("does not route to connectors spider cannot reach", () => {
    const connector = /\b(?:MCPs?|Slack|Datadog|Notion|Linear|Sentry|Databricks)\b/;
    const hits = walk(whyDir).flatMap((f) => fs.readFileSync(f, "utf8").split(/\r?\n/)
      .map((line, i) => [line, i] as const).filter(([line]) => connector.test(line))
      .map(([line, i]) => `${path.relative(whyDir, f)}:${i + 1} ${line.trim().slice(0, 160)}`));
    expect(hits).toEqual([]);
  });
  it("routes to spider search and spider fetch", () => {
    const skill = fs.readFileSync(path.join(whyDir, "SKILL.md"), "utf8");
    for (const verb of ["spider search", "spider fetch", "spider run", "gh "]) expect(skill.includes(verb), verb).toBe(true);
  });
});

describe("pstack package: provenance", () => {
  it("UPSTREAM.md lists every shipped skill file, and removed files are absent", () => {
    const rows = [...fs.readFileSync(path.join(pkgRoot, "UPSTREAM.md"), "utf8").matchAll(/^\| `([^`]+)` \| (kept|changed|removed) \|/gm)];
    const listed = new Map(rows.map((m) => [m[1], m[2]]));
    for (const file of walk(skillsDir)) {
      const rel = path.relative(skillsDir, file).split(path.sep).join("/");
      expect(["kept", "changed"], rel).toContain(listed.get(rel));
    }
    for (const [rel, status] of listed) {
      if (status === "removed") expect(fs.existsSync(path.join(skillsDir, rel)), rel).toBe(false);
    }
  });
});

describe("pstack package: relative links resolve", () => {
  it("every relative markdown link in the package points to an existing file", () => {
    const broken: string[] = [];
    for (const file of walk(pkgRoot).filter((f) => f.endsWith(".md"))) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1].split("#")[0];
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        if (!fs.existsSync(path.resolve(path.dirname(file), target))) {
          broken.push(`${path.relative(pkgRoot, file)} -> ${m[1]}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
