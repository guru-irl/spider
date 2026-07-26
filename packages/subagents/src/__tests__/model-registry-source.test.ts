import { describe, it, expect } from "vitest";
import { listPiModels, qualifyModelProvider } from "../model-resolve";

// pi's real surface: ExtensionContext.modelRegistry, a ModelRegistry with
// getAll()/getAvailable(). `pi.listModels` / `pi.availableModels` do not exist
// anywhere in pi -- reading them meant this ALWAYS returned [], so bare model ids
// were never qualified and a child could die silently with "No API key found".
const model = (provider: string, id: string, extra: any = {}) => ({
  id, name: id, provider, reasoning: false, input: ["text"], contextWindow: 1000, ...extra,
});
const mkRegistry = (all: any[], available?: any[]) => ({
  getAll: () => all, getAvailable: () => available ?? all,
});

describe("subagent model qualification reads the real registry", () => {
  // Mutation this catches: revert to pi.listModels/pi.availableModels -> [] -> unqualified.
  it("lists models from a ModelRegistry", () => {
    const list = listPiModels(mkRegistry([model("github-copilot", "claude-sonnet-5")]));
    expect(list.length).toBe(1);
    expect(list[0].provider).toBe("github-copilot");
  });

  it("qualifies a bare id to the provider pi lists as available", () => {
    const list = listPiModels(mkRegistry([model("github-copilot", "claude-sonnet-5")]));
    expect(qualifyModelProvider("claude-sonnet-5", list)).toBe("github-copilot/claude-sonnet-5");
  });

  it("prefers an AVAILABLE provider over an unavailable one", () => {
    const unavail = model("anthropic", "claude-sonnet-5");
    const avail = model("github-copilot", "claude-sonnet-5");
    const list = listPiModels(mkRegistry([unavail, avail], [avail]));
    expect(qualifyModelProvider("claude-sonnet-5", list)).toBe("github-copilot/claude-sonnet-5");
  });

  it("already-qualified refs pass through untouched", () => {
    const list = listPiModels(mkRegistry([model("github-copilot", "claude-sonnet-5")]));
    expect(qualifyModelProvider("openai/gpt-5", list)).toBe("openai/gpt-5");
  });

  it("no registry → empty list, and the bare id passes through unchanged", () => {
    expect(listPiModels(undefined)).toEqual([]);
    expect(qualifyModelProvider("claude-sonnet-5", listPiModels(undefined))).toBe("claude-sonnet-5");
  });
});
