import type { ThemeAdapter } from "../agents/types.js";
import { icon } from "../icons.js";
import type { ModelEntry } from "@spider/models";
import { catalogRows, isAgentModelRole, type ModelThinkingDisplay } from "./models-model.js";
import { sectionRule, fitResultLines, resultTrimmer } from "../renderers/types.js";

/** Model catalog grouped by tier. Each row shows availability, the model reference,
 *  capability badges, and a marker for role defaults. Every line is width-guarded. */
export interface ModelDefaultOrigins {
  sources: Record<string, "default" | "local" | "global">;
  global: Record<string, string>;
}

export function renderModels(entries: ModelEntry[], defaults: Record<string, string>, theme: ThemeAdapter, width: number, origins?: ModelDefaultOrigins, expanded = false, thinking?: ModelThinkingDisplay, transcript = false): string[] {
  const trim = resultTrimmer(expanded);
  const body: string[] = [];
  const groups = catalogRows(entries, defaults, thinking);
  const roles = origins ? Object.entries(defaults) : [];
  const manyGroups = groups.length + Number(roles.length > 0) > 1;
  const indent = transcript ? " " : "";
  const roleLabel = (role: string) => isAgentModelRole(role) ? theme.italic?.(role) ?? role : role;
  for (const group of groups) {
    if (!transcript || manyGroups) body.push(indent + sectionRule(theme, group.tier, width - indent.length));
    for (const row of group.rows) {
      const glyph = theme.fg(row.available ? "accent" : "muted", icon(theme.iconStyle, row.available ? "running" : "open"));
      const badges: string[] = [];
      if (row.thinking) badges.push(theme.fg("dim", "R"));
      if (row.vision) badges.push(theme.fg("dim", "V"));
      const badge = badges.length ? ` ${badges.join("")}` : "";
      const dflt = row.isDefaultFor.length ? theme.fg("success", ` ${icon(theme.iconStyle, "modelDefault")} ${row.isDefaultFor.map(roleLabel).join(",")}`) : "";
      const name = theme.modelName?.(row.ref)?.trim() || row.ref;
      body.push(trim(`${indent}${glyph} ${theme.fg("text", name)}${badge}${dflt}`, width, ""));
      if (row.thinkingLevels.length) body.push(trim(theme.fg("dim", `${indent}  thinking: ${row.thinkingLevels.join(", ")}`), width, ""));
    }
  }
  if (origins && roles.length) {
    if (!transcript || manyGroups) body.push(indent + sectionRule(theme, "Role defaults", width - indent.length));
    for (const [role, ref] of roles) {
      const source = origins.sources[role] ?? "global";
      const shadow = source === "local" && origins.global[role] !== undefined
        ? `; shadows global ${origins.global[role]}` : "";
      body.push(trim(`${indent}${roleLabel(role)}: ${ref} (${source}${shadow})`, width, ""));
    }
  }
  if (transcript && !body.length) body.push(" (no models)");
  return fitResultLines(body, width, expanded, transcript ? 3 : undefined);
}

/** Component wrapper (cached by width) for mounting via ctx.ui.custom. */
export class ModelsView {
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  constructor(private entries: ModelEntry[], private defaults: Record<string, string>, private theme: ThemeAdapter, private origins?: ModelDefaultOrigins, private thinking?: ModelThinkingDisplay) {}
  invalidate(): void { this.cachedWidth = -1; }
  render(width: number): string[] {
    if (width === this.cachedWidth) return this.cachedLines;
    this.cachedLines = renderModels(this.entries, this.defaults, this.theme, width, this.origins, false, this.thinking);
    this.cachedWidth = width;
    return this.cachedLines;
  }
}
