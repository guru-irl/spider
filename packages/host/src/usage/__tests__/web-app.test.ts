import { describe, expect, it } from "vitest";
import { PlainDocument, elements } from "./fixtures/plain-dom.js";
import { renderTable } from "../web/tables.js";

describe("shared presentation", () => {
  it("shared tables carry column labels without changing observations", () => {
    // Break caught: unlabeled values when the shared responsive table stacks.
    const table = renderTable(new PlainDocument().asDocument(), { caption: "Usage", columns: ["Observation", "Count"], rows: [["Day 2", "10"]] });
    expect(elements(table, "td").map(cell => cell.getAttribute("data-label"))).toEqual(["Observation", "Count"]);
    expect(elements(table, "td").map(cell => cell.children[1]!.textContent)).toEqual(["Day 2", "10"]);
    expect(elements(table, "td")[0]!.className).not.toContain("numeric");
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
});
