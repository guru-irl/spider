// Ported test cases from https://github.com/michael-denyer/pstack-claude,
// tests/pi/interaction.test.mjs at 046341e. MIT licensed.
// Copyright (c) 2026 Lauren Tan
// Copyright (c) 2026 Michael Denyer
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./harness";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T12:00:00Z")); vi.stubEnv("PI_SUBAGENT_CHILD", "0"); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("spider loop and /loop", () => {
  it("a fixed interval runs now and on every interval until stopped", async () => {
    const h = setup();
    await h.runtime.loop({ interval: "5m", prompt: "check deploy" }, h.ctx);
    expect(h.prompts()).toEqual(["check deploy"]);
    vi.advanceTimersByTime(600_000);
    expect(h.prompts()).toEqual(["check deploy", "check deploy", "check deploy"]);
    expect((await h.runtime.loop({ stop: true }, h.ctx)).details).toMatchObject({ stopped: true });
    vi.advanceTimersByTime(3_600_000);
    expect(h.prompts()).toHaveLength(3);
  });

  it.each(["0s", "10s", "1m"])("raises interval %s to one minute", async interval => {
    const h = setup();
    await h.runtime.loop({ interval, prompt: "poll external work" }, h.ctx);
    vi.advanceTimersByTime(59_999);
    expect(h.prompts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.prompts()).toHaveLength(2);
  });

  it("supports the 24-day maximum without timer overflow", async () => {
    const h = setup();
    await h.runtime.loop({ interval: "24d", prompt: "long timer" }, h.ctx);
    vi.advanceTimersByTime(2_073_599_999);
    expect(h.prompts()).toEqual(["long timer"]);
    vi.advanceTimersByTime(1);
    expect(h.prompts()).toEqual(["long timer", "long timer"]);
  });

  it("drops ticks while busy rather than queueing a backlog", async () => {
    const h = setup();
    await h.runtime.loop({ interval: "1m", prompt: "tick" }, h.ctx);
    h.setIdle(false); await h.emit("agent_start");
    vi.advanceTimersByTime(600_000);
    expect(h.prompts()).toEqual(["tick"]);
    h.setIdle(true); await h.emit("agent_settled");
    vi.advanceTimersByTime(0);
    expect(h.prompts()).toEqual(["tick", expect.stringContaining("tick\n")]);
    expect(h.prompts()[1]).toContain("2026-10-20T12:01:00.000Z UTC");
    await h.settleDelivery();
    vi.advanceTimersByTime(59_999);
    expect(h.prompts()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(h.prompts()).toEqual(["tick", expect.stringContaining("tick\n"), "tick"]);
  });

  it("self-paced mode runs once, asks for spider schedule and has no automatic timer", async () => {
    const h = setup();
    await h.runtime.loop({ prompt: "watch PR 42" }, h.ctx);
    expect(h.prompts()).toHaveLength(1);
    expect(h.prompts()[0]).toContain("watch PR 42\n");
    expect(h.prompts()[0]).toContain("spider schedule");
    expect(h.prompts()[0]).toContain('"/loop watch PR 42"');
    vi.advanceTimersByTime(86_400_000);
    expect(h.prompts()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a self-paced loop can re-arm and a replacement cancels the old wakeup", async () => {
    const h = setup();
    await h.runtime.loop({ prompt: "watch old" }, h.ctx);
    await h.settleDelivery();
    await h.runtime.schedule({ name: "loop", delaySeconds: 60, prompt: "/loop watch old" }, h.ctx);
    await h.runtime.loop({ prompt: "watch new" }, h.ctx);
    await h.settleDelivery();
    vi.advanceTimersByTime(60_000);
    expect(h.prompts()).toHaveLength(2);
    await h.runtime.schedule({ name: "loop", delaySeconds: 120, prompt: "/loop watch new" }, h.ctx);
    vi.advanceTimersByTime(120_000);
    expect(h.prompts()).toEqual([expect.stringContaining("watch old\n"), expect.stringContaining("watch new\n"), expect.stringContaining("watch new\n")]);
  });

  it.each(["/loop watch PR 42", "watch PR 42", "/loop 5m watch PR 42"])("stop during a run refuses every re-arm including %s", async prompt => {
    const h = setup();
    await h.runtime.loop({ prompt: "watch PR 42" }, h.ctx);
    h.setIdle(false); await h.emit("agent_start");
    await h.runtime.loop({ stop: true }, h.ctx);
    await expect(h.runtime.schedule({ name: "loop", delaySeconds: 60, prompt }, h.ctx)).rejects.toThrow(/a loop was ended or replaced during this run/i);
    expect(h.notifications.at(-1)).toMatchObject({ text: expect.stringContaining("was not scheduled"), level: "warning" });
    h.setIdle(true); vi.advanceTimersByTime(3_600_000);
    expect(h.prompts()).toHaveLength(1);
  });

  it("stop seals even with no live loop, until agent_settled (not agent_end)", async () => {
    const h = setup(); h.setIdle(false); await h.emit("agent_start");
    expect((await h.runtime.loop({ stop: true }, h.ctx)).details).toEqual({ stopped: false });
    await h.emit("agent_end");
    await expect(h.runtime.schedule({ name: "loop", delaySeconds: 60, prompt: "later" }, h.ctx)).rejects.toThrow(/a loop was ended or replaced during this run/i);
    h.setIdle(true); await h.emit("agent_settled");
    await h.runtime.schedule({ name: "loop", delaySeconds: 60, prompt: "later" }, h.ctx);
    vi.advanceTimersByTime(60_000);
    expect(h.prompts()).toEqual(["later"]);
  });

  it("replacement during a run protects its first prompt from the old run's re-arm and cancel", async () => {
    const h = setup();
    await h.slash("watch old");
    h.setIdle(false); await h.emit("agent_start");
    await h.slash("watch new");
    await expect(h.runtime.schedule({ name: "loop", delaySeconds: 60, prompt: "old" }, h.ctx)).rejects.toThrow(/a loop was ended or replaced during this run/i);
    expect((await h.runtime.schedule({ name: "loop", stop: true }, h.ctx)).details).toEqual({ cancelled: false });
    vi.advanceTimersByTime(60_000);
    expect(h.prompts()).toHaveLength(1);
    h.setIdle(true); await h.emit("agent_settled");
    vi.advanceTimersByTime(1000);
    expect(h.prompts()).toHaveLength(2);
    expect(h.prompts()[1]).toContain("watch new\n");
    h.setIdle(false); await h.emit("agent_start");
    await h.runtime.schedule({ name: "loop", delaySeconds: 120, prompt: "/loop watch new" }, h.ctx);
    h.setIdle(true); await h.emit("agent_settled");
    vi.advanceTimersByTime(120_000);
    expect(h.prompts().at(-1)).toContain("watch new\n");
  });

  it.each([false, true])("a first fixed prompt waits for idle with live run=%s", async running => {
    const h = setup(); h.setIdle(false);
    if (running) await h.emit("agent_start");
    await h.runtime.loop({ interval: "5m", prompt: "check deploy" }, h.ctx);
    vi.advanceTimersByTime(30_000);
    expect(h.prompts()).toEqual([]);
    h.setIdle(true);
    if (running) await h.emit("agent_settled");
    vi.advanceTimersByTime(1000);
    expect(h.prompts()).toEqual(["check deploy"]);
  });

  it("manual compaction does not seal a self-paced start or a stop against the next run", async () => {
    const h = setup(); h.setIdle(false);
    await h.slash("stop");
    await h.slash("watch deploy");
    h.setIdle(true); vi.advanceTimersByTime(1000);
    expect(h.prompts()).toEqual([expect.stringContaining("watch deploy\n")]);
    h.setIdle(false); await h.emit("agent_start");
    expect((await h.runtime.schedule({ name: "loop", delaySeconds: 60, prompt: "/loop watch deploy" }, h.ctx)).details).not.toHaveProperty("refused");
  });

  it("refuses a slash re-arm without a matching active self-paced loop", async () => {
    const h = setup(); h.setIdle(false); await h.emit("agent_start");
    await expect(h.runtime.schedule({ name: "loop", delaySeconds: 60, prompt: "/loop Watch PR 42." }, h.ctx)).rejects.toThrow(/slash commands are user-only/i);
    h.setIdle(true); await h.emit("agent_settled");
    vi.advanceTimersByTime(60_000);
    expect(h.prompts()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replacing fixed with dynamic and dynamic with fixed removes the old timers", async () => {
    const h = setup();
    await h.slash("1m old task");
    await h.settleDelivery();
    await h.slash("new task");
    await h.settleDelivery();
    await h.runtime.schedule({ name: "loop", delaySeconds: 60, prompt: "/loop new task" }, h.ctx);
    await h.slash("2m newest task");
    await h.settleDelivery();
    vi.advanceTimersByTime(120_000);
    expect(h.prompts()).toEqual(["old task", expect.stringContaining("new task\n"), "newest task", "newest task"]);
  });

  it("tool loop stop leaves an independent wakeup intact", async () => {
    const h = setup();
    await h.runtime.schedule({ delaySeconds: 120, prompt: "cancel me" }, h.ctx);
    await h.runtime.loop({ stop: true }, h.ctx);
    vi.advanceTimersByTime(3_600_000);
    expect(h.prompts()).toEqual(["cancel me"]);
  });

  it.each(["quit", "reload", "new", "resume", "fork"])("shutdown reason %s ends both timers", async reason => {
    const h = setup();
    await h.slash("1m tick");
    await h.runtime.schedule({ delaySeconds: 120, prompt: "wake" }, h.ctx);
    await h.emit("session_shutdown", { reason });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3_600_000);
    expect(h.prompts()).toEqual(["tick"]);
    expect((await h.runtime.loop({}, h.ctx)).details).toEqual({ triggers: [] });
  });

  it("shutdown clears a self-paced iteration and its seal", async () => {
    const h = setup();
    await h.slash("watch");
    h.setIdle(false); await h.emit("agent_start");
    await h.slash("stop");
    await h.emit("session_shutdown", { reason: "reload" });
    h.setIdle(true);
    expect((await h.runtime.loop({}, h.ctx)).details).toEqual({ triggers: [] });
    expect((await h.runtime.schedule({ delaySeconds: 60, prompt: "next session" }, h.ctx)).details).not.toHaveProperty("refused");
  });

  it("reports loop interval, next cadence time, prompt and a separate pending wakeup", async () => {
    const h = setup();
    expect((await h.runtime.loop({}, h.ctx)).details).toEqual({ triggers: [] });
    await h.runtime.loop({ interval: "5m", prompt: "check deploy" }, h.ctx);
    await h.runtime.schedule({ delaySeconds: 120, prompt: "check CI", reason: "CI ETA", noop: true }, h.ctx);
    expect((await h.runtime.loop({}, h.ctx)).details).toEqual({ triggers: [
      expect.objectContaining({ name: "loop", kind: "interval", interval: "5m", intervalSeconds: 300, nextAt: Date.parse("2026-10-20T12:05:00Z"), nextAtUtc: "2026-10-20T12:05:00.000Z", tz: "Test/Zone", origin: "model", prompt: "check deploy" }),
      expect.objectContaining({ name: "wakeup", kind: "once", delaySeconds: 120, nextAt: Date.parse("2026-10-20T12:02:00Z"), nextAtUtc: "2026-10-20T12:02:00.000Z", tz: "Test/Zone", origin: "model", prompt: "check CI", reason: "CI ETA", noop: true }),
    ] });
    h.setIdle(false); vi.advanceTimersByTime(300_000);
    expect((await h.runtime.loop({}, h.ctx)).details).toMatchObject({ triggers: [expect.objectContaining({ name: "loop", nextAt: Date.parse("2026-10-20T12:05:00Z"), state: "due" }), expect.objectContaining({ name: "wakeup", prompt: "check CI" })] });
    h.setIdle(true); vi.advanceTimersByTime(1000);
    expect((await h.runtime.loop({}, h.ctx)).details).toMatchObject({ triggers: [expect.objectContaining({ name: "loop" })] });
  });

  it("reports a self-paced loop even while it has no re-arm timer", async () => {
    const h = setup();
    await h.runtime.loop({ prompt: "watch CI" }, h.ctx);
    const state = await h.runtime.loop({}, h.ctx);
    expect(state.details).toEqual({ triggers: [expect.objectContaining({ name: "loop", kind: "self-paced", prompt: "watch CI", nextAt: null, state: "waiting-for-rearm" })] });
    expect(state.text).toContain("self-paced");
    expect(state.text).toContain("watch CI");
  });

  it("slash grammar shares scheduler state and stop with tool actions", async () => {
    const h = setup();
    await h.slash("5m check CI");
    expect((await h.runtime.loop({}, h.ctx)).details).toMatchObject({ triggers: [expect.objectContaining({ name: "loop", kind: "interval", intervalSeconds: 300, prompt: "check CI" })] });
    await h.runtime.loop({ stop: true }, h.ctx);
    vi.advanceTimersByTime(600_000);
    expect(h.prompts()).toEqual(["check CI"]);
    await h.runtime.loop({ prompt: "check deploy" }, h.ctx);
    await h.slash("stop");
    expect((await h.runtime.loop({}, h.ctx)).details).toEqual({ triggers: [] });
  });

  it("usage and invalid slash intervals leave the current loop unchanged", async () => {
    const h = setup();
    await h.slash("5m current");
    for (const args of ["", "5m", "25d bad"]) await h.slash(args);
    expect(h.notifications.at(-3)!.text.indexOf("current")).toBeLessThan(h.notifications.at(-3)!.text.indexOf("Usage"));
    expect(h.notifications.slice(-3).map(n => n.text)).toEqual([expect.stringContaining("Usage"), expect.stringContaining("Usage"), expect.stringContaining("24 days")]);
    vi.advanceTimersByTime(300_000);
    expect(h.prompts()).toEqual(["current", "current"]);
  });

  it.each([undefined, "", " \n\t"])("an interval without a prompt (%j) errors and preserves the active loop", async prompt => {
    const h = setup(); await h.slash("1m current");
    await expect(h.runtime.loop({ interval: "5m", prompt }, h.ctx)).rejects.toThrow(/prompt is required/i);
    vi.advanceTimersByTime(60_000);
    expect(h.prompts()).toEqual(["current", "current"]);
  });

  it.each(["25d", "nope", "5M", "1.5m"])("invalid tool interval %s preserves the active loop", async interval => {
    const h = setup(); await h.slash("1m current");
    await expect(h.runtime.loop({ interval, prompt: "invalid" }, h.ctx)).rejects.toThrow(/interval|24 days/i);
    vi.advanceTimersByTime(60_000);
    expect(h.prompts()).toEqual(["current", "current"]);
  });

  it.each(["print", "json"] as const)("both tool and slash refuse %s without firing", async mode => {
    const h = setup(); h.ctx.mode = mode;
    for (const args of [{ prompt: "watch" }, { interval: "1m", prompt: "watch" }, { stop: true }, {}]) {
      await expect(h.runtime.loop(args, h.ctx)).rejects.toThrow(/exits when this run ends/);
    }
    await expect(h.slash("watch")).rejects.toThrow(/exits when this run ends/);
    expect(h.prompts()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("both tool and slash refuse child sessions", async () => {
    const h = setup(); vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    await expect(h.runtime.loop({ interval: "1m", prompt: "watch" }, h.ctx)).rejects.toThrow(/subagent child/);
    await expect(h.slash("watch")).rejects.toThrow(/subagent child/);
    expect(h.prompts()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("each extension activation has independent timers and shutdown", async () => {
    const a = setup(), b = setup();
    await a.slash("1m A"); await b.slash("1m B");
    await a.emit("session_shutdown", { reason: "reload" });
    vi.advanceTimersByTime(60_000);
    expect(a.prompts()).toEqual(["A"]);
    expect(b.prompts()).toEqual(["B", "B"]);
  });
});
