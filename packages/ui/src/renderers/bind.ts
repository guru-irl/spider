// packages/ui/src/renderers/bind.ts
import { fitResultLines, resultTrimmer, statusIcon } from "./types.js";
import type { RenderCtx } from "./types.js";

export interface BindDetails {
  ok: boolean;
  message?: string;
  path?: string;
}

/** Render the bind/unbind result as a themed card. */
export function renderBindResult(details: BindDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const expanded = ctx.expanded === true;
  const trim = resultTrimmer(expanded);
  const out: string[] = [""];
  
  // Status header
  if (details.ok) {
    out.push(trim(
      ` ${statusIcon(theme, "ok")} ${theme.fg("success", details.path ? "Session bound" : "Session unbound")}`,
      width, ""
    ));
  } else {
    out.push(trim(
      ` ${statusIcon(theme, "fail")} ${theme.fg("error", "Failed")}`,
      width, ""
    ));
  }
  
  // Path if provided
  if (details.path) {
    out.push("");
    out.push(trim(
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
        out.push(trim(` ${theme.fg("muted", line)}`, width, "…"));
      } else {
        out.push("");
      }
    }
  }
  
  return fitResultLines(out, width, expanded);
}
