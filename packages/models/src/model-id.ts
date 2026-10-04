/** Canonical family id for policy matching, not a replacement for the catalog id. */
export function normalizeModelId(id: string): string {
  return id.toLowerCase()
    .replace(/^.*\//, "")
    .replace(/^.*\.(?=(?:claude|gpt|gemini)-)/, "")
    .replace(/[@:].*$/, "")
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})(?:-v\d+)?$|-v\d+$/, "")
    .replace(/(\d)[.-](?=\d)/g, "$1.");
}
