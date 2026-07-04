import { describe, it, expect } from "vitest";
import { emptyResult } from "../types.js";

describe("organism types", () => {
  it("emptyResult is a zeroed DigestResult", () => {
    const r = emptyResult();
    expect(r.memory).toEqual([]);
    expect(r.todos).toEqual([]);
    expect(r.skills).toEqual([]);
  });
});
