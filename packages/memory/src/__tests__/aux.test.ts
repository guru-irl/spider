import { describe, it, expect } from "vitest";
import { resolveAuxRuntime, digestHistory } from "../aux.js";
describe("aux routing + digest", () => {
  it("marks routed when aux model differs from parent", () => {
    const rt = resolveAuxRuntime({ auxiliary: { background_review: { provider: "openai", model: "gpt-4o-mini" } } }, "claude-sonnet");
    expect(rt.routed).toBe(true); expect(rt.model).toBe("gpt-4o-mini");
  });
  it("not routed when aux config empty", () => {
    expect(resolveAuxRuntime({}, "claude-sonnet").routed).toBe(false);
  });
  it("digest collapses older turns, keeps tail verbatim", () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 ? "assistant" as const : "user" as const), content: `m${i}` }));
    const d = digestHistory(msgs, 24);
    expect(d[0].role).toBe("user");
    expect(d[0].content).toContain("digest");
    expect(d).toHaveLength(25); // 1 digest + 24 tail
  });
});
