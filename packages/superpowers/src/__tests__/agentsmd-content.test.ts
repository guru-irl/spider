import { describe, it, expect } from "vitest";
import { SPIDER_BLOCK_START, SPIDER_BLOCK_END, SPIDER_BLOCK_BODY, buildSpiderBlock } from "../agentsmd-content.js";
describe("spider AGENTS.md block content", () => {
  it("folds skills + tooling + memory discipline", () => {
    expect(SPIDER_BLOCK_BODY).toMatch(/skill/i);
    expect(SPIDER_BLOCK_BODY).toMatch(/spider search/);
    expect(SPIDER_BLOCK_BODY).toMatch(/spider run/);
    expect(SPIDER_BLOCK_BODY).toMatch(/remember/);
    expect(SPIDER_BLOCK_BODY).toMatch(/\.spider\/scratch/);
    expect(SPIDER_BLOCK_BODY).toMatch(/never.*\/tmp/i);
  });
  it("stays within the token budget (≤ 8500 chars)", () => {
    expect(SPIDER_BLOCK_BODY.length).toBeLessThanOrEqual(8500);
  });
  it("buildSpiderBlock wraps the body in the delimiters exactly once", () => {
    const b = buildSpiderBlock();
    expect(b.startsWith(SPIDER_BLOCK_START)).toBe(true);
    expect(b.trimEnd().endsWith(SPIDER_BLOCK_END)).toBe(true);
    expect(b.match(/<!-- spider:start -->/g)!.length).toBe(1);
    expect(b.match(/<!-- spider:end -->/g)!.length).toBe(1);
  });
});
