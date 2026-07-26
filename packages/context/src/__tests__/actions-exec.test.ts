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

  // The cap is the whole point of routing shell through spider: output lands in the
  // context window VERBATIM, so an unbounded dump costs the session its budget.
  // Mutation this catches: raise MAX_EXEC_OUTPUT_BYTES back toward 200_000 -> fails.
  it("caps model-facing output at 10k bytes", async () => {
    const r = await runExec({
      action: "exec",
      language: "shell",
      // ~50k of output, well past the cap
      code: "for i in $(seq 1 1000); do echo 'the quick brown fox jumps over the lazy dog'; done",
    } as any, ctx);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(10_000);
  });

  // A bare "..." tells the agent nothing. Truncation must say what to do instead,
  // otherwise the model just re-runs the same command and burns the budget twice.
  it("explains what to do instead when it truncates", async () => {
    const r = await runExec({
      action: "exec",
      language: "shell",
      code: "for i in $(seq 1 1000); do echo 'the quick brown fox jumps over the lazy dog'; done",
    } as any, ctx);
    expect(r.text).toMatch(/truncated/i);
    expect(r.text).toMatch(/file|scratch/i);
  });

  it("leaves output under the cap completely untouched", async () => {
    const r = await runExec({ action: "exec", language: "shell", code: "echo small" } as any, ctx);
    expect(r.text).toContain("small");
    expect(r.text).not.toMatch(/truncated/i);
  });

  it("caps batch output too, not just exec", async () => {
    const r = await runBatch({ action: "batch", commands: [
      { language: "shell", code: "for i in $(seq 1 1000); do echo 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; done" },
    ] } as any, ctx);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(10_000);
  });
});
