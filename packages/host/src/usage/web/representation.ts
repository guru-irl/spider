export type Representation = "chart" | "table";
// Stable chart keys keep choices independent across page navigation and refreshes.
const presentations = new WeakMap<Document, Map<string, Representation>>();
export function clearRepresentation(document: Document): void { presentations.delete(document); }
export function representation(document: Document, chartId: string): Representation {
  return presentations.get(document)?.get(chartId) ?? "chart";
}
export function selectRepresentation(document: Document, chartId: string, mode: Representation): void {
  if (!presentations.has(document)) presentations.set(document, new Map());
  presentations.get(document)!.set(chartId, mode);
}
