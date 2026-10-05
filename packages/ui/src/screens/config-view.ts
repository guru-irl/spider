import type { ThemeAdapter } from "../agents/types.js";
import { CONFIG_SCHEMA, type ConfigGroup } from "./config-schema.js";
import { buildConfigModel } from "./config-model.js";
import { sectionRule, statusIcon, fitResultLines, resultTrimmer } from "../renderers/types.js";

/** Pure, BODY-ONLY config render (no 🕸, no card()). For each schema group: a glyph-free
 *  `sectionRule`, then one row per field — ○ default / ● overridden status glyph, the field
 *  label, its current value, and a warning ` ⚠restart` marker. Every line is width-guarded.
 *  See docs/output-ui-guidelines.md. */
export function renderConfig(cfg: unknown, theme: ThemeAdapter, width: number, expanded = false, schema: ConfigGroup[] = CONFIG_SCHEMA): string[] {
	const trim = resultTrimmer(expanded);
	const body: string[] = [];
	for (const group of buildConfigModel(cfg, schema)) {
		body.push(sectionRule(theme, group.label, width));
		for (const r of group.rows) {
			const glyph = statusIcon(theme, r.isDefault ? "off" : "on");
			const restart = r.field.restart ? theme.fg("warning", " ⚠restart") : "";
			const scope = r.field.scope === "global" ? theme.fg("muted", " (global-only; scope:global)") : "";
			const line = `${glyph} ${theme.fg("text", r.field.label)} ${theme.fg("muted", typeof r.value === "object" && r.value !== null ? JSON.stringify(r.value) : String(r.value))}${scope}${restart}`;
			body.push(trim(line, width, ""));
		}
	}
	return fitResultLines(body, width, expanded);
}

/** Component wrapper (cached by width) for mounting via ctx.ui.custom. */
export class ConfigView {
	private cachedWidth = -1;
	private cachedLines: string[] = [];
	constructor(private cfg: unknown, private theme: ThemeAdapter, private schema: ConfigGroup[] = CONFIG_SCHEMA) {}
	invalidate(): void { this.cachedWidth = -1; }
	render(width: number): string[] {
		if (width === this.cachedWidth) return this.cachedLines;
		this.cachedLines = renderConfig(this.cfg, this.theme, width, false, this.schema);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}
