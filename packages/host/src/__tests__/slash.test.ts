import { describe, expect, it, vi } from "vitest";
import { SLASH_COMMANDS, registerSlashCommands } from "../slash";

/** Capture registered handlers under pi's real contract: handler(args: string, ctx). */
function makePi() {
	const handlers: Record<string, (args: string, ctx: unknown) => unknown> = {};
	const registered: string[] = [];
	const sendMessage = vi.fn();
	const pi = {
		sendMessage,
		registerCommand(name: string, opts: { description: string; handler: (args: string, ctx: unknown) => unknown }) {
			registered.push(name);
			handlers[name] = opts.handler;
		},
	};
	return { pi, handlers, registered, sendMessage };
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

	it("emits a spider.command message via pi.sendMessage carrying {args,result} for themed rendering", async () => {
		const { pi, handlers, sendMessage } = makePi();
		const result = { details: { totals: { rows: 3 } } };
		const run = vi.fn(async () => result);
		registerSlashCommands(pi, { run, alreadyRegistered: new Set() });
		await handlers.stats("", { ui: {} });
		expect(sendMessage).toHaveBeenCalledTimes(1);
		const msg = sendMessage.mock.calls[0]?.[0] as any;
		expect(msg.customType).toBe("spider.command");
		expect(msg.display).toBe(true);
		expect(msg.details.args).toMatchObject({ action: "control", command: "stats" });
		expect(msg.details.result).toBe(result); // full dispatch result forwarded to the renderer
	});

	it("emits even when the result has no extractable text (control {details})", async () => {
		const { pi, handlers, sendMessage } = makePi();
		const run = vi.fn(async () => ({ details: { config: {} } }));
		registerSlashCommands(pi, { run, alreadyRegistered: new Set() });
		await handlers.spider("", { ui: {} });
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect((sendMessage.mock.calls[0]?.[0] as any).details.args).toMatchObject({ action: "control", command: "stats" });
	});

	it("falls back to ctx.ui.notify only when pi.sendMessage is unavailable", async () => {
		const { handlers } = makePi();
		const piNoSend = { registerCommand: (n: string, o: any) => { (handlers as any)[n] = o.handler; } } as any;
		const run = vi.fn(async () => ({ content: "5 results" }));
		registerSlashCommands(piNoSend, { run, alreadyRegistered: new Set() });
		const notify = vi.fn();
		await (handlers as any).stats("", { ui: { notify } });
		expect(notify).toHaveBeenCalledWith("5 results", "info");
	});
});
