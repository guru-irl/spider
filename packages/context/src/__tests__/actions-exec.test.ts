import { describe, it, expect } from "vitest";
import { runExec, runBatch } from "../actions/exec";

const ctx = { cwd: process.cwd() };

describe("exec actions", () => {
  it("exec runs code and returns model-facing stdout text", async () => {
    const r = await runExec({ action: "exec", language: "javascript", code: "console.log('hi')" } as any, ctx);
    expect(r.text).toContain("hi");
    expect((r.details as any).exitCode).toBe(0);
  });

  it("batch runs multiple commands and concatenates labeled output", async () => {
    const r = await runBatch({ action: "batch", commands: [
      { language: "javascript", code: "console.log(1)" },
      { language: "shell", code: "echo two" },
    ] } as any, ctx);
    expect(r.text).toContain("1");
    expect(r.text).toContain("two");
  });
});
