import { describe, it, expect } from "vitest";
import * as core from "../index";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// Cheap guard, not a complete syntax audit. Known limits: split strings, unquoted
// object keys, numeric enums, and declarations spanning more than 300 characters.
function hasLevelCopy(source: string): boolean {
  // Protect literals using the parser before scanning trivia. A bare scanner treats
  // regex slashes and interpolated template tails as comments unless rescanned.
  let triviaSource = source;
  const file = ts.createSourceFile("guard.ts", source, ts.ScriptTarget.Latest, true);
  const protect = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isRegularExpressionLiteral(node) || ts.isTemplateLiteralToken(node)) {
      const start = node.getStart(file), end = node.end;
      triviaSource = triviaSource.slice(0, start) + " ".repeat(end - start) + triviaSource.slice(end);
    }
    ts.forEachChild(node, protect);
  };
  protect(file);
  // Comments are not declarations. Preserve positions for the small-window rule.
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, triviaSource);
  let token: ts.SyntaxKind;
  while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const start = scanner.getTokenPos(), end = scanner.getTextPos();
      source = source.slice(0, start) + " ".repeat(end - start) + source.slice(end);
    }
  }
  // Quoted literals include arrays and unions; bare alternatives include suffix regexes.
  const tokens = [...source.matchAll(/["'`](minimal|low|medium|high|xhigh|max)["'`]|[|(]\s*(minimal|low|medium|high|xhigh|max)(?=\s*[|)])/g)];
  return tokens.some((start, i) => new Set(tokens.slice(i).filter(match => match.index! - start.index! <= 300).map(match => match[1] ?? match[2])).size >= 3);
}

function findLevelCopies(dir: string): string[] {
  const copies: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "__tests__" && entry.name !== "node_modules" && !entry.name.startsWith(".")) visit(path);
      else if (entry.isFile() && /\.(?:[cm]?[jt]s|tsx|json)$/.test(path) && !/\.(?:test|spec)\./.test(path) && !path.endsWith("db-core/src/thinking.ts")) {
        if (hasLevelCopy(readFileSync(path, "utf8"))) copies.push(path);
      }
    }
  };
  visit(dir);
  return copies;
}

describe("one-list guard shapes", () => {
  it.each([
    ["after regex", 'const pattern = /\\/\\//g; const copy = ["low", "medium", "high"];'],
    ["after template", 'const glob = `${x}/*`; const copy = ["low", "medium", "high"];'],
    ["json", '{"enum": ["low", "medium", "high"]}'],
    ["union", 'type Copy = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";'],
    ["regex", 'const copy = /:(off|minimal|low|medium|high|xhigh|max)$/;'],
    ["multi-line", 'const copy = [\n "off", "minimal", "low",\n "medium", "high", "xhigh", "max",\n];'],
    ["partial", 'const copy = ["off", "low", "medium", "high", "xhigh", "max"];'],
  ])("rejects a %s re-declaration", (_shape, source) => {
    expect(hasLevelCopy(source)).toBe(true);
  });
});

describe("shared thinking capability policy", () => {
  it.each([
    [{ reasoning: true, thinkingLevelMap: { max: "maximum" } }, "max", "max"],
    [{ reasoning: true, thinkingLevelMap: { xhigh: "extra", max: null } }, "max", "xhigh"],
    [{ reasoning: true, thinkingLevelMap: { xhigh: null, max: "maximum" } }, "xhigh", "max"],
    [{ reasoning: true }, "max", "high"],
    [{ reasoning: false }, "max", "off"],
    [{ reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null } }, "off", "medium"],
  ])("matches pi's clamp for %j at %s", (model, requested, effective) => {
    expect((core as any).resolveThinking(model, requested).effective).toBe(effective);
    expect(clampThinkingLevel(model as any, requested as any)).toBe(effective);
  });
  it("does not claim an effective level for an unknown model", () => {
    expect((core as any).resolveThinking(undefined, "max")).toMatchObject({ requested: "max", effective: undefined, notice: expect.stringMatching(/unknown model.*cannot verify/) });
  });
  it("rejects an invalid level rather than silently claiming it", () => {
    expect(() => (core as any).resolveThinking({ reasoning: true }, "turbo")).toThrow(/invalid thinking/);
  });
  it("keeps production thinking enums in the single shared definition", () => {
    const copies = [...findLevelCopies(join(process.cwd(), "packages")), ...findLevelCopies(join(process.cwd(), "scripts"))];
    expect(copies).toEqual([]);
  });
});


it("reports the mapped provider value without confusing it with pi's level", () => {
  expect((core as any).resolveThinking({ reasoning: true, thinkingLevelMap: { max: "maximum" } }, "max")).toMatchObject({ effective: "max", providerValue: "maximum", notice: undefined });
});


it.each([
  [{ reasoning: true }, "high", "high"],
  [{ reasoning: true, thinkingLevelMap: { max: "maximum" } }, "max", "max"],
  [{ reasoning: false }, undefined, "off"],
  [{ reasoning: false }, "off", "off"],
])("keeps unchanged thinking out of warning notices for %j at %s", (model, requested, effective) => {
  expect(core.resolveThinking(model, requested)).toMatchObject({ effective, notice: undefined });
});

it("one-list guard ignores comments and isolated defaults", () => {
  expect(hasLevelCopy('// "minimal", "low", "max"')).toBe(false);
  expect(hasLevelCopy('const a = "low";' + " ".repeat(301) + 'const b = "medium";' + " ".repeat(301) + 'const c = "high";')).toBe(false);
});


it("scans JSON level arrays and ignores machine-local dot directories", () => {
  const scratch = join(process.cwd(), ".spider/scratch/thinking-guard-tests");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "guard-"));
  const source = '{"enum": ["low", "medium", "high"]}';
  try {
    const json = join(root, "schema.json");
    writeFileSync(json, source);
    mkdirSync(join(root, ".spider"));
    writeFileSync(join(root, ".spider", "ignored.ts"), source);
    expect(findLevelCopies(root)).toEqual([json]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
