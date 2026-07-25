import { describe, it, expect } from "vitest";
import { registerHooks, HOOK_NAMES, type PiLikeAPI } from "../hooks";

describe("registerHooks (Phase 0 empty handlers)", () => {
  it("registers a handler for every contract hook name", () => {
    const registered: string[] = [];
    const pi: PiLikeAPI = { on(name) { registered.push(name); } };
    registerHooks(pi);
    for (const name of HOOK_NAMES) expect(registered).toContain(name);
    expect(registered).toHaveLength(HOOK_NAMES.length);
  });

  it("tool_call is registered for bash enforcement; routing separately handles tracking", () => {
    // tool_call is in HOOK_NAMES for exec enforcement (blocks bash).
    // Routing ALSO registers tool_call for tracking (never blocks).
    // Both handlers can coexist; pi calls them in order.
    expect(HOOK_NAMES as readonly string[]).toContain("tool_call");
    // tool_result remains routing-only
    expect(HOOK_NAMES as readonly string[]).not.toContain("tool_result");
    expect(HOOK_NAMES as readonly string[]).not.toContain("beforeToolCall");
    expect(HOOK_NAMES as readonly string[]).not.toContain("afterToolCall");
  });

  it("returns undefined for lifecycle no-ops and contributes skillPaths for resources_discover", () => {
    const handlers: Record<string, (...a: unknown[]) => unknown> = {};
    const pi: PiLikeAPI = { on(name, fn) { handlers[name] = fn; } };
    registerHooks(pi);
    for (const name of HOOK_NAMES) {
      if (name === "resources_discover" || name === "tool_call") continue;
      expect(handlers[name]()).toBeUndefined();
    }
    const res = handlers["resources_discover"]({ cwd: process.cwd(), reason: "startup" }) as { skillPaths?: string[] };
    expect(Array.isArray(res.skillPaths)).toBe(true);
    expect(res.skillPaths!.length).toBeGreaterThanOrEqual(1);
  });
});
