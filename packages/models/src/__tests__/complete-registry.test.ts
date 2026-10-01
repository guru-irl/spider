import { describe, it, expect, vi } from "vitest";
import { complete } from "../index";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

type FakeRegistry = Pick<ModelRegistry, "find" | "streamSimple">;

// Minimal but real-shaped @earendil-works/pi-ai AssistantMessage. Only fields complete()
// actually reads vary per test; the rest are plausible placeholders so the object satisfies
// the real public type (the same type registry.streamSimple().result() returns in production).
function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello world" }],
    api: "anthropic-messages",
    provider: "acme",
    model: "model-x",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

// vi.fn callbacks get explicit param signatures so mock.calls[n] is a fixed-length tuple
// (not `[]`), and the whole object is cast at the boundary to the real registry seam type —
// the cast affects only how strictly this fixture's own shape is checked, not runtime behavior.
function makeRegistry(opts: {
  find?: (provider: string, id: string) => unknown;
  complete?: (model: unknown, context: unknown, options: unknown) => Promise<AssistantMessage>;
}): FakeRegistry & { find: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn> } {
  const find = vi.fn((provider: string, id: string) => opts.find?.(provider, id));
  const complete = vi.fn((model: unknown, context: unknown, options: unknown) =>
    (opts.complete ?? (async () => assistantMessage()))(model, context, options),
  );
  const streamSimple = (model: unknown, context: unknown, options: unknown) => ({ result: () => complete(model, context, options) });
  return { find, complete, streamSimple } as unknown as FakeRegistry & { find: typeof find; complete: typeof complete };
}

describe("complete() — default path against a real ModelRegistry-shaped dependency", () => {
  it("resolves the full handle via registry.find and passes it (not a reconstructed object) to registry.streamSimple", async () => {
    const fakeHandle = { provider: "acme", id: "model-x", customConfig: { baseUrl: "https://custom.example" } };
    const registry = makeRegistry({ find: (provider, id) => (provider === "acme" && id === "model-x" ? fakeHandle : undefined) });

    const model = { provider: "acme", id: "model-x", tier: "standard" as const, thinking: true, vision: false, ctx: 128000, speed: 1, costHint: 1, available: true };

    const text = await complete(model, "say hi", { registry });

    expect(registry.find).toHaveBeenCalledWith("acme", "model-x");
    expect(registry.complete).toHaveBeenCalledTimes(1);
    const [passedHandle] = registry.complete.mock.calls[0]!;
    expect(passedHandle).toBe(fakeHandle); // identity: the resolved handle, not a rebuilt shape
    expect(text).toBe("hello world");
  });

  it("puts system into Context.systemPrompt and sends a timestamped user message", async () => {
    const registry = makeRegistry({ find: () => ({ provider: "acme", id: "model-x", reasoning: true }) });
    const model = { provider: "acme", id: "model-x", tier: "standard" as const, thinking: false, vision: false, ctx: 1, speed: 1, costHint: 1, available: true };

    const before = Date.now();
    await complete(model, "say hi", { registry, system: "be nice" });
    const after = Date.now();

    const [, context] = registry.complete.mock.calls[0]! as [unknown, { systemPrompt?: string; messages: { role: string; content: unknown; timestamp: number }[] }];
    expect(context.systemPrompt).toBe("be nice");
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]!.role).toBe("user");
    expect(context.messages[0]!.content).toBe("say hi");
    expect(typeof context.messages[0]!.timestamp).toBe("number");
    expect(context.messages[0]!.timestamp).toBeGreaterThanOrEqual(before);
    expect(context.messages[0]!.timestamp).toBeLessThanOrEqual(after);
  });

  it("maps thinking to reasoning (not thinkingLevel) and propagates signal + maxTokens", async () => {
    const registry = makeRegistry({ find: () => ({ provider: "acme", id: "model-x", reasoning: true }) });
    const model = { provider: "acme", id: "model-x", tier: "standard" as const, thinking: true, vision: false, ctx: 1, speed: 1, costHint: 1, available: true };
    const controller = new AbortController();

    await complete(model, "say hi", { registry, thinkingLevel: "high", maxTokens: 512, signal: controller.signal });

    const [, , options] = registry.complete.mock.calls[0]! as [unknown, unknown, { reasoning?: string; thinkingLevel?: string; maxTokens?: number; signal?: AbortSignal }];
    expect(options.reasoning).toBe("high");
    expect(options.thinkingLevel).toBeUndefined();
    expect(options.maxTokens).toBe(512);
    expect(options.signal).toBe(controller.signal);
  });

  it("threads a PickResult's resolved thinkingLevel into reasoning when opts.thinkingLevel is absent", async () => {
    const registry = makeRegistry({ find: () => ({ provider: "acme", id: "model-x", reasoning: true }) });
    const picked = { entry: { provider: "acme", id: "model-x", tier: "heavy" as const, thinking: true, vision: false, ctx: 1, speed: 1, costHint: 1, available: true }, thinkingLevel: "low" as const };

    await complete(picked, "hi", { registry });

    const [, , options] = registry.complete.mock.calls[0]! as [unknown, unknown, { reasoning?: string }];
    expect(options.reasoning).toBe("low");
  });

  it("rejects with the provider error even when partial text is present", async () => {
    const registry = makeRegistry({
      find: () => ({ provider: "acme", id: "model-x", reasoning: true }),
      complete: async () => assistantMessage({ stopReason: "error", errorMessage: "provider exploded", content: [{ type: "text", text: "partial" }] }),
    });
    const model = { provider: "acme", id: "model-x", tier: "standard" as const, thinking: false, vision: false, ctx: 1, speed: 1, costHint: 1, available: true };

    await expect(complete(model, "hi", { registry })).rejects.toThrow(/completion error.*provider exploded/i);
  });

  it("rejects when stopReason is 'aborted'", async () => {
    const registry = makeRegistry({
      find: () => ({ provider: "acme", id: "model-x", reasoning: true }),
      complete: async () => assistantMessage({ stopReason: "aborted", errorMessage: "provider cancelled fixture", content: [] }),
    });
    const model = { provider: "acme", id: "model-x", tier: "standard" as const, thinking: false, vision: false, ctx: 1, speed: 1, costHint: 1, available: true };

    await expect(complete(model, "hi", { registry })).rejects.toThrow(/aborted.*provider cancelled fixture/i);
  });

  it("rejects on an empty completion instead of returning empty success", async () => {
    const registry = makeRegistry({
      find: () => ({ provider: "acme", id: "model-x", reasoning: true }),
      complete: async () => assistantMessage({ content: [] }),
    });
    const model = { provider: "acme", id: "model-x", tier: "standard" as const, thinking: false, vision: false, ctx: 1, speed: 1, costHint: 1, available: true };

    await expect(complete(model, "hi", { registry })).rejects.toThrow(/empty|no text/i);
  });

  it("rejects with an actionable error when no registry is supplied and no CompleteDeps are injected", async () => {
    const model = { provider: "acme", id: "model-x", tier: "standard" as const, thinking: false, vision: false, ctx: 1, speed: 1, costHint: 1, available: true };

    await expect(complete(model, "hi", {})).rejects.toThrow(/registry/i);
  });

  it("rejects with an actionable error when the registry cannot find the requested model", async () => {
    const registry = makeRegistry({ find: () => undefined });
    const model = { provider: "acme", id: "missing-model", tier: "standard" as const, thinking: false, vision: false, ctx: 1, speed: 1, costHint: 1, available: true };

    await expect(complete(model, "hi", { registry })).rejects.toThrow(/acme\/missing-model|not found/i);
    expect(registry.complete).not.toHaveBeenCalled();
  });
});


describe("per-model thinking at the completion boundary", () => {
  const entry = { provider: "acme", id: "model-x", tier: "standard" as const, thinking: true, vision: false, ctx: 1, speed: 1, costHint: 1, available: true };
  it.each([
    ["supported", { reasoning: true, thinkingLevelMap: { max: "maximum" } }, "max", "max", undefined],
    ["capped", { reasoning: true, thinkingLevelMap: { xhigh: "extra", max: null } }, "max", "xhigh", /thinking capped: requested max.*xhigh/],
    ["hole prefers higher", { reasoning: true, thinkingLevelMap: { xhigh: null, max: "maximum" } }, "xhigh", "max", /thinking adjusted: requested xhigh.*max/],
    ["non-reasoning", { reasoning: false }, "max", undefined, /thinking is off for this model/],
  ])("%s", async (_name, capabilities, requested, effective, note) => {
    const registry = makeRegistry({ find: () => ({ ...capabilities, provider: "acme", id: "model-x" }) });
    const diagnostics: any[] = [];
    await complete(entry, "hi", { registry, thinkingLevel: requested as any, onThinking: (info: any) => diagnostics.push(info) } as any);
    const options = registry.complete.mock.calls[0]![2] as any;
    expect(options.reasoning).toBe(effective);
    expect(options.reasoningEffort).toBeUndefined();
    if (note) expect(diagnostics[0].notice).toMatch(note);
    else expect(diagnostics[0].notice).toBeUndefined();
  });
  it("unknown model reports an unverified request and never calls a model", async () => {
    const registry = makeRegistry({ find: () => undefined });
    const diagnostics: any[] = [];
    await expect(complete(entry, "hi", { registry, thinkingLevel: "max", onThinking: (info: any) => diagnostics.push(info) } as any)).rejects.toThrow(/not found/);
    expect(registry.complete).not.toHaveBeenCalled();
    expect(diagnostics[0]).toMatchObject({ requested: "max", effective: undefined, notice: expect.stringMatching(/unknown model.*cannot verify/) });
  });
});


it("uses authenticated streamSimple so provider-neutral reasoning is actually mapped", async () => {
  const entry = { provider: "acme", id: "model-x", tier: "standard" as const, thinking: true, vision: false, ctx: 1, speed: 1, costHint: 1, available: true };
  let seen: any;
  const registry = {
    find: () => ({ reasoning: true, thinkingLevelMap: { max: "maximum" } }),
    complete: () => { throw Error("raw complete does not map reasoning for all providers"); },
    streamSimple: (_model: any, _context: any, options: any) => { seen = options; return { result: async () => assistantMessage() }; },
  };
  expect(await complete(entry, "fixture", { registry: registry as any, thinkingLevel: "max" })).toBe("hello world");
  expect(seen.reasoning).toBe("max");
});


it("rejects a whitespace-only completion instead of reporting empty success", async () => {
  const registry = makeRegistry({ find: () => ({ reasoning: true }), complete: async () => assistantMessage({ content: [{ type: "text", text: " \n " }] }) });
  const model = { provider: "acme", id: "model-x", tier: "standard" as const, thinking: true, vision: false, ctx: 1, speed: 1, costHint: 1, available: true };
  await expect(complete(model, "fixture", { registry })).rejects.toThrow(/no text/);
});
