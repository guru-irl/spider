import { UI_CONFIG_SCHEMA } from "../ui-thinking.js";
import { coerce, getField } from "@spider/ui";
import { controlConfig, type ConfigWriteResult } from "../control.js";

type ConfigEditResult = (ConfigWriteResult & { error?: undefined }) | { ok: false; error: string };

function keyError(key: string, scope: "local" | "global"): string | undefined {
	if (getField(key, UI_CONFIG_SCHEMA)?.scope === "global" && scope !== "global") return `${key} is global-only; use scope:"global"`;
	// Security settings can only be changed by the user.
	if (key === "exec.enforce") {
		return "exec.enforce is protected and can only be changed by the user via the /exec-enforce slash command";
	}
	if (key === "subagents.extensions") {
		return "subagents.extensions is protected and can only be changed by the user in ~/.pi/agent/spider/config.json, or config.json under SPIDER_GLOBAL_ROOT";
	}
	if (!getField(key, UI_CONFIG_SCHEMA)) return `unknown key ${key}`;
	return undefined;
}

/** Resolve the field, coerce the raw string, and persist only valid edits in the chosen layer. */
export function applyConfigEdit(cwd: string, key: string, raw: string, scope: "local" | "global" = "local"): ConfigEditResult {
	const error = keyError(key, scope);
	if (error) return { ok: false, error };
	const c = coerce(getField(key, UI_CONFIG_SCHEMA)!, raw);
	if (!c.ok) return { ok: false, error: c.error ?? "invalid value" };
	if (key === "memory.snapshotCharCap" && c.value === undefined) return controlConfig("unset", cwd, key, undefined, scope);
	return controlConfig("set", cwd, key, c.value, scope);
}

/** Unset uses the same key validation and protection as set, without value coercion. */
export function applyConfigUnset(cwd: string, key: string, scope: "local" | "global" = "local"): ConfigEditResult {
	const error = keyError(key, scope);
	if (error) return { ok: false, error };
	return controlConfig("unset", cwd, key, undefined, scope);
}
