import { controlConfig } from "./control.js";

/** Build a config reloader: reload() re-reads the merged (flat dotted-key) config and hands it
 *  to `apply` to re-apply live toggles. Restart-flagged fields (embedding model/dim) are not
 *  hot-applied by the caller. */
export function makeConfigReloader(cwd: string, apply: (merged: unknown) => void): { reload(): void } {
	return {
		reload(): void {
			const merged = controlConfig("get", cwd);
			apply(merged);
		},
	};
}
