/** The same fallback is used before and after transcript metadata backfill. */
export function shortSessionName(id: string): string { return id.slice(0, 7); }
