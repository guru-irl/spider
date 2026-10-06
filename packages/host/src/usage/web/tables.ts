import { element } from "./dom.js";
const captionSequences = new WeakMap<Document, number>();
export function renderTable(document: Document, options: { caption: string; columns: readonly string[]; rows: readonly (readonly (string | HTMLElement)[])[] }): HTMLTableElement {
  const table = element(document, "table", undefined, "data-table");
  const caption = element(document, "caption", options.caption);
  const sequence = (captionSequences.get(document) ?? 0) + 1; captionSequences.set(document, sequence);
  caption.id = `usage-table-${sequence}`; table.append(caption);
  const head = element(document, "thead"), header = element(document, "tr");
  for (const name of options.columns) { const cell = element(document, "th", name); cell.setAttribute("scope", "col"); header.append(cell); }
  head.append(header); table.append(head);
  const body = element(document, "tbody");
  for (const row of options.rows) {
    const line = element(document, "tr");
    for (const value of row) {
      const cell = element(document, "td");
      if (typeof value === "string") cell.textContent = value; else cell.append(value);
      line.append(cell);
    }
    body.append(line);
  }
  if (!options.rows.length) {
    const line = element(document, "tr"), cell = element(document, "td", "No rows for this period");
    cell.setAttribute("colspan", String(options.columns.length)); line.append(cell); body.append(line);
  }
  table.append(body); return table;
}
export function tableRegion(document: Document, table: HTMLTableElement): HTMLElement {
  const region = element(document, "div", undefined, "table-region");
  region.setAttribute("tabindex", "0"); region.setAttribute("role", "region");
  const caption = table.firstElementChild!;
  region.id = `${caption.id}-region`; region.setAttribute("aria-labelledby", caption.id); region.append(table); return region;
}
