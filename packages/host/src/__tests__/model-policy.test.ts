import { afterEach, describe, expect, it } from "vitest";
import { paths } from "@spider/db-core";
import { join } from "node:path";
import { buildActionCtx, default as spiderExtension } from "../extension";
import { controlConfig } from "../control";
import { skillReviewOptions } from "../skill-reviewer";
import { isolatedCwd } from "./isolated-cwd";
import { ROLE_POLICY } from "@spider/models";
import { MODEL_ROLES } from "@spider/ui";

const cwd = isolatedCwd("model-policy");
const originalGlobalRoot = paths.globalRoot;
const contexts: ReturnType<typeof buildActionCtx>[] = [];
afterEach(() => {
  for (const ctx of contexts.splice(0)) for (const db of new Set([ctx.db, ctx.repoDb, ctx.globalDb])) { if (db.raw.open) db.close(); }
  paths.globalRoot = originalGlobalRoot;
});
const expected = {
  worker: "github-copilot/gpt-6.1-sol:high",
  planner: "github-copilot/gpt-6.1-sol:high",
  researcher: "github-copilot/gpt-6.1-sol:high",
  oracle: "github-copilot/claude-opus-5.5:medium",
  reviewer: "github-copilot/claude-opus-5.5:high",
  scout: "github-copilot/gpt-6-luna:low",
  digest: "github-copilot/gpt-6-luna:low",
  self_name: "github-copilot/gpt-6-luna:low",
  upstream_watch: "github-copilot/gpt-6-luna:low",
};
const models = ["claude-sonnet-5.5", "gpt-5.4", "gpt-6-terra", "gpt-6-luna", "gpt-6.1-sol", "claude-opus-5.5"].map(id => ({ provider: "github-copilot", id, reasoning: true, input: ["text"] }));
const registry = { getAll: () => models, getAvailable: () => models };

function toolFixture() {
  paths.globalRoot = join(cwd, "global");
  let tool: any;
  const pi: any = { registerTool: (t: any) => { if (t.name === "spider") tool = t; }, registerCommand: () => {}, registerMessageRenderer: () => {}, registerRenderer: () => {}, registerShortcut: () => {}, on: () => pi, sendMessage: () => {}, addMessage: () => {} };
  spiderExtension(pi);
  return { tool, pi };
}

describe("host model policy", () => {
  // Break caught: control reports only persisted overrides, not the shipped routing defaults.
  it("reports all built-in role defaults and their default provenance", async () => {
    const { tool } = toolFixture();
    const r = await tool.execute("policy", { action: "control", command: "models" }, undefined, undefined, { cwd, sessionId: "policy", modelRegistry: registry });
    expect(r.details.defaults).toEqual(expected);
    expect(r.details.sources).toEqual(Object.fromEntries(Object.keys(expected).map(role => [role, "default"])));
  });

  // Break caught: the control display and actual run routing disagree.
  it("threads the same model and thinking defaults into subagent dispatch", () => {
    const { pi } = toolFixture();
    const ctx = buildActionCtx(pi, { action: "run" }, "policy-routing", cwd, undefined, registry);
    contexts.push(ctx);
    expect(ctx.modelDefaults).toEqual(expected);
  });

  it("preserves explicit configured models, including excluded automatic models and suffixes", () => {
    const { pi } = toolFixture();
    controlConfig("set", cwd, "models.defaults", { worker: "github-copilot/gpt-5.4:xhigh" });
    try {
      const ctx = buildActionCtx(pi, { action: "run" }, "policy-pin", cwd, undefined, registry);
      contexts.push(ctx);
      expect(ctx.modelDefaults?.worker).toBe("github-copilot/gpt-5.4:xhigh");
      expect(ctx.modelDefaults?.reviewer).toBe(expected.reviewer);
    } finally { controlConfig("unset", cwd, "models.defaults"); }
  });

  it("keeps skill review on Luna xhigh and memory review on Luna medium", () => {
    toolFixture();
    expect(controlConfig("get", cwd, "skills.reviewer.model")).toBe("github-copilot/gpt-6-luna");
    expect(controlConfig("get", cwd, "skills.reviewer.thinking")).toBe("xhigh");
    expect(controlConfig("get", cwd, "memory.reviewer.model")).toBe("github-copilot/gpt-6-luna");
    expect(controlConfig("get", cwd, "memory.reviewer.thinking")).toBe("medium");
  });

  it("falls back to Luna xhigh for skill review when the configured model is not a string", async () => {
    toolFixture();
    controlConfig("set", cwd, "skills.reviewer.model", null);
    const handle = { provider: "github-copilot", id: "gpt-6-luna", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } };
    let requestedThinking: unknown;
    const reviewRegistry = {
      find: (provider: string, id: string) => provider === handle.provider && id === handle.id ? handle : undefined,
      streamSimple: (_model: unknown, _context: unknown, options: { reasoning?: string }) => {
        requestedThinking = options.reasoning;
        return { result: async () => ({ content: [{ type: "text", text: "review response" }], stopReason: "stop" }) };
      },
    };
    try {
      const options = skillReviewOptions(cwd, reviewRegistry);
      const response = await options.reviewer!({ name: "candidate", body: "body", origin: "agent" }, [], new AbortController().signal, "rubric");
      expect(response).toBe("review response");
      expect(requestedThinking).toBe("xhigh");
    } finally { controlConfig("unset", cwd, "skills.reviewer.model"); }
  });

  it("offers exactly the shipped model-policy roles in the config UI", () => {
    expect(new Set(MODEL_ROLES)).toEqual(new Set(Object.keys(ROLE_POLICY)));
  });
});
