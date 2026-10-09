import "./range-picker.css";
import type { SessionRange } from "../dashboard-v4-contract.js";
import { action, element } from "./dom.js";

const DAY = 86400000;
const formatters = new Map<string, Intl.DateTimeFormat>();
function dayKey(ts: number, tz: string): string {
  let format = formatters.get(tz);
  if (!format) { format = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); formatters.set(tz, format); }
  const parts = format.formatToParts(ts), part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}
const ordinal = (date: string) => Date.parse(`${date}T00:00:00Z`);
const keyAt = (date: number) => new Date(date).toISOString().slice(0, 10);
/** Find a local day's earliest instant, including 23/25-hour days and midnight offset changes. */
export function localDayStart(date: string, tz: string, offset = 0): number {
  const target = ordinal(date) + offset * DAY, key = keyAt(target);
  let low = Math.max(0, target - 36 * 3600000), high = Math.min(8640000000000000, target + 36 * 3600000);
  while (low < high) { const mid = low + Math.floor((high - low) / 2); if (dayKey(mid, tz) < key) low = mid + 1; else high = mid; }
  return low;
}
export type RangePicker = { element: HTMLElement; dispose(): void };
export type RangePickerOptions = {
  range: SessionRange; month: SessionRange; span: { first: number; last: number }; tz: string; now(): number;
  change(range: SessionRange): void;
};
export function renderRangePicker(document: Document, options: RangePickerOptions): RangePicker {
  const { range, span, tz } = options;
  const root = element(document, "div", undefined, "range-picker"); root.setAttribute("role", "group"); root.setAttribute("aria-label", "Session date range");
  const first = ordinal(dayKey(span.first, tz)), last = ordinal(dayKey(span.last, tz));
  const today = dayKey(options.now(), tz), clamp = (date: number) => Math.max(first, Math.min(last, date));
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short", year: "numeric" });
  let field: "From" | "To" = "From", focusDay = first, month = first, open = false, disposed = false;
  let trigger: HTMLButtonElement | undefined;
  const popup = element(document, "div", undefined, "range-calendar"); popup.setAttribute("role", "dialog"); popup.hidden = true;
  const days = new Map<number, HTMLButtonElement>();
  const close = (returnFocus: boolean) => { if (!open) return; open = false; popup.hidden = true; trigger?.setAttribute("aria-expanded", "false"); if (returnFocus) trigger?.focus(); };
  const choose = (date: number) => {
    const from = localDayStart(keyAt(date), tz), to = localDayStart(keyAt(date), tz, 1);
    const next = field === "From" ? { from, to: Math.max(to, range.to) } : { from: Math.min(from, range.from), to };
    close(true); options.change(next);
  };
  const setMonth = (date: number) => { const d = new Date(date); month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
  const move = (date: number) => { focusDay = clamp(date); setMonth(focusDay); draw(); days.get(focusDay)?.focus(); };
  const monthShift = (by: number) => { const d = new Date(month); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + by, 1); };
  const monthButton = (label: string, direction: -1 | 1) => {
    const b = action(document, "", () => { month = monthShift(direction); const d = new Date(month); focusDay = clamp(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(new Date(focusDay).getUTCDate(), new Date(monthShift(1) - DAY).getUTCDate()))); draw(); const next = popup.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); if (next && !next.disabled) next.focus(); else days.get(focusDay)?.focus(); });
    b.setAttribute("aria-label", label); b.className = "calendar-month-button";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); path.setAttribute("d", direction < 0 ? "m14 6-6 6 6 6" : "m10 6 6 6-6 6"); svg.append(path); b.append(svg);
    b.disabled = direction < 0 ? month <= Date.UTC(new Date(first).getUTCFullYear(), new Date(first).getUTCMonth(), 1) : monthShift(1) > last;
    return b;
  };
  function draw(): void {
    days.clear(); popup.replaceChildren(); popup.setAttribute("aria-label", `Choose ${field} date`);
    const header = element(document, "div", undefined, "calendar-head"), title = element(document, "h3", new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" }).format(month), "mono"); title.setAttribute("aria-live", "polite");
    header.append(monthButton("Previous month", -1), title, monthButton("Next month", 1)); popup.append(header);
    const grid = element(document, "table", undefined, "calendar-grid"); grid.setAttribute("role", "grid"); grid.setAttribute("aria-label", `Choose ${field} date`);
    const head = element(document, "thead"), weekday = element(document, "tr");
    for (const name of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) { const cell = element(document, "th", name); cell.setAttribute("scope", "col"); weekday.append(cell); } head.append(weekday); grid.append(head);
    const body = element(document, "tbody"), start = month - ((new Date(month).getUTCDay() + 6) % 7) * DAY;
    const selected = ordinal(dayKey(field === "From" ? range.from : range.to - 1, tz));
    for (let row = 0; row < 6; row++) {
      const line = element(document, "tr");
      for (let column = 0; column < 7; column++) {
        const date = start + (row * 7 + column) * DAY, key = keyAt(date), cell = element(document, "td"), b = action(document, String(new Date(date).getUTCDate()), () => choose(date));
        const enabled = date >= first && date <= last;
        b.disabled = !enabled; b.setAttribute("tabindex", enabled && date === focusDay ? "0" : "-1"); b.setAttribute("data-date", key);
        b.setAttribute("aria-label", new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date));
        cell.setAttribute("aria-selected", String(date === selected)); b.className = `${date < month || date >= monthShift(1) ? "outside-month " : ""}${date === selected ? "selected-day" : ""}`.trim();
        if (key === today) b.setAttribute("aria-current", "date");
        b.addEventListener("focus", () => { focusDay = date; for (const [value, day] of days) day.setAttribute("tabindex", value === date ? "0" : "-1"); });
        b.addEventListener("keydown", event => {
          let next: number | undefined;
          switch (event.key) {
            case "ArrowLeft": next = date - DAY; break; case "ArrowRight": next = date + DAY; break;
            case "ArrowUp": next = date - 7 * DAY; break; case "ArrowDown": next = date + 7 * DAY; break;
            case "Home": next = date - column * DAY; break; case "End": next = date + (6 - column) * DAY; break;
            case "PageUp": case "PageDown": { const d = new Date(date), by = event.key === "PageUp" ? -1 : 1; const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + by, 1); next = target + (Math.min(d.getUTCDate(), new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + by + 1, 0)).getUTCDate()) - 1) * DAY; break; }
            case "Enter": case " ": event.preventDefault(); choose(date); return;
            case "Escape": event.preventDefault(); close(true); return;
          }
          if (next !== undefined) { event.preventDefault(); move(next); }
        });
        cell.append(b); line.append(cell); days.set(date, b);
      }
      body.append(line);
    }
    grid.append(body); popup.append(grid, element(document, "p", tz, "calendar-zone mono"));
  }
  for (const label of ["From", "To"] as const) {
    const b = action(document, `${label} ${format.format(label === "From" ? range.from : range.to - 1)}`, () => {
      if (open && trigger === b) { close(true); return; }
      close(false); field = label; trigger = b; focusDay = clamp(ordinal(dayKey(label === "From" ? range.from : range.to - 1, tz))); setMonth(focusDay);
      open = true; b.setAttribute("aria-expanded", "true"); popup.setAttribute("data-field", label.toLowerCase()); popup.hidden = false; draw(); days.get(focusDay)?.focus();
    });
    b.className = "range-date mono"; b.setAttribute("aria-haspopup", "dialog"); b.setAttribute("aria-expanded", "false"); b.setAttribute("data-range-field", label.toLowerCase()); root.append(b);
  }
  const monthPreset = action(document, "This month", () => { close(false); options.change(options.month); }), whole = action(document, "Whole session", () => { close(false); options.change({ from: span.first, to: span.last + 1 }); });
  monthPreset.className = whole.className = "range-preset";
  monthPreset.setAttribute("aria-pressed", String(range.from === options.month.from && range.to === options.month.to));
  whole.setAttribute("aria-pressed", String(range.from === span.first && range.to === span.last + 1));
  root.append(monthPreset, whole, popup);
  const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && open) { event.preventDefault(); close(true); } };
  const outside = (event: Event) => { if (open && !root.contains(event.target as Node)) close(false); };
  const focusout = (event: FocusEvent) => { if (!disposed && open && event.relatedTarget && !root.contains(event.relatedTarget as Node)) close(false); };
  root.addEventListener("keydown", escape); root.addEventListener("focusout", focusout); document.addEventListener("pointerdown", outside);
  return { element: root, dispose() { disposed = true; close(false); root.removeEventListener("keydown", escape); root.removeEventListener("focusout", focusout); document.removeEventListener("pointerdown", outside); } };
}
