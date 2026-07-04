import { describe, it, expect } from "vitest";
import * as pkg from "../index";

describe("@spider/organism", () => {
  it("exports registerOrganism", () => { expect(typeof pkg.registerOrganism).toBe("function"); });
});
