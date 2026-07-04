// Thin slash commands: each forwards its argument to the spider tool's dispatch (via `run`)
// and surfaces the result text through ctx.ui.notify. Only commands with a real backing
// `control` command (or action) are registered — the plan's `/upgrade` and `/purge` have no
// backing handler, so they are intentionally dropped.
//
// pi's command handler contract is `(args: string, ctx: ExtensionCommandContext) => Promise<void>`
// (see @earendil-works/pi-coding-agent types + makeTodosCommand). The FIRST param is the raw
// argument STRING, the SECOND is the command context (which run() needs to resolve db/session/cwd).
export const SLASH_COMMANDS = ["spider", "memory", "search", "insights", "learn", "doctor", "stats"] as const;

export type SlashCommandName = (typeof SLASH_COMMANDS)[number];

const FORWARD: Record<SlashCommandName, (arg: string) => Record<string, unknown>> = {
	spider: () => ({ action: "control", command: "stats" }),
	memory: () => ({ action: "recall" }),
	search: (arg) => ({ action: "search", query: arg }),
	insights: () => ({ action: "control", command: "insights" }),
	learn: (arg) => ({ action: "control", command: "skill", sub: "curate", note: arg || undefined }),
	doctor: () => ({ action: "control", command: "doctor" }),
	stats: () => ({ action: "control", command: "stats" }),
};

const DESC: Record<SlashCommandName, string> = {
	spider: "spider 🕸 dashboard",
	memory: "browse memory",
	search: "unified search",
	insights: "learning graph",
	learn: "distill a skill from this conversation",
	doctor: "spider health check",
	stats: "token savings + row counts",
};

export interface SlashDeps {
	run: (args: Record<string, unknown>, ctx: unknown) => Promise<{ content?: unknown; display?: unknown; details?: unknown }>;
	alreadyRegistered: Set<string>;
}

export interface PiLike {
	registerCommand(name: string, opts: { description: string; handler: (args: string, ctx: unknown) => unknown }): void;
}

/** Best-effort extraction of a human string from a dispatch result (content text | display | ""). */
function resultText(res: { content?: unknown; display?: unknown } | undefined): string {
	if (!res) return "";
	if (typeof res.content === "string") return res.content;
	if (typeof res.display === "string") return res.display;
	if (Array.isArray(res.content)) {
		return res.content
			.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

export function registerSlashCommands(pi: PiLike, deps: SlashDeps): void {
	for (const name of SLASH_COMMANDS) {
		if (deps.alreadyRegistered.has(name)) continue;
		pi.registerCommand(name, {
			description: DESC[name],
			handler: async (args: string, ctx: unknown) => {
				const arg = typeof args === "string" ? args.trim() : "";
				const res = await deps.run(FORWARD[name](arg), ctx);
				const text = resultText(res);
				const notify = (ctx as { ui?: { notify?: (t: string, k?: string) => void } })?.ui?.notify;
				if (text && typeof notify === "function") notify(text, "info");
			},
		});
	}
}
