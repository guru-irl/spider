// spider/packages/context/src/__tests__/smoke.test.ts
import { describe, it, expect } from "vitest";
import { registerContextActions } from "../index";

describe("@spider/context", () => {
  it("exports registerContextActions", () => {
    expect(typeof registerContextActions).toBe("function");
  });
});
