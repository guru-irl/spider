import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import { skillAction, buildLearnPrompt, type OrganismActionDeps } from "@spider/organism";
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

describe("/learn — real distill routing and prompt delivery (G5b)", () => {
	it("forwards a distill request carrying the note, not sub:'curate'", async () => {
		const { pi, handlers } = makePi();
		const run = vi.fn(async (_args: Record<string, unknown>, _ctx: unknown) => ({ details: { prompt: "FULL PROMPT TEXT" } }));
		registerSlashCommands(pi, { run, alreadyRegistered: new Set() });
		await handlers.learn("release steps", { isIdle: () => true });
		expect(run.mock.calls[0]?.[0]).toMatchObject({ action: "skill", op: "distill", text: "release steps" });
	});

	it("delivers the FULL distilled prompt via sendUserMessage when idle, not just a themed card", async () => {
		const { pi, handlers, sendMessage } = makePi();
		const sendUserMessage = vi.fn();
		(pi as any).sendUserMessage = sendUserMessage;
		const run = vi.fn(async (_args: Record<string, unknown>, _ctx: unknown) => ({ details: { prompt: "FULL PROMPT TEXT" } }));
		registerSlashCommands(pi, { run, alreadyRegistered: new Set() });
		await handlers.learn("release steps", { isIdle: () => true });
		expect(sendUserMessage).toHaveBeenCalledWith("FULL PROMPT TEXT", undefined);
		// The short confirmation card must never also carry the full prompt.
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect((sendMessage.mock.calls[0][0] as any).content).not.toContain("FULL PROMPT TEXT");
	});

	it("uses followUp delivery (never steer) while the agent is busy", async () => {
		const { pi, handlers } = makePi();
		const sendUserMessage = vi.fn();
		(pi as any).sendUserMessage = sendUserMessage;
		const run = vi.fn(async (_args: Record<string, unknown>, _ctx: unknown) => ({ details: { prompt: "FULL PROMPT TEXT" } }));
		registerSlashCommands(pi, { run, alreadyRegistered: new Set() });
		await handlers.learn("", { isIdle: () => false });
		expect(sendUserMessage).toHaveBeenCalledWith("FULL PROMPT TEXT", { deliverAs: "followUp" });
	});

	it("conservatively uses followUp when ctx.isIdle is unavailable, never assuming idle", async () => {
		const { pi, handlers } = makePi();
		const sendUserMessage = vi.fn();
		(pi as any).sendUserMessage = sendUserMessage;
		const run = vi.fn(async (_args: Record<string, unknown>, _ctx: unknown) => ({ details: { prompt: "FULL PROMPT TEXT" } }));
		registerSlashCommands(pi, { run, alreadyRegistered: new Set() });
		await handlers.learn("", {});
		expect(sendUserMessage).toHaveBeenCalledWith("FULL PROMPT TEXT", { deliverAs: "followUp" });
	});

	it("falls back to sendMessage with {triggerTurn:true} carrying the FULL prompt when sendUserMessage is unavailable", async () => {
		const { pi, handlers, sendMessage } = makePi(); // default makePi has no sendUserMessage
		const run = vi.fn(async (_args: Record<string, unknown>, _ctx: unknown) => ({ details: { prompt: "FULL PROMPT TEXT" } }));
		registerSlashCommands(pi, { run, alreadyRegistered: new Set() });
		await handlers.learn("", { isIdle: () => true });
		expect(sendMessage).toHaveBeenCalledTimes(2);
		const promptCall = sendMessage.mock.calls.find((c) => (c[0] as any).content === "FULL PROMPT TEXT");
		expect(promptCall).toBeDefined();
		expect(promptCall![1]).toMatchObject({ triggerTurn: true });
		expect((promptCall![0] as any).display).toBe(false);
	});

	it("reports NOT queued via ctx.ui.notify when the host has no prompt-delivery API at all (never a silent no-op)", async () => {
		const handlers: Record<string, (args: string, ctx: unknown) => unknown> = {};
		const bare = { registerCommand: (n: string, o: any) => { handlers[n] = o.handler; } };
		const run = vi.fn(async (_args: Record<string, unknown>, _ctx: unknown) => ({ details: { prompt: "FULL PROMPT TEXT" } }));
		registerSlashCommands(bare as any, { run, alreadyRegistered: new Set() });
		const notify = vi.fn();
		await handlers.learn("", { ui: { notify }, isIdle: () => true });
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/not queued|unavailable/i), "error");
	});

	it("reports an honest error and queues no turn when distill fails", async () => {
		const { pi, handlers, sendMessage } = makePi();
		const sendUserMessage = vi.fn();
		(pi as any).sendUserMessage = sendUserMessage;
		const run = vi.fn(async (_args: Record<string, unknown>, _ctx: unknown) => ({ error: "boom" }));
		registerSlashCommands(pi, { run, alreadyRegistered: new Set() });
		await handlers.learn("x", { isIdle: () => true });
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect((sendMessage.mock.calls[0][0] as any).content).toMatch(/could not start \/learn/i);
	});

	it("reports an honest error when distill returns no usable prompt, queuing no turn", async () => {
		const { pi, handlers, sendMessage } = makePi();
		const sendUserMessage = vi.fn();
		(pi as any).sendUserMessage = sendUserMessage;
		const run = vi.fn(async (_args: Record<string, unknown>, _ctx: unknown) => ({ details: {} }));
		registerSlashCommands(pi, { run, alreadyRegistered: new Set() });
		await handlers.learn("x", { isIdle: () => true });
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect((sendMessage.mock.calls[0][0] as any).content).toMatch(/could not start \/learn/i);
	});

	// F5 (organism-review.md): every case above manufactures `{details:{prompt:...}}`
	// directly, so the REAL contract `skillAction(op:"distill") \u21d2 details.prompt`
	// that `handleLearn` actually depends on is asserted nowhere \u2014 renaming or
	// dropping `details.prompt` in actions.ts would leave this whole suite green.
	// Promoted from organism-review-probe/a-config-skill-learn.probe.test.ts (PROBE G5b).
	// Verified non-vacuous by mutation (production already passes; see
	// organism-fix-report.md for the mutation log): renaming actions.ts's returned
	// `{ prompt }` field makes this test fail.
	it("wires the REAL skillAction(op:distill) as `run`, so details.prompt really is buildLearnPrompt(note) and is delivered verbatim exactly once (F5)", async () => {
		const scratch = resolve(".spider/scratch/slash-learn-real-distill");
		mkdirSync(scratch, { recursive: true });
		const dir = mkdtempSync(join(scratch, "case-"));
		let db: Db | undefined;
		try {
			db = openDbAt(join(dir, "repo.db"), "repo");
			const deps: OrganismActionDeps = { db, globalDb: db, project: { projectKey: dir, realPath: dir, dbPath: join(dir, "repo.db") } as any, worker: {} as any };
			const { pi, handlers, sendMessage } = makePi();
			const sendUserMessage = vi.fn();
			(pi as any).sendUserMessage = sendUserMessage;
			// `run` is the REAL dispatch shape: it routes the forwarded args into the REAL skillAction.
			const run = vi.fn(async (args: Record<string, unknown>) => {
				expect(args).toMatchObject({ action: "skill", op: "distill" });
				return skillAction(deps, args as any);
			});
			registerSlashCommands(pi, { run, alreadyRegistered: new Set() });
			await handlers.learn("release steps", { isIdle: () => true });

			const real = buildLearnPrompt("release steps");
			expect(sendUserMessage).toHaveBeenCalledTimes(1);
			expect(sendUserMessage.mock.calls[0][0]).toBe(real); // the FULL real prompt, verbatim
			expect(sendUserMessage.mock.calls[0][1]).toBeUndefined(); // idle => no followUp
			// The confirmation card must NOT duplicate the prompt into model-facing content.
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect((sendMessage.mock.calls[0][0] as any).content).not.toContain(real);
			expect((sendMessage.mock.calls[0][0] as any).content).toContain("release steps");
		} finally {
			db?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
