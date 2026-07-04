import { describe, it, expect } from "vitest";
import { buildConfigModel, readPath } from "../config-model.js";

describe("config model", () => {
	it("reads a dotted path (nested)", () => {
		expect(readPath({ ui: { footer: false } }, "ui.footer")).toBe(false);
		expect(readPath({}, "ui.footer")).toBeUndefined();
	});
	it("reads a flat dotted key (real storage) first", () => {
		expect(readPath({ "ui.footer": false }, "ui.footer")).toBe(false);
	});
	it("falls back to defaults and flags isDefault (nested)", () => {
		const groups = buildConfigModel({ ui: { footer: false } });
		const ui = groups.find((g) => g.id === "ui")!;
		const footer = ui.rows.find((r) => r.field.key === "ui.footer")!;
		expect(footer.value).toBe(false);
		expect(footer.isDefault).toBe(false);
		const theme = ui.rows.find((r) => r.field.key === "ui.theme")!;
		expect(theme.value).toBe("auto");
		expect(theme.isDefault).toBe(true);
	});
	it("flags overridden values from a flat map", () => {
		const groups = buildConfigModel({ "ui.footer": false });
		const ui = groups.find((g) => g.id === "ui")!;
		const footer = ui.rows.find((r) => r.field.key === "ui.footer")!;
		expect(footer.value).toBe(false);
		expect(footer.isDefault).toBe(false);
	});
});
