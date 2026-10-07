export type Representation = "chart" | "table";
// Stable chart keys keep choices independent across refreshes and rail navigation.
const presentations = new WeakMap<Document, { fallback: Representation; charts: Map<string, Representation> }>();
export function configureRepresentation(document: Document, fallback: Representation): void {
  const state = presentations.get(document);
  if (state) state.fallback = fallback;
  else presentations.set(document, { fallback, charts: new Map() });
}
export function clearRepresentation(document: Document): void { presentations.delete(document); }
export function representation(document: Document, chartId: string): Representation {
  const state = presentations.get(document);
  return state?.charts.get(chartId) ?? state?.fallback ?? "chart";
}
export function selectRepresentation(document: Document, chartId: string, mode: Representation): void {
  if (!presentations.has(document)) configureRepresentation(document, "chart");
  presentations.get(document)!.charts.set(chartId, mode);
}
