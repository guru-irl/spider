// packages/ui/src/renderers/bind.ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "./types.js";
import type { RenderCtx } from "./types.js";

export interface BindDetails {
  ok: boolean;
  message?: string;
  path?: string;
}

/** Render the bind/unbind result as a themed card. */
export function renderBindResult(details: BindDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const out: string[] = [""];
  
  // Status header
  if (details.ok) {
    out.push(truncateToWidth(
      ` ${statusIcon(theme, "ok")} ${theme.fg("success", details.path ? "Session bound" : "Session unbound")}`,
      width, ""
    ));
  } else {
    out.push(truncateToWidth(
      ` ${statusIcon(theme, "fail")} ${theme.fg("error", "Failed")}`,
      width, ""
    ));
  }
  
  // Path if provided
  if (details.path) {
    out.push("");
    out.push(truncateToWidth(
      ` ${theme.fg("dim", "path:")} ${theme.fg("muted", details.path)}`,
      width, "…"
    ));
  }
  
  // Message (includes the scope rule for bind)
  if (details.message) {
    out.push("");
    const lines = details.message.split("\n");
    for (const line of lines) {
      if (line.trim()) {
        out.push(truncateToWidth(` ${theme.fg("muted", line)}`, width, "…"));
      } else {
        out.push("");
      }
    }
  }
  
  return out;
}
