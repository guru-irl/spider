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
const calendar = (s: ReturnType<typeof setup>) => descendants(s.doc.body).find(n => n.getAttribute("role") === "dialog");
it("closed calendars are absent and each opening creates a fresh focused popover", () => {
  const s = setup(), from = elements(s.doc.body, "button").find(n => n.getAttribute("data-range-field") === "from")!;
  expect(calendar(s)).toBeUndefined(); from.click();
  const first = calendar(s)!; expect(first).toBeDefined(); expect(first.hidden).toBe(false);
  expect(s.doc.activeElement?.getAttribute("data-date")).toBe("2030-05-01");
  from.click(); expect(calendar(s)).toBeUndefined(); expect(from.getAttribute("aria-expanded")).toBe("false");
  from.click(); expect(calendar(s)).toBeDefined(); expect(calendar(s)).not.toBe(first);
  s.picker.dispose(); expect(calendar(s)).toBeUndefined();
});
it.each(["Escape", "selection", "preset", "outside", "focusout"])("%s removes the calendar and resets the trigger", reason => {
  const s = setup(), from = elements(s.doc.body, "button").find(n => n.getAttribute("data-range-field") === "from")!;
  from.click();
  if (reason === "Escape") key(s.doc.activeElement!, "Escape");
  if (reason === "selection") s.doc.activeElement!.click();
  if (reason === "preset") button(s.doc.body, "This month").click();
  if (reason === "outside") { const event = new Event("pointerdown"); Object.defineProperty(event, "target", { value: s.doc.body }); s.doc.dispatchEvent(event); }
  if (reason === "focusout") { const event = new Event("focusout"); Object.assign(event, { relatedTarget: s.doc.body }); (s.picker.element as never as import("./fixtures/plain-dom.js").PlainElement).dispatchEvent(event); }
  expect(calendar(s)).toBeUndefined(); expect(from.getAttribute("aria-expanded")).toBe("false");
  if (reason === "Escape" || reason === "selection") expect(s.doc.activeElement).toBe(from);
  s.picker.dispose();
});
it("pills show dates without a zone, and the labelled calendar shows the zone once", () => {
  const s = setup(); expect(s.doc.body.textContent).not.toContain("UTC");
  button(s.doc.body, "From Wed 1 MAY").click();
  const popup = descendants(s.doc.body).find(n => n.getAttribute("role") === "dialog")!;
  expect(popup.getAttribute("aria-label")).toBe("Choose From date");
  expect(popup.textContent.match(/UTC/g)).toHaveLength(1);
  expect(descendants(popup).filter(n => n.getAttribute("aria-current") === "date").map(n => n.getAttribute("data-date"))).toEqual(["2030-05-06"]);
  s.picker.dispose();
});
it("month navigation disables days outside the span and selection uses local-day start", () => {
  const s = setup(); button(s.doc.body, "From Wed 1 MAY").click();
  const previous = elements(s.doc.body, "button").find(n => n.getAttribute("aria-label") === "Previous month")!; previous.click();
  const days = descendants(s.doc.body).filter(n => n.hasAttribute("data-date"));
  expect(days.find(n => n.getAttribute("data-date") === "2030-04-02")!.disabled).toBe(true);
  const first = days.find(n => n.getAttribute("data-date") === "2030-04-03")!; expect(first.disabled).toBe(false); first.click();
  expect(s.change).toHaveBeenLastCalledWith({ from: APR + 2 * 86400000, to: JUN });
  expect(s.doc.activeElement?.textContent).toBe("From Wed 1 MAY");
  expect(descendants(s.doc.body).some(n => n.getAttribute("role") === "dialog" && !n.hidden)).toBe(false); s.picker.dispose();
});
it("arrows cross months, Enter picks the end of a To day, Escape returns focus", () => {
  const s = setup(), to = button(s.doc.body, "To Fri 31 MAY"); to.click();
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
  const s = setup(); button(s.doc.body, "From Wed 1 MAY").click();
  elements(s.doc.body, "button").find(n => n.getAttribute("aria-label") === "Next month")!.click();
  descendants(s.doc.body).find(n => n.getAttribute("data-date") === "2030-06-03")!.click();
  expect(s.change).toHaveBeenLastCalledWith({ from: JUN + 2 * 86400000, to: JUN + 3 * 86400000 }); s.picker.dispose();
});

it.each([
  ["UTC", "2030-01-01T00:30:00Z", "2030-01-01T00:00:00Z", "From Tue 1 JAN", "Tue 1 JAN", "JAN"],
  ["UTC", "2030-09-01T00:30:00Z", "2030-09-01T00:00:00Z", "From Sun 1 SEP", "Sun 1 SEP", "SEP"],
  ["UTC", "2030-01-01T00:30:00Z", "2029-12-31T00:00:00Z", "From Mon 31 DEC 2029", "Mon 31 DEC 2029", "DEC 2029"],
  ["America/Los_Angeles", "2030-01-01T00:30:00Z", "2030-01-01T00:00:00Z", "From Mon 31 DEC", "Mon 31 DEC", "DEC"],
  ["Asia/Kolkata", "2029-12-31T20:00:00Z", "2029-12-31T20:00:00Z", "From Tue 1 JAN", "Tue 1 JAN", "JAN"],
])("date pills and calendar labels use dashboard dates and the current local year in %s", (tz, now, from, label, dayLabel, monthLabel) => {
  const doc = new PlainDocument(), start = Date.parse(from), range = { from: start, to: start + 86400000 };
  const picker = renderRangePicker(doc.asDocument(), { range, month: range, span: { first: start, last: start + 86400000 }, tz, now: () => Date.parse(now), change: () => {} });
  doc.body.append(picker.element as never);
  const trigger = button(doc.body, label); expect(trigger.className).toContain("mono"); trigger.click();
  const popup = descendants(doc.body).find(n => n.getAttribute("role") === "dialog")!;
  expect(elements(popup, "h3")[0]!.textContent).toBe(monthLabel);
  expect(descendants(popup).find(n => n.getAttribute("aria-selected") === "true")!.children[0]!.getAttribute("aria-label")).toBe(dayLabel);
  picker.dispose();
});
