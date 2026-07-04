import { describe, it, expect } from "vitest";
import { renderConfig, ConfigView } from "../config-view.js";
import type { ThemeAdapter } from "../../agents/types.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };

describe("renderConfig", () => {
	it("renders group labels body-only (no 🕸) and stays within width", () => {
		const lines = renderConfig({ "ui.footer": false }, id, 50);
		const out = lines.join("\n");
		expect(out).not.toContain("🕸");
		expect(out).toMatch(/Organism|UI|Memory/);
		for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(50);
	});
});

describe("ConfigView", () => {
	it("caches by width", () => {
		const v = new ConfigView({ "ui.footer": false }, id);
		const a = v.render(50);
		expect(v.render(50)).toBe(a);
		const b = v.render(70);
		expect(b).not.toBe(a);
		v.invalidate();
		expect(v.render(50)).not.toBe(a);
	});
});
