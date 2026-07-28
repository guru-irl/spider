import { describe, it, expect } from "vitest";
import spiderExtension from "../extension";

// Enters through the REAL registered tool, not a hand-built ctx — same rationale as
// exec-stream-wiring.test.ts: a correct Executor unit is worthless if extension.ts never
// threads pi's AbortSignal down to it. That is exactly the shape of the original bug —
// `_signal` was underscore-prefixed and silently discarded at the very top of the chain,
// even though pi genuinely supplies a real AbortSignal on Escape.
function mountAndGetTool() {
  let tool: any;
  const pi: any = {
    registerTool: (t: any) => { if (t?.name === "spider") tool = t; },
    registerCommand: () => {}, registerMessageRenderer: () => {}, registerRenderer: () => {},
    registerShortcut: () => {}, on: () => pi, sendMessage: () => {}, addMessage: () => {},
  };
  spiderExtension(pi);
  return tool;
}

describe("Escape (pi's real AbortSignal) reaches the spawned process end-to-end", () => {
  // Mutation this catches: revert extension.ts to `_signal` (ignored) -> this call waits
  // out the full 5s sleep instead of returning promptly, and the failure below is loud.
  it("aborting the real tool call kills the running exec instead of waiting it out", async () => {
    const tool = mountAndGetTool();
    const ac = new AbortController();
    const start = Date.now();
    const resultPromise = tool.execute(
      "abort-1",
      { action: "exec", language: "shell", code: "sleep 5" },
      ac.signal,
      undefined,
      { cwd: process.cwd(), sessionId: "s-abort-1" },
    );
    setTimeout(() => ac.abort(), 150);
    const result: any = await resultPromise;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    // toToolResult surfaces the aborted marker in details/text — not a silent success.
    expect(JSON.stringify(result)).toMatch(/abort/i);
  });

  // A signal slot that ISN'T a real AbortSignal (legacy test shape, or a future host that
  // passes something else) must degrade to "no signal" rather than crashing on
  // .addEventListener/.aborted.
  it("a bare object in the signal slot degrades to no-signal instead of crashing", async () => {
    const tool = mountAndGetTool();
    const result = await tool.execute(
      "abort-2",
      { action: "exec", language: "shell", code: "echo ok" },
      {},
      undefined,
      { cwd: process.cwd(), sessionId: "s-abort-2" },
    );
    expect(JSON.stringify(result)).toContain("ok");
  });
});
