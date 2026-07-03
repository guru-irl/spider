import { describe, it, expect } from "vitest";
import * as pkg from "../index.js";

describe("@spider/subagents", () => {
  it("exports registerSubagentActions", () => {
    expect(typeof pkg.registerSubagentActions).toBe("function");
  });
});
