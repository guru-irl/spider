import { describe, expect, it } from "vitest";
import { renderPace, disposePace } from "../web/pace.js";
import { overviewFixture } from "./fixtures/redesign-contract.js";
import { PlainDocument, descendants, elements } from "./fixtures/plain-dom.js";
import type { Pace } from "../dashboard-v4-contract.js";
const now = Date.UTC(2030, 3, 15);
function setup(change: Partial<Pace> = {}) {
  const doc = new PlainDocument(); const root = renderPace(doc.asDocument(), { ...overviewFixture().pace, ...change }, now);
  doc.body.append(root as never);
  const nodes = descendants(root as never), trigger = elements(root, "button")[0]!;
  const popover = nodes.find(n => n.className === "pace-popover")!;
  return { doc, root, nodes, trigger, popover, byClass: (name: string) => nodes.find(n => n.className === name)! };
}
describe("month pace", () => {
  it("renders a standalone used fill, projected hatch and ring without ticks", () => {
    const s = setup();
    expect(s.root.tagName).toBe("DIV"); expect(elements(s.root, "h2")).toHaveLength(0);
    expect(s.byClass("pace-fill").getAttribute("width")).toBe("400");
    expect(s.byClass("pace-projection").getAttribute("x")).toBe("400");
    expect(Number(s.byClass("pace-projection").getAttribute("width"))).toBeCloseTo(300, 10);
    expect(s.byClass("pace-here").getAttribute("cx")).toBe("400");
    expect(s.nodes.filter(n => /tick|limit/.test(n.className))).toHaveLength(0);
    expect(s.byClass("pace-month-label").textContent).toBe("APR"); disposePace(s.root);
  });
  it("clamps overflow instead of rescaling the bar", () => {
    const s = setup({ used: 120, projected: 250, overBudget: true, overAtPace: 150 });
    expect(s.byClass("pace-fill").getAttribute("width")).toBe("1000");
    expect(s.byClass("pace-here").getAttribute("cx")).toBe("989");
    expect(s.byClass("pace-projection").getAttribute("width")).toBe("0");
    expect(s.byClass("pace-used").textContent).toBe("120 · 20 over");
    expect(s.root.getAttribute("data-danger")).toBe("true"); expect(s.popover.textContent).toContain("150 over at this pace"); disposePace(s.root);
  });
  it("keeps the ring inside the start of a scaled bar", () => {
    const s = setup({ used: 0 }); expect(s.byClass("pace-here").getAttribute("cx")).toBe("11"); disposePace(s.root);
  });
  it("groups exact pace details without compacting the in-bar figure", () => {
    const s = setup({ used: 118400, budget: 500000, scale: 500000, evenPace: 250000, projected: 1500000, allowance: 2000000, remaining: 381600, overAtPace: 1000000 });
    expect(s.byClass("pace-used").textContent).toBe("118.4k");
    const rows = elements(s.popover, "tbody")[0]!.children;
    expect(rows.map(row => row.children[1]!.children[1]!.textContent)).toEqual(["118,400", "500,000", "250,000", "1,500,000", "2,000,000", "381,600", "16"]);
    expect(s.popover.textContent).toContain("1,000,000 over at this pace"); disposePace(s.root);
  });
  it("focus and hover open details; Escape closes without moving focus", () => {
    const s = setup(); s.trigger.focus(); s.trigger.dispatchEvent(new Event("focus"));
    expect(s.popover.hidden).toBe(false); expect(s.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(s.popover.textContent).toContain("APR 2030");
    for (const label of ["Used", "Budget", "Even pace", "Projected month end", "Allowance", "Remaining", "Days left"]) expect(s.popover.textContent).toContain(label);
    s.trigger.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
    expect(s.popover.hidden).toBe(true); expect(s.doc.activeElement).toBe(s.trigger);
    s.trigger.dispatchEvent(new Event("pointerenter")); expect(s.popover.hidden).toBe(false); disposePace(s.root);
  });
  it("omits budget and even pace when unset and discloses account-wide use", () => {
    const s = setup({ budget: null, evenPace: null, scale: 120 });
    expect(elements(s.popover, "table")[0]!.textContent).not.toContain("Budget"); expect(s.popover.textContent).not.toContain("Even pace");
    expect(s.popover.textContent).toContain("/spider config set usage.monthlyBudget <credits> --global");
    expect(s.popover.textContent).toContain("including use outside pi"); disposePace(s.root);
  });
  it("without a denominator shows used, projection and days without proportional fill", () => {
    const s = setup({ scale: null, budget: null, allowance: null, used: 80, counterAvailable: false, usedSource: "pi" });
    expect(s.byClass("pace-fill").getAttribute("width")).toBe("0"); expect(s.byClass("pace-used").textContent).toBe("80");
    expect(s.nodes.filter(n => ["pace-here", "pace-projection"].includes(n.className))).toHaveLength(0);
    expect(s.popover.textContent).toContain("Counter unavailable"); expect(s.popover.textContent).not.toContain("Remaining"); disposePace(s.root);
  });
  it("labels mid-month reset by the day before its UTC end", () => {
    const s = setup({ period: { start: Date.UTC(2026, 9, 15), end: Date.UTC(2026, 10, 15) } });
    expect(s.byClass("pace-month-label").textContent).toBe("to 14 NOV"); disposePace(s.root);
  });
  it("keeps unavailable used honest rather than showing zero", () => {
    const s = setup({ used: null, projected: null, scale: null, counterAvailable: false });
    expect(s.byClass("pace-used").textContent).toBe("unavailable"); expect(s.popover.textContent).toContain("unavailable"); disposePace(s.root);
  });
});
