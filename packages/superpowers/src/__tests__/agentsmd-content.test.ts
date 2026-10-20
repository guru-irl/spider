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
  it("includes the approved pstack guidance immediately after Skills first", () => {
    const expected = `## pstack skills

spider also ships 31 skills adapted from pstack. Use them alongside the
superpowers skills above; they replace none of them.

- \`how\`: how code works, a walkthrough before changing it, or where code should
  live. \`why\`: why code or a decision is the way it is, with cited evidence.
  \`teach\`: explain a body of work so a person understands it; it runs \`how\`
  and \`why\`.
- \`unslop\`: any prose a person will read, your reply included.
  \`technical-writing\`: docs, READMEs, RFCs, PR descriptions and commit
  messages, on top of \`unslop\`. \`bro\`: restate the last message in plain words
  when asked.
- \`show-me-your-work\`: keep its decision log for long, unattended or
  multi-phase work.
- \`principle-*\`: each description says when it applies. When a decision
  matches one, read that skill in full first. In your reply, name each
  principle you applied and the choice it changed.`;
    expect(buildSpiderBlock()).toContain(expected);
    expect(SPIDER_BLOCK_BODY.match(/^## .+$/gm)?.slice(0, 3)).toEqual([
      "## Skills first", "## pstack skills", "## The spider tool",
    ]);
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

  it("documents removal of obsolete items and safe clear defaults", () => {
    expect(SPIDER_BLOCK_BODY).toContain("`remove`");
    expect(SPIDER_BLOCK_BODY).toMatch(/remove obsolete items with op=remove/i);
    expect(SPIDER_BLOCK_BODY).toMatch(/clear only removes done items unless force:true/i);
  });
});
