import { coerce, getField } from "@spider/ui";
import { controlConfig } from "../control.js";

/** Pure round-trip seam for `control config set`: resolve the field, coerce the raw string,
 *  and (only if valid) persist it via controlConfig. Unknown key or invalid value → { ok:false }. */
export function applyConfigEdit(cwd: string, key: string, raw: string): { ok: boolean; error?: string } {
	// Protected key: exec.enforce can only be changed by user via slash command
	if (key === "exec.enforce") {
		return { ok: false, error: "exec.enforce is protected and can only be changed by the user via the /exec-enforce slash command" };
	}
	const field = getField(key);
	if (!field) return { ok: false, error: `unknown key ${key}` };
	const c = coerce(field, raw);
	if (!c.ok) return { ok: false, error: c.error };
	controlConfig("set", cwd, key, c.value);
	return { ok: true };
}
