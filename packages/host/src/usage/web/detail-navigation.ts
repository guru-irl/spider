import type { ViewContext, ViewRoute } from "./views.js";

// These views never choose a period. Omitting it preserves the shell's rolling
// month, or the user's explicit window, rather than turning rolling into fixed.
export function detailRoute(ctx: ViewContext & { kind?: "session" | "run" }, view: "session" | "run", id?: string): ViewRoute {
  const sameIdentity = ctx.kind === view && ctx.id === id;
  return { view, ...(id === undefined ? {} : { id }), filters: id === undefined || sameIdentity ? ctx.filters : ctx.filters.filter(filter =>
    !(filter.field === "session" || filter.field === "run" || filter.field === "parentRun")) };
}
