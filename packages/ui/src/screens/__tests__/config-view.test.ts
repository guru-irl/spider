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

it.each([
  { value: [], json: "[]" },
  { value: ["/a,one.ts", "/b.ts"], json: '["/a,one.ts","/b.ts"]' },
  { value: { worker: "provider/model" }, json: '{"worker":"provider/model"}' },
])("renders structured config values as JSON: $json", ({ value, json }) => {
  const lines = renderConfig({ "subagents.extensions": value }, id, 160, true);
  expect(lines.find(line => line.includes("Child extensions"))).toContain(json);
});

it("renders model defaults as a JSON object", () => {
  const lines = renderConfig({ "models.defaults": { worker: "provider/model" } }, id, 160, true);
  expect(lines.find(line => line.includes("Role defaults"))).toContain('{"worker":"provider/model"}');
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

it("renders an optional budget as unset instead of undefined", () => {
 const lines=renderConfig({},id,160,true);
 const budget=lines.find(line=>line.includes("Monthly budget"));
 expect(budget).toContain("unset");expect(budget).not.toContain("undefined");
 expect(renderConfig({"usage.monthlyBudget":0.5},id,160,true).find(line=>line.includes("Monthly budget"))).toContain("0.5");
});
