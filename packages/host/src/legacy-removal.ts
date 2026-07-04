// Defensive runtime cutover (Task 21): unregister deprecated legacy tools that OTHER
// extensions (pi-subagents, context-mode, pi-todo-sqlite) may still register, so `spider`
// owns the surface. The current pi build exposes no `unregisterTool` API, so at runtime
// this SAFELY no-ops (everything -> skipped); the value is the tested LEGACY_TOOLS
// manifest + graceful degradation for whenever such an API lands.
export const LEGACY_TOOLS: string[] = [
	"memory",
	"memory_search",
	"session_search",
	"skill_manage",
	"todo",
	"subagent",
	"wait",
	"ctx_execute",
	"ctx_execute_file",
	"ctx_index",
	"ctx_search",
	"ctx_fetch_and_index",
	"ctx_batch_execute",
	"ctx_stats",
	"ctx_doctor",
	"ctx_upgrade",
	"ctx_purge",
	"ctx_insight",
];

export interface PiLike {
	unregisterTool?: (name: string) => boolean | void;
}

export function removeLegacyTools(pi: PiLike): { removed: string[]; skipped: string[] } {
	const removed: string[] = [];
	const skipped: string[] = [];
	const un = typeof pi.unregisterTool === "function" ? pi.unregisterTool.bind(pi) : undefined;
	for (const name of LEGACY_TOOLS) {
		if (!un) {
			skipped.push(name);
			continue;
		}
		try {
			un(name);
			removed.push(name);
		} catch {
			skipped.push(name);
		}
	}
	return { removed, skipped };
}
