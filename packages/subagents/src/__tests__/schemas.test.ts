import { describe, it, expect } from "vitest";
import { MessageParams } from "../schemas";
import { Value } from "typebox/value";

describe("schemas", () => {
  it("MessageParams requires to+message", () => {
    expect(Value.Check(MessageParams, { to: "reviewer", message: "hi" })).toBe(true);
    expect(Value.Check(MessageParams, { to: "reviewer" })).toBe(false);
  });

});
