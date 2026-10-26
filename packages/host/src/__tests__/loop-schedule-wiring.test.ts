import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import spiderExtension, { SPIDER_PARAMETERS } from "../extension";
import { clearActions } from "../dispatch";
import { fakeTime } from "../loop/__tests__/harness";

vi.mock("../loop/time-math", () => ({ createTimeMath: () => {
  const time = fakeTime();
  time.occurrences.set("0 8 * * *", [Date.parse("2026-10-20T12:03:00Z"), Date.parse("2026-10-21T12:03:00Z")]);
  return time;
} }));

const scratch = resolve(".spider/scratch/loop-schedule", `wiring-${process.pid}`);
function host() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const hooks = new Map<string, Function[]>();
  const messages: { prompt: string; options: unknown }[] = [];
  const entries: unknown[] = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
    registerCommand: (name: string, def: unknown) => { commands.set(name, def); },
    on: (name: string, handler: Function) => { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    sendUserMessage: (prompt: string, options: unknown) => { messages.push({ prompt, options }); },
  };
  spiderExtension(pi);
  const ctx = { cwd: scratch, mode: "tui", isIdle: () => true, ui: { notify() {} }, sessionManager: { getEntries: () => entries, getSessionId: () => "host-test-session" } };
  return {
    ctx, messages, commands, entries,
    run: (args: Record<string, unknown>) => tools.get("spider").execute("timer-action", args, undefined, undefined, ctx),
    emit: async (name: string) => { for (const handler of hooks.get(name) ?? []) await handler({}, ctx); },
    tool: tools.get("spider"),
  };
}

beforeEach(() => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  mkdirSync(scratch, { recursive: true });
  execFileSync("git", ["init", "-q", scratch]);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
});
afterEach(() => {
  clearActions(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe("host loop and schedule wiring", () => {
  it("exposes both actions and their optional parameters on the single spider tool", () => {
    const h = host();
    expect(h.tool.parameters).toBe(SPIDER_PARAMETERS);
    expect(SPIDER_PARAMETERS.properties.action.enum).toEqual(expect.arrayContaining(["loop", "schedule"]));
    for (const [name, type] of Object.entries({ name: "string", at: "string", cron: "string", tz: "string", interval: "string", delaySeconds: "number", prompt: "string", reason: "string", noop: "boolean", stop: "boolean" })) {
      expect((SPIDER_PARAMETERS.properties as any)[name]).toMatchObject({ type });
    }
    for (const field of ["name", "at", "cron", "tz"]) expect(SPIDER_PARAMETERS.required).not.toContain(field);
    expect(SPIDER_PARAMETERS.properties.name.description).toMatch(/trigger/i);
    expect(SPIDER_PARAMETERS.properties.tz.description).toMatch(/cron.*zone|zone.*cron/i);
    expect(SPIDER_PARAMETERS.properties.prompt.description).toMatch(/name.*re-arm|re-arm.*name/i);
    expect(h.tool.description).toMatch(/independent names/i);
    expect(h.tool.description).toMatch(/reload.*resume/i);
    expect(h.tool.description).toMatch(/external work/);
    expect(h.tool.description).toMatch(/not for polling subagents/i);
  });

  it("routes a wakeup through the tool without opening any project database", async () => {
    const h = host();
    const result = await h.run({ action: "schedule", delaySeconds: 5, prompt: "check CI", noop: true });
    expect(result.details).toMatchObject({ delaySeconds: 60, noop: true });
    expect(result.content[0].text).toContain("Wakeup scheduled");
    vi.advanceTimersByTime(60_000);
    expect(h.messages).toEqual([{ prompt: "check CI", options: { deliverAs: "followUp", expandPromptTemplates: false } }]);
    expect(existsSync(resolve(scratch, ".spider", "project.db"))).toBe(false);
  });

  it("routes named cron and absolute schedules without opening a project database", async () => {
    const h = host();
    await h.run({ action: "loop", name: "morning", cron: "0 8 * * *", tz: "Asia/Kolkata", prompt: "daily" });
    await h.run({ action: "schedule", name: "once", at: "2026-10-20T12:01:00Z", prompt: "absolute" });
    expect((await h.run({ action: "loop" })).details).toMatchObject({ triggers: [
      expect.objectContaining({ name: "morning", kind: "cron", cron: "0 8 * * *", tz: "Asia/Kolkata" }),
      expect.objectContaining({ name: "once", kind: "once", at: "2026-10-20T12:01:00Z", nextAt: Date.parse("2026-10-20T12:01:00Z") }),
    ] });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.messages.map(m => m.prompt)).toEqual(["absolute"]);
    expect(existsSync(resolve(scratch, ".spider", "project.db"))).toBe(false);
  });

  it("shares one scheduler between tool actions and /loop", async () => {
    const h = host();
    await h.commands.get("loop").handler("5m check deploy", h.ctx);
    const state = await h.run({ action: "loop" });
    expect(state.details).toMatchObject({ triggers: [expect.objectContaining({ name: "loop", kind: "interval", intervalSeconds: 300, prompt: "check deploy" })] });
    expect(state.content[0].text).toContain("check deploy");
    await h.run({ action: "loop", stop: true });
    vi.advanceTimersByTime(600_000);
    expect(h.messages.map(m => m.prompt)).toEqual(["check deploy"]);
    await h.run({ action: "loop", prompt: "watch CI" });
    await h.commands.get("loop").handler("stop", h.ctx);
    expect((await h.run({ action: "loop" })).details).toEqual({ triggers: [] });
  });

  it("threads agent events to sealing for tool-started loops", async () => {
    const h = host();
    await h.run({ action: "loop", prompt: "watch CI" });
    await h.emit("agent_start");
    await h.commands.get("loop").handler("stop", h.ctx);
    await expect(h.run({ action: "schedule", name: "loop", delaySeconds: 60, prompt: "re-arm old loop" })).rejects.toThrow(/a loop was ended or replaced during this run/i);
    await h.emit("agent_settled");
    expect((await h.run({ action: "schedule", delaySeconds: 60, prompt: "new timer" })).details).toMatchObject({ delaySeconds: 60 });
  });

  it.each(["loop", "schedule"])("refuses %s in children before any project DB work", async action => {
    const h = host(); vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    await expect(h.run({ action, interval: "1m", prompt: "watch", delaySeconds: 60 })).rejects.toThrow(/subagent child/);
    expect(existsSync(resolve(scratch, ".spider", "project.db"))).toBe(false);
  });

  it.each(["print", "json"])("refuses both actions in %s runs", async mode => {
    const h = host(); h.ctx.mode = mode;
    for (const action of ["loop", "schedule"]) {
      await expect(h.run({ action, prompt: "watch", delaySeconds: 60 })).rejects.toThrow(/exits when this run ends/);
    }
    expect(h.messages).toEqual([]);
  });

  it("separate host activations never borrow each other's scheduler", async () => {
    const a = host(), b = host();
    await a.run({ action: "schedule", delaySeconds: 60, prompt: "A" });
    await b.run({ action: "schedule", delaySeconds: 60, prompt: "B" });
    await a.run({ action: "schedule", stop: true });
    vi.advanceTimersByTime(60_000);
    expect(a.messages).toEqual([]);
    expect(b.messages.map(m => m.prompt)).toEqual(["B"]);
  });
});
