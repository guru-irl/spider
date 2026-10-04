import { describe, expect, it } from "vitest";
import { catalog, pick, resolveRoleDefaults, DEFAULT_MODELS_CONFIG, type Tier } from "../index";
// Public pi-ai export approved for tests only; production uses root imports.
import { getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import { normalizeModelId } from "../model-id";

// Breaks caught: stale preferences, inherited role defaults, or unrestricted any-of-tier fallback.
const ids = [
  "claude-sonnet-5.5", "gpt-5.4", "gpt-5-mini", "gpt-5.5", "gpt-6-terra",
  "mai-code-1-flash-picker", "claude-sonnet-5", "claude-opus-4.8",
  "gpt-6-luna", "gpt-6.1-sol", "claude-opus-5.5",
];
const entries = catalog(() => ids.map(id => ({ provider: "github-copilot", id, available: true, reasoning: true })));
const roles = [
  ["worker", "gpt-6.1-sol", "high"],
  ["planner", "gpt-6.1-sol", "high"],
  ["researcher", "gpt-6.1-sol", "high"],
  ["oracle", "claude-opus-5.5", "medium"],
  ["reviewer", "claude-opus-5.5", "high"],
  ["scout", "gpt-6-luna", "low"],
  ["digest", "gpt-6-luna", "low"],
  ["self_name", "gpt-6-luna", "low"],
  ["upstream_watch", "gpt-6-luna", "low"],
] as const;

describe("built-in model policy", () => {
  it.each([
    ["openai/gpt-5:batch", "gpt-5"],
    ["anthropic/claude-sonnet-5.5:thinking", "claude-sonnet-5.5"],
    ["openrouter/qwen/qwen3-max:free", "qwen3-max"],
    ["provider/model:future-variant", "model"],
    ["us.anthropic.claude-sonnet-5-5-20260101-v1:0", "claude-sonnet-5.5"],
    ["claude-sonnet-5-5@20260101", "claude-sonnet-5.5"],
    ["claude-sonnet-5-5-2026-01-01", "claude-sonnet-5.5"],
    ["anthropic.claude-opus-4-6-v1", "claude-opus-4.6"],
    ["@cf/deepseek-ai/deepseek-v4-flash-0731", "deepseek-v4-flash-0731"],
    ["gpt-6-1-2-sol", "gpt-6.1.2-sol"],
    ["deepseek-v4-flash", "deepseek-v4-flash"],
    ["XiaomiMiMo/MiMo-V2-Flash", "mimo-v2-flash"],
  ])("normalizes %s to %s without discarding family tokens", (id, expected) => {
    expect(normalizeModelId(id)).toBe(expected);
  });

  it.each(roles)("resolves %s to %s at %s thinking", (role, id, thinking) => {
    for (const cfg of [{}, DEFAULT_MODELS_CONFIG]) {
      const result = pick(entries, { role }, cfg);
      expect(`${result.entry.provider}/${result.entry.id}`).toBe(`github-copilot/${id}`);
      expect(result.thinkingLevel).toBe(thinking);
    }
  });

  it.each(["light", "standard", "heavy"] as const)("prefers the policy model for %s even if another provider lists it first", tier => {
    const nonCopilot = entries.map(e => ({ ...e, provider: "other" }));
    const want = { light: "gpt-6-luna", standard: "gpt-6.1-sol", heavy: "claude-opus-5.5" };
    const result = pick([...nonCopilot, ...entries], { tier });
    expect(`${result.entry.provider}/${result.entry.id}`).toBe(`github-copilot/${want[tier]}`);
  });

  it.each([
    "claude-sonnet-5.5", "claude-sonnet-5-5", "anthropic.claude-sonnet-5-5",
    "us.anthropic.claude-sonnet-5-5-20260101-v1:0", "github-copilot/claude-sonnet-5.5",
    "gpt-5", "gpt-5.4", "gpt-5-4", "gpt-5.5", "gpt-5-mini", "openai/gpt-5-6-sol",
    "global.openai.gpt-5-6-sol-20260101-v1:0", "gpt-6-terra", "gpt-6-terra-mini",
    "gpt-6.1-terra", "gpt-6-1-terra", "openai/gpt-6-1-terra-mini-20260101",
    "openai/gpt-5:batch", "openai/gpt-5:free", "openai/gpt-5:thinking",
    "claude-sonnet-5-5-fast", "anthropic/claude-sonnet-5.5:batch",
    "claude-sonnet-5-5@20260101", "claude-sonnet-5-5-2026-01-01",
    "gpt-6-terra@20260101", "openai/gpt-6-terra:free",
    "~openai/gpt-terra-latest", "~anthropic/claude-sonnet-latest",
    "~openai/gpt-mini-latest", "openai/gpt-chat-latest", "~provider/custom-model",
  ])("never automatically selects %s", id => {
    const excluded = catalog(() => [{ provider: "other", id, available: true }]);
    for (const tier of ["light", "standard", "heavy"] as Tier[]) {
      expect(() => pick(excluded, { tier })).toThrow(/no.*models/);
      expect(() => pick(excluded, { tier }, { tierPreference: { light: [id], standard: [id], heavy: [id] } })).toThrow(/no.*models/);
      expect(pick([...excluded, ...entries], { tier }).entry.id).not.toBe(id);
    }
    expect(pick(excluded, { model: `other/${id}` }).entry.id).toBe(id);
    expect(pick(excluded, { role: "worker" }, { defaults: { worker: `other/${id}` } }).entry.id).toBe(id);
  });

  it.each([
    ["openrouter/qwen/qwen3-max", "qwen/qwen3-max"],
    ["anthropic/claude-opus-5", "anthropic/claude-opus-5"],
  ])("honors a custom preference %s even when the id contains a slash", (ref, id) => {
    const models = catalog(() => [
      { provider: "openrouter", id: "anthropic/claude-opus-6", available: true },
      { provider: "openrouter", id: "gemini-3.1-pro-preview", available: true },
      { provider: "openrouter", id, available: true },
    ]);
    const tier = id.includes("opus") ? "heavy" : "standard";
    expect(pick(models, { tier }, { tierPreference: { light: [], standard: [ref], heavy: [ref] } }).entry.id).toBe(id);
  });

  it("lets a normalized preference win over a newer family fallback", () => {
    const models = catalog(() => [
      { provider: "anthropic", id: "claude-opus-6", available: true },
      { provider: "anthropic", id: "claude-opus-5-5", available: true },
    ]);
    expect(pick(models, { role: "reviewer" }).entry.id).toBe("claude-opus-5-5");
  });

  it("compares multi-digit family versions numerically", () => {
    const models = catalog(() => ["claude-opus-4.9", "claude-opus-4.10"].map(id => ({ provider: "other", id, available: true })));
    expect(pick(models, { tier: "heavy" }).entry.id).toBe("claude-opus-4.10");
  });

  it("keeps family priorities when custom preferences are empty", () => {
    const models = catalog(() => ["gpt-6-astra", "claude-opus-5", "claude-sonnet-5", "gpt-6-sol"].map(id => ({ provider: "other", id, available: true })));
    const cfg = { tierPreference: { light: [], standard: [], heavy: [] } };
    expect(pick(models, { tier: "heavy" }, cfg).entry.id).toBe("claude-opus-5");
    expect(pick(models, { tier: "standard" }, cfg).entry.id).toBe("gpt-6-sol");
  });

  it("falls back to an allowed light model when the only standard model is excluded", () => {
    const models = catalog(() => [
      { provider: "other", id: "gpt-5.4", available: true },
      { provider: "google", id: "gemini-3.5-flash", available: true },
    ]);
    expect(pick(models, { tier: "standard" }).entry.id).toBe("gemini-3.5-flash");
  });

  it("excludes a custom preference even when an eligible model remains", () => {
    const models = entries.filter(e => ["gpt-5.4", "gpt-6.1-sol"].includes(e.id));
    expect(pick(models, { tier: "standard" }, { tierPreference: { light: [], standard: ["gpt-5.4"], heavy: [] } }).entry.id).toBe("gpt-6.1-sol");
  });

  it("keeps shipped role thinking ahead of tier-level thinking defaults", () => {
    expect(pick(entries, { role: "reviewer" }, { thinkingDefaults: { heavy: "low" } }).thinkingLevel).toBe("high");
    expect(pick(entries, { tier: "heavy" }, { thinkingDefaults: { heavy: "low" } }).thinkingLevel).toBe("low");
  });

  it("keeps role pins and explicit thinking overrides ahead of the built-in policy", () => {
    expect(pick(entries, { role: "worker" }, { defaults: { worker: "github-copilot/gpt-5.4:low" } })).toMatchObject({ entry: { id: "gpt-5.4" }, thinkingLevel: "low" });
    expect(pick(entries, { role: "reviewer", model: "gpt-6-luna", thinkingLevel: "xhigh" })).toMatchObject({ entry: { id: "gpt-6-luna" }, thinkingLevel: "xhigh" });
    expect(pick(entries, { role: "worker" }, { defaults: { worker: "claude-opus-5.5" }, thinkingDefaults: { worker: "low" } })).toMatchObject({ entry: { id: "claude-opus-5.5" }, thinkingLevel: "low" });
  });
});

const providerCases = [
  ["github-copilot", "gpt-6-sol", "gpt-6-luna", "claude-opus-5.5"],
  ["openai", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra"],
  ["anthropic", "claude-sonnet-5", "claude-haiku-4-5", "claude-opus-5-5"],
  ["google", "gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3.1-pro-preview"],
  ["amazon-bedrock", "anthropic.claude-sonnet-5", "anthropic.claude-haiku-4-5-20251001-v1:0", "anthropic.claude-opus-5-5"],
  ["openrouter", "openai/gpt-6-sol", "openai/gpt-6-luna", "anthropic/claude-opus-5.5"],
] as const satisfies readonly (readonly [BuiltinProvider, string, string, string])[];
function builtinCatalog(provider: BuiltinProvider) {
  return catalog(() => getBuiltinModels(provider).map(m => ({ ...m, available: true, vision: m.input.includes("image"), ctx: m.contextWindow })));
}

const builtinProviders = getBuiltinProviders();
// Independent raw-id checks prevent broken normalization from hiding a forbidden family.
function isExcludedRawId(id: string) {
  const raw = id.toLowerCase();
  return /(?:^|[/.])(?:gpt-5(?:[.:-]|$)|claude-sonnet-5[.-]5(?:[-:@]|$)|gpt-6(?:[.-]\d+)*-terra(?:[-:@]|$))/.test(raw)
    || raw.startsWith("~") || /-latest(?:[:@]|$)/.test(raw);
}

describe("real pi built-in provider fallbacks", () => {
  it("sweeps a non-vacuous catalog including known excluded variants", () => {
    expect(builtinProviders.length).toBeGreaterThanOrEqual(30);
    expect(builtinProviders).toEqual(expect.arrayContaining(["openrouter", "openai", "github-copilot", "amazon-bedrock", "anthropic"]));
    const models = builtinProviders.flatMap(builtinCatalog);
    expect(models.length).toBeGreaterThanOrEqual(500);
    const excluded = models.filter(model => isExcludedRawId(model.id));
    expect(excluded.length).toBeGreaterThanOrEqual(200);
    expect(excluded.map(model => `${model.provider}/${model.id}`)).toContain("openrouter/openai/gpt-5:batch");
    for (const model of excluded) {
      for (const tier of ["light", "standard", "heavy"] as const) {
        expect(() => pick([model], { tier }), `${model.provider}/${model.id} at ${tier}`).toThrow(/no eligible models/);
      }
    }
    process.stdout.write(`CATALOG_SWEEP_TOTAL ${builtinProviders.length} providers, ${models.length} ids, ${excluded.length} excluded\n`);
  });

  it.each(builtinProviders)("sweeps every %s catalog id for automatic exclusions", provider => {
    const models = builtinCatalog(provider);
    expect(models.length, `${provider} catalog must not be empty`).toBeGreaterThan(0);
    let excludedCount = 0;
    for (const model of models) {
      const excluded = isExcludedRawId(model.id);
      if (excluded) excludedCount++;
      for (const tier of ["light", "standard", "heavy"] as const) {
        if (excluded) {
          expect(() => pick([model], { tier }), `${provider}/${model.id} at ${tier}`).toThrow(/no eligible models/);
        } else {
          const selected = pick([model], { tier }).entry;
          expect(normalizeModelId(selected.id), `${provider}/${model.id} at ${tier}`).not.toMatch(/^(?:gpt-5(?:[.-]|$)|claude-sonnet-5\.5(?:[-:]|$)|gpt-6(?:\.\d+)*-terra(?:[-:]|$))/);
        }
      }
    }
    process.stdout.write(`CATALOG_SWEEP ${provider} ${models.length} ids, ${excludedCount} excluded\n`);
  });

  it.each(["reviewer", "oracle"])("prefers the Bedrock base id for %s independently of catalog order", role => {
    const models = builtinCatalog("amazon-bedrock").reverse();
    expect(pick(models, { role }).entry.id).toBe("anthropic.claude-opus-5-5");
    expect(pick(models, { role }, { tierPreference: { light: [], standard: [], heavy: [] } }).entry.id).toBe("anthropic.claude-opus-5-5");
  });

  // Break caught: stale hardcoded preferences or first-in-catalog fallbacks choose older models.
  it.each(providerCases)("resolves shipped roles from the %s-only catalog", (provider, worker, basic, reviewer) => {
    const models = builtinCatalog(provider);
    const defaults = resolveRoleDefaults(models);
    const wanted = { worker, planner: worker, researcher: worker, oracle: reviewer, reviewer, scout: basic, digest: basic, self_name: basic, upstream_watch: basic };
    for (const [role, modelId] of Object.entries(wanted)) {
      const thinking = role === "oracle" ? "medium" : ["scout", "digest", "self_name", "upstream_watch"].includes(role) ? "low" : "high";
      expect(defaults[role]).toBe(`${provider}/${modelId}:${thinking}`);
      expect(models.some(m => `${m.provider}/${m.id}:${thinking}` === defaults[role])).toBe(true);
    }
    process.stdout.write(`PROVIDER_RESOLUTION ${provider} ${JSON.stringify(defaults)}\n`);
  });

  it.each([
    ["claude-opus-5", ["claude-opus-5-5"]],
    ["claude-opus-4-8", ["claude-opus-5-5", "claude-opus-5"]],
  ] as const)("selects newest remaining Anthropic Opus %s independently of catalog order", (expected, removed) => {
    const models = builtinCatalog("anthropic").filter(m => !(removed as readonly string[]).includes(m.id));
    expect(pick(models, { role: "reviewer" }).entry.id).toBe(expected);
    expect(pick([...models].reverse(), { role: "reviewer" }).entry.id).toBe(expected);
  });

  it("uses the newest remaining Sonnet when Sonnet 5 is unavailable", () => {
    const models = builtinCatalog("anthropic").filter(m => m.id !== "claude-sonnet-5");
    expect(pick(models, { role: "worker" }).entry.id).toBe("claude-sonnet-4-6");
  });

  it("falls back from Astra to Sol for OpenAI-only review", () => {
    const models = builtinCatalog("openai").filter(m => m.id !== "gpt-6-astra");
    expect(pick(models, { role: "reviewer" }).entry.id).toBe("gpt-6-sol");
  });
});
