import { describe, it, expect } from "vitest";
import { CONFIG_SCHEMA, getField, coerce } from "../config-schema.js";

describe("config schema", () => {
	it("declares all eight groups", () => {
		const ids = CONFIG_SCHEMA.map((g) => g.id).sort();
		expect(ids).toEqual(["curator", "embeddings", "memory", "models", "organism", "routing", "self_naming", "ui"].sort());
	});
	it("every field key is dotted-prefixed by its group id", () => {
		for (const g of CONFIG_SCHEMA) for (const f of g.fields) expect(f.key.startsWith(g.id + ".")).toBe(true);
	});
	it("coerce validates booleans, enums and numeric ranges", () => {
		const boolF = getField("organism.enabled")!;
		expect(coerce(boolF, "true")).toEqual({ ok: true, value: true });
		const numF = getField("memory.snapshotCharCap")!;
		expect(coerce(numF, "abc").ok).toBe(false);
		expect(coerce(numF, String((numF.max ?? 100000) + 1)).ok).toBe(false);
		const enumF = CONFIG_SCHEMA.flatMap((g) => g.fields).find((f) => f.type === "enum")!;
		expect(coerce(enumF, "___not_in_enum___").ok).toBe(false);
		expect(coerce(enumF, enumF.enum![0])).toEqual({ ok: true, value: enumF.enum![0] });
	});
});
