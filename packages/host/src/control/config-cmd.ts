import { coerce, getField } from "@spider/ui";
import { controlConfig } from "../control.js";

/** Pure round-trip seam for `control config set`: resolve the field, coerce the raw string,
 *  and (only if valid) persist it via controlConfig. Unknown key or invalid value → { ok:false }. */
export function applyConfigEdit(cwd: string, key: string, raw: string): { ok: boolean; error?: string } {
	const field = getField(key);
	if (!field) return { ok: false, error: `unknown key ${key}` };
	const c = coerce(field, raw);
	if (!c.ok) return { ok: false, error: c.error };
	controlConfig("set", cwd, key, c.value);
	return { ok: true };
}
