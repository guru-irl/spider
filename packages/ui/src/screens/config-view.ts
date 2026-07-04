import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";
import { buildConfigModel } from "./config-model.js";
import { sectionRule, statusIcon } from "../renderers/types.js";

/** Pure, BODY-ONLY config render (no 🕸, no card()). For each schema group: a glyph-free
 *  `sectionRule`, then one row per field — ○ default / ● overridden status glyph, the field
 *  label, its current value, and a warning ` ⚠restart` marker. Every line is width-guarded.
 *  See docs/output-ui-guidelines.md. */
export function renderConfig(cfg: unknown, theme: ThemeAdapter, width: number): string[] {
	const body: string[] = [];
	for (const group of buildConfigModel(cfg)) {
		body.push(sectionRule(theme, group.label, width));
		for (const r of group.rows) {
			const glyph = statusIcon(theme, r.isDefault ? "off" : "on");
			const restart = r.field.restart ? theme.fg("warning", " ⚠restart") : "";
			const line = `${glyph} ${theme.fg("text", r.field.label)} ${theme.fg("muted", String(r.value))}${restart}`;
			body.push(truncateToWidth(line, width, ""));
		}
	}
	return body;
}

/** Component wrapper (cached by width) for mounting via ctx.ui.custom. */
export class ConfigView {
	private cachedWidth = -1;
	private cachedLines: string[] = [];
	constructor(private cfg: unknown, private theme: ThemeAdapter) {}
	invalidate(): void { this.cachedWidth = -1; }
	render(width: number): string[] {
		if (width === this.cachedWidth) return this.cachedLines;
		this.cachedLines = renderConfig(this.cfg, this.theme, width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}
