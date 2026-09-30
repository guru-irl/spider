import { describe, it, expect, vi } from "vitest";
import spiderExtension from "../extension";
import * as context from "@spider/context";
import { isolatedCwd } from "./isolated-cwd";
const fixtureCwd = isolatedCwd("exec-stream-wiring");

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
  it("registers a context handler that repairs historic blank built-in tool errors", async () => {
    let contextHandler: ((event: any) => unknown) | undefined;
    const pi: any = {
      registerTool: () => {}, registerCommand: () => {}, registerMessageRenderer: () => {},
      registerShortcut: () => {}, on: (name: string, handler: (event: any) => unknown) => {
        if (name === "context") contextHandler = handler;
        return () => {};
      },
    };
    spiderExtension(pi);
    expect(contextHandler).toBeTypeOf("function");
    const bad = { role: "toolResult", toolName: "bash", toolCallId: "old",
      content: [{ type: "text", text: "" }], isError: true, timestamp: 1 };
    const result: any = await contextHandler!({ type: "context", messages: [bad] });
    expect(result.messages[0].content).toEqual([{ type: "text", text: "(tool error with no message)" }]);
    expect(await contextHandler!({ type: "context", messages: [
      { ...bad, content: [{ type: "text", text: "ok" }] },
    ] })).toBeUndefined();
  });
  it("does not throw when a malformed context event cannot expose its messages", async () => {
    let contextHandler: ((event: any) => unknown) | undefined;
    const pi: any = {
      registerTool: () => {}, registerCommand: () => {}, registerMessageRenderer: () => {},
      registerShortcut: () => {}, on: (name: string, handler: (event: any) => unknown) => {
        if (name === "context") contextHandler = handler;
        return () => {};
      },
    };
    spiderExtension(pi);
    expect(contextHandler).toBeTypeOf("function");
    const malformed = { get messages(): never { throw new Error("unreadable event"); } };
    expect(() => contextHandler!(malformed)).not.toThrow();
    expect(contextHandler!(null)).toBeUndefined();
  });

  it("returns a model-facing error with exit code for a silent failed exec", async () => {
    const tool = mountAndGetTool();
    const result = await tool.execute("id-silent-fail", { action: "exec", language: "shell", code: "exit 1" },
      undefined, undefined, { cwd: fixtureCwd, sessionId: "s-silent-fail" });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ stdout: "", stderr: "", exitCode: 1 });
    expect(result.content[0].text).toMatch(/exit 1.*no output/i);
  });

  it.each([
    ["newline", "printf '\\n'; exit 1", 1],
    ["spaces", "printf '   '; exit 3", 3],
  ])("replaces %s-only failed exec output with model-facing status", async (_label, code, exitCode) => {
    const tool = mountAndGetTool();
    const result = await tool.execute(`id-blank-${exitCode}`, { action: "exec", language: "shell", code },
      undefined, undefined, { cwd: fixtureCwd, sessionId: `s-blank-${exitCode}` });
    expect(result.isError).toBe(true);
    expect(result.details.exitCode).toBe(exitCode);
    expect(result.content[0].text).toBe(`exit ${exitCode} (no output)`);
  });

  it("returns non-empty model-facing text for a successful silent exec", async () => {
    const tool = mountAndGetTool();
    const result = await tool.execute("id-silent-ok", { action: "exec", language: "shell", code: "true" },
      undefined, undefined, { cwd: fixtureCwd, sessionId: "s-silent-ok" });
    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
    expect(result.content[0].text).toBe("(no output)");
  });

  it.each([new Error(""), new TypeError(""), "", new Error("original failure")])("keeps thrown handler errors model-readable: %o", async (thrown) => {
    const register = context.registerContextActions;
    // Install the fault before the activation captures its own handlers. A
    // global replacement must not override a live activation's exec closure.
    const injection = vi.spyOn(context, "registerContextActions").mockImplementation(registerAction => {
      register((name, handler) => registerAction(name, name === "exec" ? () => { throw thrown; } : handler));
    });
    try {
      const tool = mountAndGetTool();
      const call = tool.execute("id-throw", { action: "exec" }, undefined, undefined,
        { cwd: fixtureCwd, sessionId: "s-throw" });
      if (thrown instanceof Error && thrown.message) {
        await expect(call).rejects.toBe(thrown);
      } else {
        const kind = thrown instanceof Error ? thrown.constructor.name : typeof thrown;
        await expect(call).rejects.toMatchObject({ message: `spider exec failed: ${kind} with no message`, cause: thrown });
      }
    } finally { injection.mockRestore(); }
  });

  it("keeps the empty priming update UI-only while settling to non-empty text", async () => {
    const tool = mountAndGetTool();
    const updates: any[] = [];
    const result = await tool.execute("id-priming", { action: "exec", language: "shell", code: "exit 1" },
      undefined, (u: any) => updates.push(u), { cwd: fixtureCwd, sessionId: "s-priming" });
    expect(updates[0].content).toEqual([]);
    expect(result.content[0].text).toMatch(/exit 1.*no output/i);
  });

  it("fires an empty update FIRST so the result section exists before any output", async () => {
    const tool = mountAndGetTool();
    const updates: any[] = [];
    await tool.execute("id-1", { action: "exec", language: "shell", code: "echo hi" },
      undefined, (u: any) => updates.push(u), { cwd: fixtureCwd, sessionId: "s-stream-1" });
    expect(updates.length).toBeGreaterThan(0);
    // Mutation this catches: delete the priming emit -> first update carries content.
    expect(updates[0].content).toEqual([]);
  });

  it("streams cumulative output through onUpdate before the command exits", async () => {
    const tool = mountAndGetTool();
    const updates: any[] = [];
    await tool.execute("id-2",
      { action: "exec", language: "shell", code: "echo alpha; sleep 0.2; echo beta" },
      undefined, (u: any) => updates.push(u), { cwd: fixtureCwd, sessionId: "s-stream-2" });
    const withText = updates.filter((u) => (u.content ?? []).length > 0);
    // Mutation this catches: stop passing onPartial -> only the priming empty update arrives.
    expect(withText.length).toBeGreaterThan(0);
    expect(withText[withText.length - 1].content[0].text).toContain("alpha");
  });

  it("non-exec actions do NOT stream (no spurious empty result section)", async () => {
    const tool = mountAndGetTool();
    const updates: any[] = [];
    await tool.execute("id-3", { action: "todo", op: "list" },
      undefined, (u: any) => updates.push(u), { cwd: fixtureCwd, sessionId: "s-stream-3" });
    expect(updates.length).toBe(0);
  });

  it("a host without onUpdate still executes normally", async () => {
    const tool = mountAndGetTool();
    const r = await tool.execute("id-4", { action: "exec", language: "shell", code: "echo ok" },
      undefined, undefined, { cwd: fixtureCwd, sessionId: "s-stream-4" });
    expect(JSON.stringify(r)).toContain("ok");
  });
});
