import { describe, expect, it, vi } from "vitest";
import { PlainDocument, elements, settle, button, cellText } from "./fixtures/plain-dom.js";
import { startDashboard } from "../web/app.js";
import { chartWithTable } from "../web/charts.js";
import { renderTable } from "../web/tables.js";
import { tokenList, periodTimes, formatUtcTimestamp, evidenceText } from "../web/format.js";
import * as dom from "../web/dom.js";

const period = { start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 9, 6, 22, 13) };
const tokens = { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, prompt: 60, total: 100, reasoning: null, cacheWrite1h: 0 };

function browserWindow(doc: PlainDocument, hash = "") {
  const win = new EventTarget();
  const location = { hash };
  const entries = [hash]; let index = 0;
  const history = {
    pushState(_state: unknown, _title: string, url: string) { location.hash = url; entries.splice(++index); entries.push(url); },
    replaceState(_state: unknown, _title: string, url: string) { location.hash = url; entries[index] = url; },
    back() { if (index > 0) { location.hash = entries[--index]!; win.dispatchEvent(new Event("popstate")); win.dispatchEvent(new Event("hashchange")); } },
    forward() { if (index < entries.length - 1) { location.hash = entries[++index]!; win.dispatchEvent(new Event("popstate")); win.dispatchEvent(new Event("hashchange")); } },
  };
  Object.assign(win, { location, history }); Object.defineProperty(doc, "defaultView", { value: win });
  return { win, location, history };
}

describe("Task 13 shared presentation", () => {
  it("invalid timestamp-looking labels remain text without exceptions", () => {
    const text = "Synthetic-2026-99-99T99:99:99.000Z";
    const node = evidenceText(new PlainDocument().asDocument(), text);
    expect(node.textContent).toBe(text); expect(elements(node, "time")).toHaveLength(0);
  });
  it("chart free-text evidence preserves timestamp-looking text", () => {
    const chart = chartWithTable(new PlainDocument().asDocument(), { title: "Daily", unit: "tokens", points: [{ ...period, label: "Day", value: 100, tokens, note: "Window 2026-10-01T00:00:00.000Z to 2026-10-06T22:13:00.000Z UTC" }] });
    const evidence = elements(chart, "td")[4]!;
    expect(evidence.textContent).toContain("Window 2026-10-01T00:00:00.000Z to 2026-10-06T22:13:00.000Z UTC");
    expect(elements(evidence, "time")).toHaveLength(0);
  });
  it("shared tables carry column labels without changing observations", () => {
    // Break caught: unlabeled values when the shared responsive table stacks.
    const table = renderTable(new PlainDocument().asDocument(), { caption: "Usage", columns: ["Observation", "Count"], rows: [["Day 2", "10"]] });
    expect(elements(table, "td").map(cell => cell.getAttribute("data-label"))).toEqual(["Observation", "Count"]);
    expect(elements(table, "td").map(cell => cell.children[1]!.textContent)).toEqual(["Day 2", "10"]);
    expect(elements(table, "td")[0]!.className).not.toContain("numeric");
  });
  it.each([1, 2, 3])("%s points use compact geometry only below three points", count => {
    // Break caught: treating sparse evidence as a full-height plot.
    const chart = chartWithTable(new PlainDocument().asDocument(), { title: "Daily", unit: "tokens", points: Array.from({ length: count }, (_, i) => ({ start: i * 1000, end: (i + 1) * 1000, label: `Day ${i + 1}`, value: 100, tokens })) });
    expect(elements(chart, "svg")[0]!.getAttribute("height")).toBe(count < 3 ? "96" : "160");
    expect(elements(chart, "circle")).toHaveLength(count);
    if (count === 1) expect(elements(chart, "p")[0]!.textContent).toBe("1 Jan 1970, 00:00 UTC to 1 Jan 1970, 00:00:01 UTC · 100 tokens minimum · 100 tokens maximum");
  });
  it("chart tables keep token labels in a compact list and UTC periods in time elements", () => {
    // Break caught: collapsing the token categories into a dense prose cell.
    const chart = chartWithTable(new PlainDocument().asDocument(), { title: "Daily", unit: "tokens", points: [{ ...period, label: "Day 2", value: 100, tokens }] });
    const cells = elements(chart, "td");
    expect(elements(cells[3]!, "dt").map(node => node.textContent.trim())).toEqual(["input", "cache read", "cache write", "output", "prompt", "total", "cache write 1h", "reasoning"]);
    expect(elements(cells[3]!, "dd").map(node => node.textContent.replace(/; $/, ""))).toEqual(["10", "20", "30", "40", "60", "100", "0", "unavailable"]);
    expect(cellText(cells[3]!)).toBe("input 10; cache read 20; cache write 30; output 40; prompt 60; total 100; cache write 1h 0; reasoning unavailable");
    expect(elements(cells[1]!, "time").map(node => node.getAttribute("datetime"))).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-06T22:13:00.000Z"]);
    expect(elements(cells[2]!, "span").filter(node => node.className === "numeric").map(node => node.textContent)).toEqual(["100"]);
    expect(elements(cells[0]!, "span").filter(node => node.className === "numeric")).toHaveLength(0);
  });
});

describe("semantic presentation regressions", () => {
  it("tables expose explicit column associations and silent real stacked labels", () => {
    const table = renderTable(new PlainDocument().asDocument(), { caption: "Usage", columns: ["Name", "Count"], rows: [["Alpha", "42"]] });
    expect(table.getAttribute("role")).toBe("table");
    expect(elements(table, "thead")[0]!.getAttribute("role")).toBe("rowgroup");
    expect(elements(table, "tbody")[0]!.getAttribute("role")).toBe("rowgroup");
    for (const row of elements(table, "tr")) expect(row.getAttribute("role")).toBe("row");
    elements(table, "th").forEach((head, i) => {
      expect(head.getAttribute("role")).toBe("columnheader"); expect(head.id).not.toBe("");
      const cell = elements(table, "td")[i]!;
      expect(cell.getAttribute("role")).toBe("cell"); expect(cell.getAttribute("headers")).toBe(head.id);
      const label = cell.children[0]!; expect(label.className).toBe("cell-label"); expect(label.getAttribute("aria-hidden")).toBe("true"); expect(label.textContent).toBe(head.textContent);
    });
  });
  it("ten columns opt into wide-table scrolling", () => {
    const doc = new PlainDocument().asDocument();
    expect(renderTable(doc, { caption: "Tiers", columns: Array(10).fill("Rate"), rows: [] }).className).toContain("wide-table");
    expect(renderTable(doc, { caption: "Usage", columns: Array(6).fill("Value"), rows: [] }).className).not.toContain("wide-table");
  });
  it("token separators are explicitly excluded from assistive text", () => {
    const list = tokenList(new PlainDocument().asDocument(), tokens);
    const separators = elements(list, "span").filter(node => node.className === "token-separator");
    expect(separators).toHaveLength(7); for (const separator of separators) expect(separator.getAttribute("aria-hidden")).toBe("true");
  });
  it("a sub-second period displays distinct millisecond endpoints", () => {
    const span = periodTimes(new PlainDocument().asDocument(), period.end + 100, period.end + 200);
    expect(elements(span, "time").map(node => node.textContent)).toEqual(["6 Oct 2026, 22:13:00.100 UTC", "6 Oct 2026, 22:13:00.200 UTC"]);
    expect(elements(span, "time").map(node => node.getAttribute("datetime"))).toEqual(["2026-10-06T22:13:00.100Z", "2026-10-06T22:13:00.200Z"]);
  });
  it("in-place evidence updates retain chart controls, selected representation, focus and scroll regions while values change", () => {
    const doc = new PlainDocument(), root = doc.createElement("div"); doc.body.append(root);
    const chart = (value: number) => chartWithTable(doc.asDocument(), { title: "Daily", unit: "tokens", points: [{ ...period, label: "Day", value, tokens }] });
    const initial = chart(10); (root as unknown as HTMLElement).append(initial); const toggle = button(root, "Table"); toggle.click(); toggle.focus();
    const region = elements(root, "table")[0]!.parentElement!;
    dom.updateEvidence(root as unknown as HTMLElement, chart(20));
    expect(button(root, "Table")).toBe(toggle); expect(doc.activeElement).toBe(toggle); expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(elements(root, "table")[0]!.parentElement).toBe(region); expect(region.hidden).toBe(false);
    expect(root.textContent).toContain("20 tokens");
    button(root, "Chart").click(); expect(region.hidden).toBe(true); toggle.click(); expect(region.hidden).toBe(false);
  });
});

it("timestamp formatting reuses cached Intl formatters for large pages", () => {
  const constructor = vi.spyOn(Intl, "DateTimeFormat");
  try {
    for (let i = 0; i < 200; i++) { formatUtcTimestamp(period.end); formatUtcTimestamp(period.end + 1000); formatUtcTimestamp(period.end + 100, false, true); }
    expect(constructor).not.toHaveBeenCalled();
  } finally { constructor.mockRestore(); }
});
