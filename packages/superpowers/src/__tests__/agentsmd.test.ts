import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { testScratchPath } from "./testutil.js";
import { upsertManagedBlock, isLegacyFiveToolGuide, writeAgentsMd } from "../agentsmd.js";
import { buildSpiderBlock, SPIDER_BLOCK_START, SPIDER_BLOCK_END } from "../agentsmd-content.js";

const BLOCK = buildSpiderBlock();
function countBlocks(s: string): number {
  return (s.match(/<!-- spider:start -->/g) ?? []).length;
}
let n = 0;
function scratchFile(name: string): string {
  const dir = testScratchPath( `agentsmd-${process.pid}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

describe("upsertManagedBlock (pure)", () => {
  it("creates the block in an empty/null file", () => {
    const out = upsertManagedBlock(null, BLOCK);
    expect(out).toContain(SPIDER_BLOCK_START);
    expect(countBlocks(out)).toBe(1);
  });
  it("is idempotent — upserting twice yields identical content and one block", () => {
    const once = upsertManagedBlock(null, BLOCK);
    const twice = upsertManagedBlock(once, BLOCK);
    expect(twice).toBe(once);
    expect(countBlocks(twice)).toBe(1);
  });
  it("preserves user content OUTSIDE the block on update", () => {
    const user = "# My notes\n\nKeep this.\n";
    const first = upsertManagedBlock(user, BLOCK);
    expect(first).toContain("Keep this.");
    const upgraded = BLOCK.replace(SPIDER_BLOCK_END, "extra line\n" + SPIDER_BLOCK_END);
    const second = upsertManagedBlock(first, upgraded);
    expect(second).toContain("Keep this.");
    expect(second).toContain("extra line");
    expect(countBlocks(second)).toBe(1);
  });
  it("preserves user content added AFTER the block", () => {
    const withBlock = upsertManagedBlock(null, BLOCK);
    const edited = withBlock + "\n## User section\nhand-written\n";
    const out = upsertManagedBlock(edited, BLOCK);
    expect(out).toContain("hand-written");
    expect(countBlocks(out)).toBe(1);
  });
  it("replaces the legacy five-tool guide wholesale", () => {
    const legacy = "# Agent operating guide (global)\n\n## Task tracking — `todo`\n...\n";
    expect(isLegacyFiveToolGuide(legacy)).toBe(true);
    const out = upsertManagedBlock(legacy, BLOCK);
    expect(out).not.toContain("Agent operating guide (global)");
    expect(countBlocks(out)).toBe(1);
  });
  it("prepends (does not delete) genuine user content with no markers", () => {
    const user = "# Personal AGENTS\nremember my preferences\n";
    const out = upsertManagedBlock(user, BLOCK);
    expect(out.indexOf(SPIDER_BLOCK_START)).toBeLessThan(out.indexOf("Personal AGENTS"));
    expect(out).toContain("remember my preferences");
  });
});

describe("writeAgentsMd (IO)", () => {
  it("creates the file then reports unchanged on a second write", () => {
    const p = scratchFile("AGENTS.md");
    const r1 = writeAgentsMd(p);
    expect(r1.action).toBe("created");
    expect(fs.readFileSync(p, "utf8")).toContain(SPIDER_BLOCK_START);
    const r2 = writeAgentsMd(p);
    expect(r2.action).toBe("unchanged");
  });
  it("creates parent directories if missing", () => {
    const p = path.join(testScratchPath(`agentsmd-nested-${process.pid}-${n++}`), "deep", "AGENTS.md");
    const r = writeAgentsMd(p);
    expect(r.action).toBe("created");
    expect(fs.existsSync(p)).toBe(true);
  });
});
