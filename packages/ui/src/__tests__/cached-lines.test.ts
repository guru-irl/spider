import { describe, expect, it } from "vitest";
import { cachedLines } from "../index";

describe("cachedLines", () => {
  it("keeps only the latest width and returns the original computed array", () => {
    const widths: number[] = [];
    const rows: string[][] = [];
    const component = cachedLines(width => {
      widths.push(width);
      const output = [`width ${width}`];
      rows.push(output);
      return output;
    });
    const first = component.render(80);
    expect(first).toBe(rows[0]);
    expect(component.render(80)).toBe(first);
    expect(widths).toEqual([80]);
    const narrow = component.render(40);
    expect(narrow).toEqual(["width 40"]);
    expect(component.render(40)).toBe(narrow);
    expect(component.render(80)).not.toBe(first);
    expect(widths).toEqual([80, 40, 80]);
  });

  it("clears cached rows and forwards invalidation before the next computation", () => {
    let state = "old";
    let calls = 0;
    let invalidations = 0;
    const component = cachedLines(() => { calls++; return [state]; }, () => { state = "new"; invalidations++; });
    const first = component.render(80);
    component.invalidate?.();
    expect(invalidations).toBe(1);
    expect(calls).toBe(1);
    const updated = component.render(80);
    expect(updated).toEqual(["new"]);
    expect(updated).not.toBe(first);
    expect(component.render(80)).toBe(updated);
    expect(calls).toBe(2);
  });

  it("caches empty output and can invalidate before its first render", () => {
    let calls = 0;
    const component = cachedLines(() => { calls++; return []; });
    component.invalidate?.();
    const first = component.render(0);
    expect(first).toEqual([]);
    expect(component.render(0)).toBe(first);
    expect(calls).toBe(1);
    component.invalidate?.();
    expect(component.render(0)).not.toBe(first);
    expect(calls).toBe(2);
  });

  it("refreshes only when a live content key changes", () => {
    let revision = 0;
    let calls = 0;
    const component = cachedLines(() => { calls++; return [`revision ${revision}`]; }, undefined, () => revision);
    const first = component.render(80);
    expect(component.render(80)).toBe(first);
    expect(calls).toBe(1);
    revision = 1;
    const updated = component.render(80);
    expect(updated).toEqual(["revision 1"]);
    expect(updated).not.toBe(first);
    expect(component.render(80)).toBe(updated);
    expect(calls).toBe(2);
  });

  it("does not cache a failed computation under the requested width", () => {
    let fail = true;
    const component = cachedLines(width => {
      if (width === 40 && fail) throw new Error("not ready");
      return [`width ${width}`];
    });
    const first = component.render(80);
    expect(() => component.render(40)).toThrow("not ready");
    expect(component.render(80)).toBe(first);
    fail = false;
    expect(component.render(40)).toEqual(["width 40"]);
  });
});
