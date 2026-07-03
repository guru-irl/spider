import { describe, it, expect } from "vitest";
import { diffLines, hasChanges } from "../agents/diff.js";

describe("diffLines", () => {
  it("reports no change for identical arrays", () => {
    const d = diffLines(["a","b"], ["a","b"]);
    expect(d.changed).toEqual([]);
    expect(d.lengthChanged).toBe(false);
    expect(hasChanges(d)).toBe(false);
  });
  it("reports only changed indices", () => {
    const d = diffLines(["a","b","c"], ["a","B","c"]);
    expect(d.changed).toEqual([{ index: 1, line: "B" }]);
    expect(hasChanges(d)).toBe(true);
  });
  it("reports appended lines", () => {
    const d = diffLines(["a"], ["a","b"]);
    expect(d.changed).toEqual([{ index: 1, line: "b" }]);
    expect(d.lengthChanged).toBe(true);
  });
  it("reports removed tail", () => {
    const d = diffLines(["a","b","c"], ["a"]);
    expect(d.removedFrom).toBe(1);
    expect(d.lengthChanged).toBe(true);
    expect(hasChanges(d)).toBe(true);
  });
});
