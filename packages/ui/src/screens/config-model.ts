import { CONFIG_SCHEMA } from "./config-schema.js";
import type { ConfigField } from "./config-schema.js";

export interface ConfigFieldRow { field: ConfigField; value: unknown; isDefault: boolean; }
export interface ConfigGroupModel { id: string; label: string; rows: ConfigFieldRow[]; }

/** Read a config value by key. The real store uses FLAT dotted keys (see host controlConfig),
 *  so check the flat key FIRST, then fall back to nested traversal. */
export function readPath(cfg: unknown, key: string): unknown {
	if (cfg && typeof cfg === "object" && Object.prototype.hasOwnProperty.call(cfg, key)) {
		return (cfg as Record<string, unknown>)[key]; // flat dotted key (real storage) wins
	}
	let cur: unknown = cfg;
	for (const part of key.split(".")) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

export function buildConfigModel(cfg: unknown): ConfigGroupModel[] {
	return CONFIG_SCHEMA.map((g) => ({
		id: g.id, label: g.label,
		rows: g.fields.map((field) => {
			const raw = readPath(cfg, field.key);
			const has = raw !== undefined;
			return { field, value: has ? raw : field.default, isDefault: !has };
		}),
	}));
}
