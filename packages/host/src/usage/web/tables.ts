import { element } from "./dom.js";
const captionSequences = new WeakMap<Document, number>();
export function renderTable(document: Document, options: { caption: string; columns: readonly string[]; rows: readonly (readonly (string | HTMLElement)[])[] }): HTMLTableElement {
  const table = element(document, "table", undefined, options.columns.length > 6 ? "data-table wide-table" : "data-table");
  table.setAttribute("role", "table");
  const caption = element(document, "caption", options.caption);
  const sequence = (captionSequences.get(document) ?? 0) + 1; captionSequences.set(document, sequence);
  caption.id = `usage-table-${sequence}`; table.append(caption);
  const head = element(document, "thead"), header = element(document, "tr");
  head.setAttribute("role", "rowgroup"); header.setAttribute("role", "row");
  options.columns.forEach((name, index) => { const cell = element(document, "th", name); cell.id = `${caption.id}-col-${index}`; cell.setAttribute("role", "columnheader"); cell.setAttribute("scope", "col"); header.append(cell); });
  head.append(header); table.append(head);
  const body = element(document, "tbody"); body.setAttribute("role", "rowgroup");
  for (const row of options.rows) {
    const line = element(document, "tr"); line.setAttribute("role", "row");
    for (const [index, value] of row.entries()) {
      const cell = element(document, "td");
      cell.setAttribute("data-label", options.columns[index] ?? "");
      cell.setAttribute("role", "cell"); cell.setAttribute("headers", `${caption.id}-col-${index}`);
      const label = element(document, "span", options.columns[index] ?? "", "cell-label"); label.setAttribute("aria-hidden", "true");
      const content = element(document, "div", undefined, "cell-value");
      if (typeof value === "string") content.textContent = value; else content.append(value);
      cell.append(label, content);
      line.append(cell);
    }
    body.append(line);
  }
  if (!options.rows.length) {
    const line = element(document, "tr"), cell = element(document, "td", "No rows for this period");
    line.setAttribute("role", "row"); cell.setAttribute("role", "cell");
    cell.setAttribute("colspan", String(options.columns.length)); line.append(cell); body.append(line);
  }
  table.append(body); return table;
}
export function tableRegion(document: Document, table: HTMLTableElement): HTMLElement {
  const region = element(document, "div", undefined, "table-region");
  region.setAttribute("tabindex", "0"); region.setAttribute("role", "region");
  const caption = table.firstElementChild!;
  region.id = `${caption.id}-region`; region.setAttribute("aria-labelledby", caption.id); region.append(table);
  if (table.className.split(" ").includes("wide-table")) {
    region.className += " wide-table-region";
    const cue = element(document, "p", "Scroll horizontally to see all columns", "scroll-cue"); cue.id = `${caption.id}-scroll-cue`; region.setAttribute("aria-describedby", cue.id); region.append(cue);
  }
  return region;
}
