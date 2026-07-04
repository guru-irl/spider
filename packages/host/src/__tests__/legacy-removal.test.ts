import { describe, expect, it } from "vitest";
import { LEGACY_TOOLS, removeLegacyTools } from "../legacy-removal";

describe("removeLegacyTools", () => {
	it("removes all LEGACY_TOOLS when pi.unregisterTool exists", () => {
		const removed: string[] = [];
		const pi = {
			unregisterTool: (name: string) => {
				removed.push(name);
				return true;
			},
		};
		const result = removeLegacyTools(pi);
		expect(result.removed.sort()).toEqual([...LEGACY_TOOLS].sort());
		expect(result.skipped).toEqual([]);
		expect(removed.sort()).toEqual([...LEGACY_TOOLS].sort());
	});

	it("never targets pi builtins", () => {
		const builtins = ["edit", "write", "read", "bash", "grep", "find", "ls"];
		for (const b of builtins) {
			expect(LEGACY_TOOLS).not.toContain(b);
		}
	});

	it("degrades to skipped when pi has no unregisterTool API", () => {
		const pi = {};
		const result = removeLegacyTools(pi);
		expect(result.removed).toEqual([]);
		expect(result.skipped.sort()).toEqual([...LEGACY_TOOLS].sort());
	});
});
