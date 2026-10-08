import { observeFontTransport } from "./fixtures/font-transport.js";
import { afterEach, expect, it, vi } from "vitest";
import { PlainDocument, elements, settle } from "./fixtures/plain-dom.js";
import { DashboardClientError, errorCopy } from "../web/client.js";
import { formatAicDisplay, periodTimes, evidenceText } from "../web/format.js";
import { chartWithTable } from "../web/charts.js";
import { renderTable } from "../web/tables.js";
import { loadFonts } from "../web/fonts.js";

afterEach(() => vi.unstubAllGlobals());
it("gap chart signs include positive, negative and rounded zero consistently", () => {
  const doc = new PlainDocument();
  const chart = chartWithTable(doc.asDocument(), { title: "Gap", unit: "gap-aic", points: [-2, 16, -0.1].map(value => ({ start: 0, end: 1000, label: "Synthetic", value, tokens: null })) });
  expect(chart.textContent).toContain("-2 AIC"); expect(chart.textContent).toContain("+16 AIC"); expect(chart.textContent).not.toContain("-0 AIC");
});
it("chart tooltips preserve free-text evidence and format the known period", () => {
  const doc = new PlainDocument();
  const chart = chartWithTable(doc.asDocument(), { title: "Factor", unit: "ratio", points: [{ start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 0, 3), label: "2026-01-01", labelDate: "day", value: 1.2, tokens: null,
    note: "Window 2026-01-01T00:00:00.000Z to 2026-01-03T00:00:00.000Z UTC" }] });
  const tooltip = elements(chart, "title")[1]!.textContent;
  expect(tooltip).toBe("1 Jan 2026 · 1 Jan 2026 to 2 Jan 2026 · ~1.2 ratio · tokens unavailable · Window 2026-01-01T00:00:00.000Z to 2026-01-03T00:00:00.000Z UTC");
  expect(tooltip).toContain("1 Jan 2026 to 2 Jan 2026"); expect(tooltip).toContain("Window 2026-01-01T00:00:00.000Z to 2026-01-03T00:00:00.000Z UTC"); expect(tooltip).not.toContain("UTC UTC");
  expect(elements(chart, "time").every(t => t.getAttribute("datetime")?.endsWith("Z"))).toBe(true);
});
it("midnight-aligned period endpoints use symmetric dates", () => {
  const doc = new PlainDocument();
  const period = periodTimes(doc.asDocument(), Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 3), true);
  expect(period.textContent).toBe("1 Jan 2026 to 2 Jan 2026");
  expect(elements(period, "time").map(t => t.getAttribute("datetime"))).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
});
it("identity recovery names the salt sidecar and failure-cache window", () => {
  const copy = errorCopy(new DashboardClientError("identity-unavailable"));
  expect(copy).toContain("the ledger's explorer-salt file"); expect(copy).toContain("five seconds"); expect(copy).not.toContain("Run /usage again");
});
it("optional font request includes every declared local weight", async () => {
  const doc = new PlainDocument(), faces = observeFontTransport(doc); await loadFonts(doc.asDocument(), undefined, () => 1);
  expect(faces.map(face => `${face.family}:${face.weight}`)).toEqual(["Fira Sans:400", "Fira Sans:500", "Fira Sans:600", "Fira Sans:700", "Cascadia Code:400", "Cascadia Code:700", "Bebas Neue:400"]);
  expect(elements(doc.head, "link")).toHaveLength(0);
});
it("period-independent empty tables do not imply a selected time window", () => {
  const doc = new PlainDocument();
  const table = renderTable(doc.asDocument(), { caption: "Loaded rate versions", columns: ["Version"], rows: [] });
  expect(table.textContent).toContain("No rows recorded"); expect(table.textContent).not.toContain("for this period");
});
it("free text is never interpreted as a date", () => {
  const doc = new PlainDocument(), text = "Project 2026-10 and session 2026-10-04; model gpt-4o-2024-08-06";
  const node = evidenceText(doc.asDocument(), text);
  expect(node.textContent).toBe(text); expect(elements(node, "time")).toHaveLength(0);
});
it.each([1, 31])("%i-day half-open period displays inclusive dates with exact bounds", days => {
  const doc = new PlainDocument(), start = Date.UTC(2026, 9, 1), end = start + days * 86400000;
  const period = periodTimes(doc.asDocument(), start, end, true);
  expect(period.getAttribute("data-start")).toBe(new Date(start).toISOString());
  expect(period.getAttribute("data-end")).toBe(new Date(end).toISOString());
  expect(period.textContent).toBe(days === 1 ? "1 Oct 2026" : "1 Oct 2026 to 31 Oct 2026");
  expect(elements(period, "time").map(t => t.getAttribute("datetime"))).toEqual(days === 1 ? ["2026-10-01T00:00:00.000Z"] : ["2026-10-01T00:00:00.000Z", "2026-10-31T00:00:00.000Z"]);
  const chart = chartWithTable(doc.asDocument(), { title: "Daily", unit: "tokens", points: [{ start, end, label: "Bucket", labelDate: "day", value: 1, tokens: null }] });
  expect(elements(chart, "p").find(p => p.className === "chart-summary")!.textContent).toBe(`${period.textContent} · 1 token minimum · 1 token maximum`);
});
