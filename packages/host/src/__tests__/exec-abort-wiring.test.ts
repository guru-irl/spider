import { describe, it, expect } from "vitest";
import spiderExtension from "../extension";
import { isolatedCwd } from "./isolated-cwd";
const fixtureCwd = isolatedCwd("exec-abort-wiring");

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
  // out the full 8s sleep and prints SHOULD_NOT_RUN; the outcome check fails.
  // No abort-latency bound: this tolerates scheduling load, but a late kill
  // before the post-sleep output can still pass.
  it("aborting the real tool call kills the running exec instead of waiting it out", async () => {
    const tool = mountAndGetTool();
    const ac = new AbortController();
    let childPid: number | undefined;
    const resultPromise = tool.execute(
      "abort-1",
      { action: "exec", language: "shell", code: "echo READY:$$; sleep 8; echo SHOULD_NOT_RUN" },
      ac.signal,
      (update: any) => {
        const text = update?.content?.[0]?.text ?? "";
        const match = text.match(/READY:(\d+)/);
        if (match) { childPid = Number(match[1]); ac.abort(); }
      },
      { cwd: fixtureCwd, sessionId: "s-abort-1" },
    );
    const result: any = await resultPromise;

    expect(childPid).toBeGreaterThan(0); // output came from the running child
    expect(result.details.aborted).toBe(true);
    expect(result.details.outcome).toBe("aborted");
    expect(JSON.stringify(result)).not.toContain("SHOULD_NOT_RUN");
    // A dropped stream (without killing the command) cannot satisfy this.
    expect(() => process.kill(childPid!, 0)).toThrow();
  }, 20_000);

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
      { cwd: fixtureCwd, sessionId: "s-abort-2" },
    );
    expect(JSON.stringify(result)).toContain("ok");
  });
});
