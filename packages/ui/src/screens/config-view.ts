import type { ThemeAdapter } from "../agents/types.js";
import { CONFIG_SCHEMA, type ConfigGroup } from "./config-schema.js";
import { icon } from "../icons.js";
import { buildConfigModel } from "./config-model.js";
import { sectionRule, statusIcon, fitResultLines, resultTrimmer } from "../renderers/types.js";

/** Body-only config view. Each group has a section rule and a row per field, with its
 *  status, value, and restart warning. Every line is width-guarded.
 *  See docs/output-ui-guidelines.md. */
export function renderConfig(cfg: unknown, theme: ThemeAdapter, width: number, expanded = false, schema: ConfigGroup[] = CONFIG_SCHEMA, transcript = false): string[] {
	const trim = resultTrimmer(expanded);
	const body: string[] = [];
	const groups = buildConfigModel(cfg, schema);
	const indent = transcript ? " " : "";
	for (const group of groups) {
		if (!transcript || groups.length > 1) body.push(indent + sectionRule(theme, group.label, width - indent.length));
		for (const r of group.rows) {
			const glyph = statusIcon(theme, r.isDefault ? "off" : "on");
			const restart = r.field.restart ? theme.fg("warning", ` ${icon(theme.iconStyle, "warning")}restart`) : "";
			const scope = r.field.scope === "global" ? theme.fg("muted", " (global-only; scope:global)") : "";
			const line = `${glyph} ${theme.fg("text", r.field.label)} ${theme.fg("muted", r.field.optional && r.value === undefined ? "unset" : typeof r.value === "object" && r.value !== null ? JSON.stringify(r.value) : String(r.value))}${scope}${restart}`;
			body.push(trim(indent + line, width, ""));
		}
	}
	return fitResultLines(body, width, expanded, transcript ? 3 : undefined);
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
