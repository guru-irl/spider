import { coerce, getField } from "@spider/ui";
import { controlConfig, type ConfigWriteResult } from "../control.js";

type ConfigEditResult = (ConfigWriteResult & { error?: undefined }) | { ok: false; error: string };

function keyError(key: string): string | undefined {
	// Protected key: exec.enforce can only be changed by user via slash command.
	if (key === "exec.enforce") {
		return "exec.enforce is protected and can only be changed by the user via the /exec-enforce slash command";
	}
	if (!getField(key)) return `unknown key ${key}`;
	return undefined;
}

/** Resolve the field, coerce the raw string, and persist only valid edits in the chosen layer. */
export function applyConfigEdit(cwd: string, key: string, raw: string, scope: "local" | "global" = "local"): ConfigEditResult {
	const error = keyError(key);
	if (error) return { ok: false, error };
	const c = coerce(getField(key)!, raw);
	if (!c.ok) return { ok: false, error: c.error ?? "invalid value" };
	if (key === "memory.snapshotCharCap" && c.value === undefined) return controlConfig("unset", cwd, key, undefined, scope);
	return controlConfig("set", cwd, key, c.value, scope);
}

/** Unset uses the same key validation and protection as set, without value coercion. */
export function applyConfigUnset(cwd: string, key: string, scope: "local" | "global" = "local"): ConfigEditResult {
	const error = keyError(key);
	if (error) return { ok: false, error };
	return controlConfig("unset", cwd, key, undefined, scope);
}
