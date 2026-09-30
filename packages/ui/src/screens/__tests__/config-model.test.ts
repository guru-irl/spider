import { describe, it, expect } from "vitest";
import { buildConfigModel, readPath } from "../config-model.js";
import { getField } from "../config-schema.js";

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
		expect(ui.rows.some((r) => r.field.key === "ui.theme")).toBe(false);
	});
	it("does not advertise an unsupported configurable grid shortcut or theme", () => {
		expect(getField("ui.gridHotkey")).toBeUndefined();
		expect(getField("ui.grid_hotkey")).toBeUndefined();
		expect(getField("ui.theme")).toBeUndefined();
	});
	it("flags overridden values from a flat map", () => {
		const groups = buildConfigModel({ "ui.footer": false });
		const ui = groups.find((g) => g.id === "ui")!;
		const footer = ui.rows.find((r) => r.field.key === "ui.footer")!;
		expect(footer.value).toBe(false);
		expect(footer.isDefault).toBe(false);
	});
});
