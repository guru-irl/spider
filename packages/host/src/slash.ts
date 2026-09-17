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
	learn: (arg) => ({ action: "skill", op: "distill", text: arg || undefined }),
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
	run: (args: Record<string, unknown>, ctx: unknown) => Promise<{ content?: unknown; display?: unknown; details?: unknown; lines?: unknown; text?: unknown; error?: unknown; ok?: unknown }>;
	alreadyRegistered: Set<string>;
}

export interface PiLike {
	registerCommand(name: string, opts: { description: string; handler: (args: string, ctx: unknown) => unknown }): void;
	/** sendMessage lives on the pi ExtensionApi (NOT the command ctx); optional so tests can omit it. */
	sendMessage?(message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
	/** Real user-turn delivery API (pi ExtensionApi.sendUserMessage). Feature-detected —
	 * optional so older hosts/tests that lack it degrade to the sendMessage fallback. */
	sendUserMessage?(content: string, options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;
}

/** Best-effort human string from a dispatch result — only used for the model-facing `content`
 * and the notify fallback; the RICH transcript view renders via renderSpiderResult (see
 * renderCommandOutput), so control's {details} shape does not need to stringify here. */
function resultText(res: { content?: unknown; display?: unknown; lines?: unknown; text?: unknown; error?: unknown } | undefined): string {
	if (!res) return "";
	if (typeof res.content === "string") return res.content;
	if (Array.isArray(res.content)) {
		return res.content
			.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
			.filter(Boolean)
			.join("\n");
	}
	if (typeof res.display === "string") return res.display;
	if (Array.isArray(res.lines)) return (res.lines as unknown[]).filter((l): l is string => typeof l === "string").join("\n");
	if (typeof res.text === "string") return res.text;
	if (typeof res.error === "string") return `Error: ${res.error}`;
	return "";
}

/** Best-effort `ctx.ui.notify` extraction shared by the generic path and /learn's error path. */
function notifyOf(ctx: unknown): ((text: string, kind?: string) => void) | undefined {
	const notify = (ctx as { ui?: { notify?: (t: string, k?: string) => void } })?.ui?.notify;
	return typeof notify === "function" ? notify : undefined;
}

/**
 * `/learn` is a special case (P1–P6, organism-fix-brief): unlike the other
 * thin slash commands, it must deliver the FULL distilled prompt as a real
 * queued agent turn — not just a themed display card — through supported pi
 * prompt-delivery APIs, and it must never invoke the curator or self-approve
 * anything.
 */
async function handleLearn(pi: PiLike, deps: SlashDeps, arg: string, ctx: unknown): Promise<void> {
	const res = await deps.run(FORWARD.learn(arg), ctx);
	const details = res && typeof res === "object" ? (res as { details?: unknown }).details : undefined;
	const prompt = details && typeof details === "object" ? (details as { prompt?: unknown }).prompt : undefined;
	if (!res || typeof (res as { error?: unknown }).error === "string" || typeof prompt !== "string" || prompt.length === 0) {
		const reason = res && typeof (res as { error?: unknown }).error === "string" ? String((res as { error?: unknown }).error) : "distill did not return a usable prompt";
		const message = `Could not start /learn: ${reason}`;
		if (typeof pi.sendMessage === "function") {
			pi.sendMessage({ customType: "spider.command", content: message, display: true, details: { args: { action: "skill", op: "distill", text: arg }, result: res } });
		} else {
			notifyOf(ctx)?.(message, "error");
		}
		return;
	}

	// A short themed confirmation carries the user's note only — the full prompt
	// is delivered separately below, never duplicated into this card's content
	// (sendMessage's `content` enters the model-facing transcript regardless of
	// `display`, so putting the full prompt here too would double-deliver it).
	const confirmation = arg ? `/learn "${arg}" — distilling a skill from this note.` : "/learn — distilling a skill from this conversation.";
	if (typeof pi.sendMessage === "function") {
		pi.sendMessage({ customType: "spider.command", content: confirmation, display: true, details: { args: { action: "skill", op: "distill", text: arg }, result: res } });
	}

	// Use the documented ctx.isIdle when available; NEVER an invented isStreaming.
	// When idle-state cannot be determined at all, be conservative and treat the
	// agent as busy (followUp) rather than assuming idle.
	const isIdleFn = (ctx as { isIdle?: () => boolean } | undefined)?.isIdle;
	const busy = typeof isIdleFn === "function" ? !isIdleFn() : true;

	if (typeof pi.sendUserMessage === "function") {
		// expandPromptTemplates is never enabled — the distilled prompt is plain text.
		pi.sendUserMessage(prompt, busy ? { deliverAs: "followUp" } : undefined);
		return;
	}
	if (typeof pi.sendMessage === "function") {
		// Compatibility fallback: MUST carry the FULL prompt (not the short
		// confirmation) and trigger a real turn — display:false so it is not
		// visually duplicated alongside the confirmation card above.
		pi.sendMessage(
			{ customType: "spider.learn.prompt", content: prompt, display: false, details: { learn: true } },
			{ triggerTurn: true, deliverAs: busy ? "followUp" : undefined },
		);
		return;
	}
	// No prompt-capable API on this host: report clearly — a notify-only toast
	// is not successful learning, and we never claim earlier pi versions were
	// exercised merely because feature detection ran.
	notifyOf(ctx)?.(
		"learn: this pi host has no prompt-delivery API; the distilled prompt is NOT queued. Manual fallback: copy the request into a new turn yourself, or upgrade pi.",
		"error",
	);
}

export function registerSlashCommands(pi: PiLike, deps: SlashDeps): void {
	for (const name of SLASH_COMMANDS) {
		if (deps.alreadyRegistered.has(name)) continue;
		pi.registerCommand(name, {
			description: DESC[name],
			handler: async (args: string, ctx: unknown) => {
				const arg = typeof args === "string" ? args.trim() : "";
				if (name === "learn") {
					await handleLearn(pi, deps, arg, ctx);
					return;
				}
				const forwarded = FORWARD[name](arg);
				const res = await deps.run(forwarded, ctx);
				if (!res) return;
				// Primary: a persistent spider.command transcript entry rendered by renderCommandOutput
				// (which reuses the tool's renderSpiderResult) — themed, identical to a real spider result.
				if (typeof pi.sendMessage === "function") {
					pi.sendMessage({ customType: "spider.command", content: resultText(res) || `spider ${String((forwarded as { command?: unknown }).command ?? (forwarded as { action?: unknown }).action ?? name)}`, display: true, details: { args: forwarded, result: res } });
					return;
				}
				// Fallback (no ExtensionApi.sendMessage): ephemeral toast with whatever text we can extract.
				const text = resultText(res);
				if (text) notifyOf(ctx)?.(text, "info");
			},
		});
	}
}
