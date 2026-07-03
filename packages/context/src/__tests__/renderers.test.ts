import { describe, it, expect } from "vitest";
import { renderSearchResult, renderImportResult } from "../renderers";
import type { SearchResultRow } from "../search";
import type { ImportSummary } from "../import";

function assertComponent(c: any) {
  expect(typeof c.render).toBe("function");
  const lines = c.render(80);
  expect(Array.isArray(lines)).toBe(true);
  return lines.join("\n");
}

describe("renderSearchResult", () => {
  it("panels the hits with a count and shows title/snippet", () => {
    const rows: SearchResultRow[] = [
      { key: "k1", kind: "memory", id: "1", title: "fact", snippet: "the sky is blue" },
      { key: "k2", kind: "content", id: "2", title: "notes.md", snippet: "grass is green" },
    ];
    const text = assertComponent(renderSearchResult(rows));
    expect(text).toContain("search (2)");
    expect(text).toContain("the sky is blue");
    expect(text).toContain("[memory]");
  });

  it("renders an empty state for no hits", () => {
    const text = assertComponent(renderSearchResult([]));
    expect(text).toContain("search (0)");
    expect(text).toContain("(no results)");
  });
});

describe("renderImportResult", () => {
  it("summarizes imported/skipped/staged/committed counts", () => {
    const summary: ImportSummary = {
      imported: 3,
      skipped: 1,
      staged: 5,
      committed: 2,
      perSession: [],
    };
    const text = assertComponent(renderImportResult(summary));
    expect(text).toContain("import");
    expect(text).toContain("3");
    expect(text).toContain("imported");
    expect(text).toContain("committed");
  });
});
