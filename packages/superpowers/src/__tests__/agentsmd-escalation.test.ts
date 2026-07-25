import { describe, it, expect } from "vitest";
import { SPIDER_BLOCK_BODY } from "../agentsmd-content.js";

describe("spider AGENTS.md escalation rule", () => {
  it("includes the escalation instruction for top-level agents (mutation: delete rule → fails)", () => {
    // The managed AGENTS.md block must tell the top-level agent to escalate when appropriate
    // Assert on a stable substring
    expect(SPIDER_BLOCK_BODY).toContain("escalat");
  });
});
