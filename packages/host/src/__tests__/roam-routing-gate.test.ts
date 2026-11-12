import { expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerRouting } from "../routing/index";

it("refuses tool routing and edit/write execution without opening a DB", async () => {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const pi = { on: (name: string, handler: Function) => { handlers.set(name, handler); }, registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
  const db = vi.fn(() => { throw new Error("must not open a DB"); });
  const delegate = vi.fn(async () => ({ content: [{ type: "text", text: "executed" }], details: {} }));
  const deps = { get db() { return db(); }, getSessionId: () => "session-1", getCwd: () => "/unavailable", admitted: () => false,
    makeEditDelegate: () => ({ execute: delegate }), makeWriteDelegate: () => ({ execute: delegate }),
    config: { tracking: true, secretScrub: true, injectionScan: true, autoIndexThreshold: 1 } };
  registerRouting(pi, deps);
  expect(handlers.get("tool_call")!({ toolName: "write", input: {} }, {} as ExtensionContext)).toMatchObject({ block: true });
  expect(handlers.get("tool_result")!({ toolName: "write", content: [{ type: "text", text: "result" }] })).toBeUndefined();
  for (const name of ["edit", "write"]) {
    const result = await tools.get(name)!.execute("call", { path: "ignored", description: "test", content: "no", edits: [] }, undefined, undefined, {});
    expect(result.isError).toBe(true);
  }
  expect(db).not.toHaveBeenCalled();
  expect(delegate).not.toHaveBeenCalled();
}, 5000);
