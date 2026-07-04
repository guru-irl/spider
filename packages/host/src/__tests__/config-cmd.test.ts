import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyConfigEdit } from "../control/config-cmd.js";
import { controlConfig } from "../control.js";

// Use a repo-local scratch dir (never /tmp).
const scratch = join(process.cwd(), "packages/host/.spider/scratch");
mkdirSync(scratch, { recursive: true });

describe("applyConfigEdit round-trip", () => {
	it("coerces, writes and reads back a boolean", () => {
		const dir = mkdtempSync(join(scratch, "cfg-"));
		const r = applyConfigEdit(dir, "ui.footer", "false");
		expect(r.ok).toBe(true);
		expect(controlConfig("get", dir, "ui.footer")).toBe(false);
	});
	it("rejects an out-of-range number without writing", () => {
		const dir = mkdtempSync(join(scratch, "cfg-"));
		const r = applyConfigEdit(dir, "memory.snapshotCharCap", "999999999");
		expect(r.ok).toBe(false);
		expect(controlConfig("get", dir, "memory.snapshotCharCap")).toBeUndefined();
	});
	it("rejects an unknown key", () => {
		const dir = mkdtempSync(join(scratch, "cfg-"));
		expect(applyConfigEdit(dir, "nope.nope", "x").ok).toBe(false);
	});
});
