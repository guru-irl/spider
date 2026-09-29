import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { makeConfigReloader } from "../config-reload.js";
import { controlConfig } from "../control.js";

const scratch = join(process.cwd(), "packages/host/.spider/scratch");
mkdirSync(scratch, { recursive: true });
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("config hot-reload", () => {
	it("re-applies merged config on reload()", () => {
		const dir = mkdtempSync(join(scratch, "reload-"));
		fixtures.push(dir);
		execFileSync("git", ["init", "-q"], { cwd: dir });
		controlConfig("set", dir, "ui.footer", false);
		let applied: unknown;
		const r = makeConfigReloader(dir, (m) => { applied = m; });
		r.reload();
		expect((applied as Record<string, unknown>)["ui.footer"]).toBe(false);
	});
});
