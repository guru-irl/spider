import { describe, expect, it, vi } from "vitest";
import { SLASH_COMMANDS, registerSlashCommands } from "../slash";

/** Capture registered handlers under pi's real contract: handler(args: string, ctx). */
function makePi() {
	const handlers: Record<string, (args: string, ctx: unknown) => unknown> = {};
	const registered: string[] = [];
	const pi = {
		registerCommand(name: string, opts: { description: string; handler: (args: string, ctx: unknown) => unknown }) {
			registered.push(name);
			handlers[name] = opts.handler;
		},
	};
	return { pi, handlers, registered };
}

describe("registerSlashCommands", () => {
	it("registers each SLASH_COMMANDS entry exactly once, skipping already-registered names", () => {
		const { pi, registered } = makePi();
		const run = vi.fn(async () => ({ content: "ok" }));
		registerSlashCommands(pi, { run, alreadyRegistered: new Set(["todos", "agents"]) });
		for (const name of SLASH_COMMANDS) {
			expect(registered.filter((n) => n === name)).toHaveLength(1);
		}
		expect(registered).not.toContain("todos");
		expect(registered).not.toContain("agents");
	});

	it("forwards a thin command to its control sub-command (doctor)", async () => {
		const { pi, handlers } = makePi();
		const run = vi.fn(async (_args: Record<string, unknown>, _ctx: unknown) => ({ content: "ok" }));
		registerSlashCommands(pi, { run, alreadyRegistered: new Set() });
		await handlers.doctor("", { ui: {} });
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]?.[0]).toMatchObject({ action: "control", command: "doctor" });
	});

	it("passes the ARGUMENT string as the query and the CTX (not the arg) to run", async () => {
		const { pi, handlers } = makePi();
		const run = vi.fn(async (_args: Record<string, unknown>, _ctx: unknown) => ({ content: "ok" }));
		registerSlashCommands(pi, { run, alreadyRegistered: new Set() });
		const ctx = { ui: {}, cwd: "/x", sessionManager: { getSessionId: () => "s1" } };
		await handlers.search("foo bar", ctx);
		expect(run.mock.calls[0]?.[0]).toMatchObject({ action: "search", query: "foo bar" });
		expect(run.mock.calls[0]?.[1]).toBe(ctx); // the ctx, NOT the arg string
	});

	it("surfaces the result text via ctx.ui.notify", async () => {
		const { pi, handlers } = makePi();
		const run = vi.fn(async () => ({ content: "5 results" }));
		registerSlashCommands(pi, { run, alreadyRegistered: new Set() });
		const notify = vi.fn();
		await handlers.stats("", { ui: { notify } });
		expect(notify).toHaveBeenCalledWith("5 results", "info");
	});
});
