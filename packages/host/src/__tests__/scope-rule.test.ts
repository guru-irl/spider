// packages/host/src/__tests__/scope-rule.test.ts
import { describe, it, expect } from "vitest";
import { SPIDER_PARAMETERS } from "../extension";
import { SPIDER_BLOCK_BODY } from "@spider/superpowers";

describe("scope rule teaching", () => {
  it("tool schema scope description contains the rule (mutation: remove rule → must fail)", () => {
    // Mutation: remove the scope rule from the tool schema → must fail
    const scopeParam = (SPIDER_PARAMETERS as any).properties?.scope;
    expect(scopeParam).toBeDefined();
    const description = scopeParam.description;
    expect(description).toBeDefined();

    // Assert on SHORT STABLE SUBSTRINGS from the rule
    expect(description).toContain("delete this worktree");
    expect(description).toContain("repo");
    expect(description).toContain("global");
  });

  it("managed AGENTS.md content contains the rule (mutation: remove rule → must fail)", () => {
    // Mutation: remove the scope rule from AGENTS.md content → must fail
    expect(SPIDER_BLOCK_BODY).toBeDefined();

    // Assert on SHORT STABLE SUBSTRINGS from the rule
    expect(SPIDER_BLOCK_BODY).toContain("delete this worktree");
    expect(SPIDER_BLOCK_BODY).toContain("repo");
    expect(SPIDER_BLOCK_BODY).toContain("global");
  });
});
