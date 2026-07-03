import { describe, it, expect } from "vitest";
import { RunParams, MessageParams } from "../schemas";
import { Value } from "typebox/value";

describe("schemas", () => {
  it("RunParams accepts a pipeline+handoff shape", () => {
    const ok = Value.Check(RunParams, { pipeline: [{ agent: "worker", role: "impl" }, { agent: "worker", role: "reviewer" }], handoff: "intercom" });
    expect(ok).toBe(true);
  });
  it("RunParams accepts single agent+task", () => {
    expect(Value.Check(RunParams, { agent: "worker", task: "do it" })).toBe(true);
  });
  it("MessageParams requires to+message", () => {
    expect(Value.Check(MessageParams, { to: "reviewer", message: "hi" })).toBe(true);
    expect(Value.Check(MessageParams, { to: "reviewer" })).toBe(false);
  });

});
