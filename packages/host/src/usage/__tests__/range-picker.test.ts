import { expect, it, vi } from "vitest";
import { renderRangePicker, localDayStart } from "../web/range-picker.js";
import { PlainDocument, descendants, button, elements } from "./fixtures/plain-dom.js";
const APR = Date.UTC(2030, 3, 1), MAY = Date.UTC(2030, 4, 1), JUN = Date.UTC(2030, 5, 1);
function setup() {
  const doc = new PlainDocument(), change = vi.fn();
  const picker = renderRangePicker(doc.asDocument(), { range: { from: MAY, to: JUN }, month: { from: MAY, to: JUN }, span: { first: APR + 2 * 86400000, last: JUN + 4 * 86400000 }, tz: "UTC", now: () => MAY + 5 * 86400000, change });
  doc.body.append(picker.element as never); return { doc, picker, change };
}
function key(node: ReturnType<typeof button>, value: string) { const event = new Event("keydown"); Object.assign(event, { key: value }); node.dispatchEvent(event); }
it.each([
  ["2030-03-10", "America/New_York", "2030-03-10T05:00:00.000Z", "2030-03-11T04:00:00.000Z"],
  ["2030-11-03", "America/New_York", "2030-11-03T04:00:00.000Z", "2030-11-04T05:00:00.000Z"],
  ["2030-04-03", "Asia/Kathmandu", "2030-04-02T18:15:00.000Z", "2030-04-03T18:15:00.000Z"],
])("local day start/end uses %s in %s rather than a fixed 24 hours", (day, tz, start, end) => {
  expect(new Date(localDayStart(day, tz)).toISOString()).toBe(start);
  expect(new Date(localDayStart(day, tz, 1)).toISOString()).toBe(end);
});
it("pills show dates without a zone, and the labelled calendar shows the zone once", () => {
  const s = setup(); expect(s.doc.body.textContent).not.toContain("UTC");
  button(s.doc.body, "From 1 May 2030").click();
  const popup = descendants(s.doc.body).find(n => n.getAttribute("role") === "dialog")!;
  expect(popup.getAttribute("aria-label")).toBe("Choose From date");
  expect(popup.textContent.match(/UTC/g)).toHaveLength(1);
  expect(descendants(popup).filter(n => n.getAttribute("aria-current") === "date").map(n => n.getAttribute("data-date"))).toEqual(["2030-05-06"]);
  s.picker.dispose();
});
it("month navigation disables days outside the span and selection uses local-day start", () => {
  const s = setup(); button(s.doc.body, "From 1 May 2030").click();
  const previous = elements(s.doc.body, "button").find(n => n.getAttribute("aria-label") === "Previous month")!; previous.click();
  const days = descendants(s.doc.body).filter(n => n.hasAttribute("data-date"));
  expect(days.find(n => n.getAttribute("data-date") === "2030-04-02")!.disabled).toBe(true);
  const first = days.find(n => n.getAttribute("data-date") === "2030-04-03")!; expect(first.disabled).toBe(false); first.click();
  expect(s.change).toHaveBeenLastCalledWith({ from: APR + 2 * 86400000, to: JUN });
  expect(s.doc.activeElement?.textContent).toBe("From 1 May 2030");
  expect(descendants(s.doc.body).some(n => n.getAttribute("role") === "dialog" && !n.hidden)).toBe(false); s.picker.dispose();
});
it("arrows cross months, Enter picks the end of a To day, Escape returns focus", () => {
  const s = setup(), to = button(s.doc.body, "To 31 May 2030"); to.click();
  expect(s.doc.activeElement?.getAttribute("data-date")).toBe("2030-05-31");
  key(s.doc.activeElement!, "ArrowRight"); expect(s.doc.activeElement?.getAttribute("data-date")).toBe("2030-06-01");
  key(s.doc.activeElement!, "Enter"); expect(s.change).toHaveBeenLastCalledWith({ from: MAY, to: JUN + 86400000 });
  to.click(); key(s.doc.activeElement!, "ArrowLeft"); key(s.doc.activeElement!, "Escape");
  expect(s.doc.activeElement).toBe(to); expect(to.getAttribute("aria-expanded")).toBe("false"); s.picker.dispose();
});
it("presets choose the exact billing month or the whole-session inclusive span", () => {
  const s = setup(); button(s.doc.body, "This month").click(); expect(s.change).toHaveBeenLastCalledWith({ from: MAY, to: JUN });
  button(s.doc.body, "Whole session").click(); expect(s.change).toHaveBeenLastCalledWith({ from: APR + 2 * 86400000, to: JUN + 4 * 86400000 + 1 }); s.picker.dispose();
});
it("crossing the other endpoint retains a valid one-day range", () => {
  const s = setup(); button(s.doc.body, "From 1 May 2030").click();
  elements(s.doc.body, "button").find(n => n.getAttribute("aria-label") === "Next month")!.click();
  descendants(s.doc.body).find(n => n.getAttribute("data-date") === "2030-06-03")!.click();
  expect(s.change).toHaveBeenLastCalledWith({ from: JUN + 2 * 86400000, to: JUN + 3 * 86400000 }); s.picker.dispose();
});
