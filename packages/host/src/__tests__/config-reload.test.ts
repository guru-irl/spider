import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeConfigReloader } from "../config-reload.js";
import { controlConfig } from "../control.js";

const scratch = join(process.cwd(), "packages/host/.spider/scratch");
mkdirSync(scratch, { recursive: true });

describe("config hot-reload", () => {
	it("re-applies merged config on reload()", () => {
		const dir = mkdtempSync(join(scratch, "reload-"));
		controlConfig("set", dir, "ui.footer", false);
		let applied: unknown;
		const r = makeConfigReloader(dir, (m) => { applied = m; });
		r.reload();
		expect((applied as Record<string, unknown>)["ui.footer"]).toBe(false);
	});
});
