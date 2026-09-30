import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";
import type { ModelEntry } from "@spider/models";
import { catalogRows } from "./models-model.js";
import { sectionRule } from "../renderers/types.js";

/** Pure: the copilot model catalog grouped by tier, framed as a 🕸 models card. Each tier is
 *  an accent `── <tier> ──` rule; each model is an availability glyph (● available / ○ not),
 *  its `provider/id` ref, dim R/V capability badges (thinking / vision), and — when it is a
 *  configured role default — a success ` ⟵ role1,role2` marker. Every line is width-guarded. */
export interface ModelDefaultOrigins {
  sources: Record<string, "local" | "global">;
  global: Record<string, string>;
}

export function renderModels(entries: ModelEntry[], defaults: Record<string, string>, theme: ThemeAdapter, width: number, origins?: ModelDefaultOrigins): string[] {
  const body: string[] = [];
  for (const group of catalogRows(entries, defaults)) {
    body.push(sectionRule(theme, group.tier, width));
    for (const row of group.rows) {
      const glyph = row.available ? theme.fg("accent", "●") : theme.fg("muted", "○");
      const badges: string[] = [];
      if (row.thinking) badges.push(theme.fg("dim", "R"));
      if (row.vision) badges.push(theme.fg("dim", "V"));
      const badge = badges.length ? ` ${badges.join("")}` : "";
      const dflt = row.isDefaultFor.length ? theme.fg("success", ` ⟵ ${row.isDefaultFor.join(",")}`) : "";
      body.push(truncateToWidth(`${glyph} ${theme.fg("text", row.ref)}${badge}${dflt}`, width, ""));
    }
  }
  if (origins && Object.keys(defaults).length) {
    body.push(sectionRule(theme, "Role defaults", width));
    for (const [role, ref] of Object.entries(defaults)) {
      const source = origins.sources[role] ?? "global";
      const shadow = source === "local" && origins.global[role] !== undefined
        ? `; shadows global ${origins.global[role]}` : "";
      body.push(truncateToWidth(`${role}: ${ref} (${source}${shadow})`, width, ""));
    }
  }
  return body;
}

/** Component wrapper (cached by width) for mounting via ctx.ui.custom. */
export class ModelsView {
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  constructor(private entries: ModelEntry[], private defaults: Record<string, string>, private theme: ThemeAdapter, private origins?: ModelDefaultOrigins) {}
  invalidate(): void { this.cachedWidth = -1; }
  render(width: number): string[] {
    if (width === this.cachedWidth) return this.cachedLines;
    this.cachedLines = renderModels(this.entries, this.defaults, this.theme, width, this.origins);
    this.cachedWidth = width;
    return this.cachedLines;
  }
}
