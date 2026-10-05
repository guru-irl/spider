import { describe, it, expect } from "vitest";
import { CONFIG_SCHEMA, createConfigSchema, getField, coerce } from "../config-schema.js";

describe("config schema", () => {
	it("declares only groups with working settings", () => {
		const ids = CONFIG_SCHEMA.map((g) => g.id).sort();
		expect(ids).toEqual(["auxiliary", "curator", "embeddings", "exec", "memory", "models", "organism", "routing", "skills", "subagents", "ui"]);
	});
	it("offers Luna xhigh as the skill-reviewer UI defaults", () => {
		expect(getField("skills.reviewer.model")?.default).toBe("github-copilot/gpt-6-luna");
		expect(getField("skills.reviewer.thinking")?.default).toBe("xhigh");
	});
	it("curator consolidation defaults to the runtime's disabled value", () => {
		expect(getField("curator.consolidate")?.default).toBe(false);
	});
	it("marks the agents footer as applying from the next session", () => {
		expect(getField("ui.footer")?.restart).toBe(true);
	});
	it("snapshot cap is optional and warns that an explicit limit may omit entries", () => {
		const field = getField("memory.snapshotCharCap")!;
		expect(field.default).toBe("unlimited");
		expect(field.description).toMatch(/optional|explicit/i);
		expect(field.description).toMatch(/omit/i);
	});
	it("accepts unlimited or blank to clear only the optional snapshot cap", () => {
		const cap = getField("memory.snapshotCharCap")!;
		expect(coerce(cap, "unlimited")).toEqual({ ok: true, value: undefined });
		expect(coerce(cap, "")).toEqual({ ok: true, value: undefined });
		expect(coerce({ key: "example.dim", label: "Dim", description: "Dim", type: "number", default: 384 }, "unlimited").ok).toBe(false);
	});
	it("every field key is dotted-prefixed by its group id", () => {
		for (const g of CONFIG_SCHEMA) for (const f of g.fields) expect(f.key.startsWith(g.id + ".")).toBe(true);
	});
	it("offers an empty child extension list and coerces JSON absolute paths", () => {
		const field = getField("subagents.extensions");
		expect(field).toBeDefined();
		expect(field!.default).toEqual([]);
		expect(coerce(field!, '["/path/to/compaction.ts", "/path/to/other.js"]')).toEqual({ ok: true, value: ["/path/to/compaction.ts", "/path/to/other.js"] });
		expect(coerce(field!, "[]")).toEqual({ ok: true, value: [] });
	});
	it.each(['["relative.ts"]', '["/path/to/valid.ts", "../relative.ts"]', '[false]', '{}', 'null', 'bad json'])("rejects invalid child extension list %s", raw => {
		const field = getField("subagents.extensions");
		expect(field).toBeDefined();
		expect(coerce(field!, raw)).toMatchObject({ ok: false, error: expect.stringMatching(/absolute.*paths/i) });
	});
	it("allows disabling subagent cache warming with a live boolean setting", () => {
		const field = getField("subagents.keepCacheWarm");
		expect(field).toBeDefined();
		expect(field!.default).toBe(true);
		expect(field!.restart).not.toBe(true);
		expect(coerce(field!, "false")).toEqual({ ok: true, value: false });
		expect(coerce(field!, "true")).toEqual({ ok: true, value: true });
		expect(coerce(field!, "bogus").ok).toBe(false);
	});
	it("coerce validates booleans, enums and numeric ranges", () => {
		const boolF = getField("ui.footer")!;
		expect(coerce(boolF, "true")).toEqual({ ok: true, value: true });
		const numF = getField("memory.snapshotCharCap")!;
		expect(coerce(numF, "abc").ok).toBe(false);
		expect(coerce(numF, String((numF.max ?? 100000) + 1)).ok).toBe(false);
		const enumF = { key: "example.choice", label: "Choice", description: "Choice", type: "enum" as const, default: "a", enum: ["a", "b"] };
		expect(coerce(enumF, "___not_in_enum___").ok).toBe(false);
		expect(coerce(enumF, enumF.enum![0])).toEqual({ ok: true, value: enumF.enum![0] });
	});
});

it("reviewers expose independent thinking and timeout settings", () => {
  for (const [kind, thinking, timeout, max] of [["memory", "medium", 45000, 120000], ["skills", "xhigh", 180000, 600000]] as const) {
    const schema = createConfigSchema(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    const field = getField(`${kind}.reviewer.thinking`, schema)!;
    expect(field?.default).toBe(thinking);
    expect(field.enum).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(coerce(field, "max")).toEqual({ ok: true, value: "max" });
    expect(coerce(field, "off").ok).toBe(true);
    const time = getField(`${kind}.reviewer.timeoutMs`)!;
    expect(time.default).toBe(timeout); expect(time.max).toBe(max);
  }
  expect(getField("skills.reviewer.enabled")?.description).toContain("learner skill proposals are off");
});


it("explains that enum policy must be injected instead of reporting an empty option list", () => {
  expect(coerce(getField("memory.reviewer.thinking")!, "max")).toMatchObject({ ok: false, error: expect.stringMatching(/host must inject.*levels/i) });
});
