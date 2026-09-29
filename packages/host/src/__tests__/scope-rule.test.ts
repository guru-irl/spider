// packages/host/src/__tests__/scope-rule.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPIDER_PARAMETERS } from "../extension";
import { SPIDER_BLOCK_BODY } from "@spider/superpowers";

describe("scope rule teaching", () => {
  it("declares control migrate apply as a boolean with dry-run default", () => {
    expect(SPIDER_PARAMETERS.properties.apply).toEqual({ type: "boolean", description: "control migrate: apply changes (default is a dry-run)." });
  });
  it("architecture documentation describes the shared read-only two-tier snapshot with no default cap", () => {
    const doc = readFileSync(join(process.cwd(), "docs/architecture/feedback-and-learning-loops.md"), "utf8");
    expect(doc).toContain("readInjectionSnapshot");
    expect(doc).toMatch(/global and repo/);
    expect(doc).toMatch(/no default (?:snapshot )?cap/);
    expect(doc).toContain("Memory snapshot: N entries omitted.");
    expect(doc).not.toContain("makeBeforeAgentStart");
    expect(doc).not.toContain("makeSessionStart");
    expect(doc).not.toContain("char cap 8000");
    expect(doc).not.toMatch(/project memor/i);
  });
  it("memory package README describes host-owned hooks, two scopes and optional snapshot cap", () => {
    const doc = readFileSync(join(process.cwd(), "packages/memory/README.md"), "utf8");
    expect(doc).toContain("readInjectionSnapshot");
    expect(doc).toContain("repo or global");
    expect(doc).toContain("memory.snapshotCharCap");
    expect(doc).not.toMatch(/actions\.ts|hooks\.ts|registerMemory|makeRemember|makeRecall|makeControl|makeBeforeAgentStart|makeSessionStart|8000 by default|char-capped/);
  });
  it("recall descriptions distinguish repo AND-first fallback from global substring matching", () => {
    const doc = readFileSync(join(process.cwd(), "packages/memory/README.md"), "utf8");
    const description = (SPIDER_PARAMETERS as any).properties.query.description as string;
    for (const text of [doc, description]) {
      expect(text).toMatch(/repo.*AND.*OR/i);
      expect(text).toMatch(/global.*whole query.*substring/i);
      expect(text).toMatch(/(?:common |stop)words?.*(?:ignored|removed)/i);
    }
  });
  it("organism README describes repo rather than project memory", () => {
    const doc = readFileSync(join(process.cwd(), "packages/organism/README.md"), "utf8");
    expect(doc).toContain("active repo memory");
    expect(doc).toContain("active repo memories");
    expect(doc).not.toMatch(/project memor/i);
  });
  it("architecture doc names the host session hook and host remember action", () => {
    const doc = readFileSync(join(process.cwd(), "docs/architecture/feedback-and-learning-loops.md"), "utf8");
    expect(doc).toContain("repo or global scope");
    expect(doc).toContain("host `remember` action");
    expect(doc).not.toContain("(memory hook)");
    expect(doc).not.toContain("makeRemember");
  });
  it("tool schema scope description contains the rule (mutation: remove rule → must fail)", () => {
    // Mutation: remove the scope rule from the tool schema → must fail
    const scopeParam = (SPIDER_PARAMETERS as any).properties?.scope;
    expect(scopeParam).toBeDefined();
    const description = scopeParam.description;
    expect(description).toBeDefined();

    expect(description).toContain('"Is this true in every repo?" → **global**; otherwise → **repo**');
    expect(description).not.toMatch(/otherwise → \*\*worktree\*\*|worktree memory (?:tier|scope)/i);
  });

  it("managed AGENTS.md content contains the rule (mutation: remove rule → must fail)", () => {
    // Mutation: remove the scope rule from AGENTS.md content → must fail
    expect(SPIDER_BLOCK_BODY).toBeDefined();

    // Assert on SHORT STABLE SUBSTRINGS from the rule
    expect(SPIDER_BLOCK_BODY).toContain("Is this true in every repo?");
    expect(SPIDER_BLOCK_BODY).toContain("otherwise → **repo**");
    expect(SPIDER_BLOCK_BODY).not.toContain("otherwise → **worktree**");
  });
});
