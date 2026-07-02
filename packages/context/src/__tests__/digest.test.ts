import { describe, it, expect } from "vitest";
import { defaultDigest } from "../digest.js";

describe("defaultDigest (Phase 2 stub)", () => {
  it("produces zero candidates and a truncated summary without calling a model", async () => {
    const r = await defaultDigest(
      { sessionId: "s", sourcePath: "/x", messages: [{ role: "user", text: "hello world" }] },
      {},
    );
    expect(r.candidates).toEqual([]);
    expect(typeof r.summary).toBe("string");
    expect(r.summary).toContain("hello world");
  });

  it("truncates the joined summary to 500 chars", async () => {
    const big = "x".repeat(2000);
    const r = await defaultDigest(
      { sessionId: "s", sourcePath: "/x", messages: [{ role: "user", text: big }] },
      {},
    );
    expect(r.summary!.length).toBe(500);
  });
});
