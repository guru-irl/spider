import { describe, it, expect } from "vitest";
import spiderExtension from "../extension";

// Enters through the REAL registered tool, not a hand-built ctx. The recurring defect on
// this branch was a correct unit whose production wiring was never invoked, hidden by a
// test that supplied the missing call itself. So: register the real extension, grab the
// real tool, and call its real execute().
function mountAndGetTool() {
  let tool: any;
  const pi: any = {
    // NOTE: the extension also registers edit/write overrides, so match by NAME.
    registerTool: (t: any) => { if (t?.name === "spider") tool = t; },
    registerCommand: () => {}, registerMessageRenderer: () => {}, registerRenderer: () => {},
    registerShortcut: () => {}, on: () => pi, sendMessage: () => {}, addMessage: () => {},
  };
  spiderExtension(pi);
  return tool;
}

describe("exec streaming is wired into the real tool", () => {
  it("fires an empty update FIRST so the result section exists before any output", async () => {
    const tool = mountAndGetTool();
    const updates: any[] = [];
    await tool.execute("id-1", { action: "exec", language: "shell", code: "echo hi" },
      undefined, (u: any) => updates.push(u), { cwd: process.cwd(), sessionId: "s-stream-1" });
    expect(updates.length).toBeGreaterThan(0);
    // Mutation this catches: delete the priming emit -> first update carries content.
    expect(updates[0].content).toEqual([]);
  });

  it("streams cumulative output through onUpdate before the command exits", async () => {
    const tool = mountAndGetTool();
    const updates: any[] = [];
    await tool.execute("id-2",
      { action: "exec", language: "shell", code: "echo alpha; sleep 0.2; echo beta" },
      undefined, (u: any) => updates.push(u), { cwd: process.cwd(), sessionId: "s-stream-2" });
    const withText = updates.filter((u) => (u.content ?? []).length > 0);
    // Mutation this catches: stop passing onPartial -> only the priming empty update arrives.
    expect(withText.length).toBeGreaterThan(0);
    expect(withText[withText.length - 1].content[0].text).toContain("alpha");
  });

  it("non-exec actions do NOT stream (no spurious empty result section)", async () => {
    const tool = mountAndGetTool();
    const updates: any[] = [];
    await tool.execute("id-3", { action: "todo", op: "list" },
      undefined, (u: any) => updates.push(u), { cwd: process.cwd(), sessionId: "s-stream-3" });
    expect(updates.length).toBe(0);
  });

  it("a host without onUpdate still executes normally", async () => {
    const tool = mountAndGetTool();
    const r = await tool.execute("id-4", { action: "exec", language: "shell", code: "echo ok" },
      undefined, undefined, { cwd: process.cwd(), sessionId: "s-stream-4" });
    expect(JSON.stringify(r)).toContain("ok");
  });
});
