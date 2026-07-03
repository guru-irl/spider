import { describe, it, expect } from "vitest";
import { registerHooks, HOOK_NAMES, type PiLikeAPI } from "../hooks.js";

describe("registerHooks (Phase 0 empty handlers)", () => {
  it("registers a handler for every contract hook name", () => {
    const registered: string[] = [];
    const pi: PiLikeAPI = { on(name) { registered.push(name); } };
    registerHooks(pi);
    for (const name of HOOK_NAMES) expect(registered).toContain(name);
    expect(registered).toHaveLength(HOOK_NAMES.length);
  });

  it("no longer owns the tool-hook events (tool_call/tool_result moved to routing in Task 7b), and never used the draft beforeToolCall/afterToolCall names", () => {
    // Ownership of tool_call/tool_result transferred to packages/host/src/routing
    // (wired in extension.ts) to avoid double-registration.
    expect(HOOK_NAMES as readonly string[]).not.toContain("tool_call");
    expect(HOOK_NAMES as readonly string[]).not.toContain("tool_result");
    expect(HOOK_NAMES as readonly string[]).not.toContain("beforeToolCall");
    expect(HOOK_NAMES as readonly string[]).not.toContain("afterToolCall");
  });

  it("every registered handler is a pass-through no-op (returns undefined)", () => {
    const handlers: Record<string, (...a: unknown[]) => unknown> = {};
    const pi: PiLikeAPI = { on(name, fn) { handlers[name] = fn; } };
    registerHooks(pi);
    for (const name of HOOK_NAMES) expect(handlers[name]()).toBeUndefined();
  });
});
