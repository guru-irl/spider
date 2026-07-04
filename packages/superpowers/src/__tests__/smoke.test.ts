import { describe, it, expect } from "vitest";
import * as pkg from "../index.js";

describe("@spider/superpowers", () => {
  it("exports registerSuperpowers and contributeSkillPaths", () => {
    expect(typeof pkg.registerSuperpowers).toBe("function");
    expect(typeof pkg.contributeSkillPaths).toBe("function");
  });
});
