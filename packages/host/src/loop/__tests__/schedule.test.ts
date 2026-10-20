// Ported test cases from https://github.com/michael-denyer/pstack-claude,
// tests/pi/interaction.test.mjs at 046341e. MIT licensed.
// Copyright (c) 2026 Lauren Tan
// Copyright (c) 2026 Michael Denyer
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./harness";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T12:00:00Z")); vi.stubEnv("PI_SUBAGENT_CHILD", "0"); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("spider schedule", () => {
  it.each([[5, 60], [-20, 60], [60.4, 60], [60.5, 61], [600, 600], [99999, 3600]])("clamps and rounds %s to %s seconds and delivers once", async (delay, seconds) => {
    const h = setup();
    const result = await h.runtime.schedule({ delaySeconds: delay, prompt: "check CI", reason: "external build" }, h.ctx);
    expect(result.details).toMatchObject({ delaySeconds: seconds, noop: false });
    vi.advanceTimersByTime(seconds * 1000 - 1);
    expect(h.prompts()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.messages).toEqual([{ prompt: "check CI", options: { deliverAs: "followUp", expandPromptTemplates: false } }]);
    vi.advanceTimersByTime(3_600_000);
    expect(h.prompts()).toEqual(["check CI"]);
  });

  it("a due wakeup waits through manual compaction and fires after idle without a settled event", async () => {
    const h = setup(); h.setIdle(false);
    await h.runtime.schedule({ delaySeconds: 60, prompt: "after compaction" }, h.ctx);
    vi.advanceTimersByTime(65_000);
    expect(h.prompts()).toEqual([]);
    h.setIdle(true);
    vi.advanceTimersByTime(1000);
    expect(h.prompts()).toEqual(["after compaction"]);
    vi.advanceTimersByTime(60_000);
    expect(h.prompts()).toEqual(["after compaction"]);
  });

  it.each(["cancel", "replace", "shutdown"])("can %s a due wakeup still waiting for idle", async action => {
    const h = setup(); h.setIdle(false);
    await h.runtime.schedule({ delaySeconds: 60, prompt: "old" }, h.ctx);
    vi.advanceTimersByTime(60_000);
    if (action === "cancel") expect((await h.runtime.schedule({ stop: true }, h.ctx)).details).toEqual({ cancelled: true });
    if (action === "replace") await h.runtime.schedule({ delaySeconds: 60, prompt: "new" }, h.ctx);
    if (action === "shutdown") await h.emit("session_shutdown", { reason: "reload" });
    h.setIdle(true);
    vi.advanceTimersByTime(120_000);
    expect(h.prompts()).toEqual(action === "replace" ? ["new"] : []);
  });

  it("reports an internal re-arm rejection through the UI instead of leaving it unhandled", async () => {
    const h = setup();
    await h.runtime.loop({ prompt: "watch CI" }, h.ctx);
    await h.runtime.schedule({ delaySeconds: 60, prompt: "/loop watch CI" }, h.ctx);
    // A real command rejection after scheduling, without replacing command().
    h.ctx.mode = "print";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.notifications).toEqual([{
      text: expect.stringContaining("spider loop cannot fire in a print run"), level: "error",
    }]);
    expect(h.prompts()).toHaveLength(1);
  });

  it("explains that a sealed replacement wakeup was not cancelled and still delivers it", async () => {
    const h = setup();
    h.setIdle(false);
    await h.emit("agent_start");
    await h.slash("watch replacement");
    const result = await h.runtime.schedule({ stop: true }, h.ctx);
    expect(result.details).toEqual({ cancelled: false });
    expect(result.text).toBe("The pending wakeup belongs to a loop started during this run and was not cancelled.");
    expect((await h.runtime.loop({}, h.ctx)).details.wakeup).toMatchObject({
      prompt: expect.stringContaining("watch replacement"),
    });
    h.setIdle(true);
    await h.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.prompts()).toEqual([expect.stringContaining("watch replacement\n")]);
  });

  it("a new call replaces the pending wakeup and noop still delivers", async () => {
    const h = setup();
    await h.runtime.schedule({ delaySeconds: 600, prompt: "old" }, h.ctx);
    expect((await h.runtime.schedule({ delaySeconds: 120, prompt: "routine", noop: true }, h.ctx)).details).toMatchObject({ noop: true });
    vi.advanceTimersByTime(3_600_000);
    expect(h.prompts()).toEqual(["routine"]);
  });

  it("stop needs no other field and reports whether it cancelled anything", async () => {
    const h = setup();
    expect((await h.runtime.schedule({ stop: true }, h.ctx)).details).toEqual({ cancelled: false });
    await h.runtime.schedule({ delaySeconds: 120, prompt: "cancelled" }, h.ctx);
    expect((await h.runtime.schedule({ stop: true }, h.ctx)).details).toEqual({ cancelled: true });
    vi.advanceTimersByTime(3_600_000);
    expect(h.prompts()).toEqual([]);
  });

  it.each([{}, { delaySeconds: 60 }, { prompt: "check" }, { delaySeconds: 60, prompt: "" }, { delaySeconds: NaN, prompt: "check" }, { delaySeconds: Infinity, prompt: "check" }])("refuses incomplete or non-finite input %j without a timer", async args => {
    const h = setup();
    await expect(h.runtime.schedule(args, h.ctx)).rejects.toThrow(/delaySeconds.*prompt|finite/i);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["print", "json"] as const)("refuses even cancellation in %s mode", async mode => {
    const h = setup(); h.ctx.mode = mode;
    for (const args of [{ delaySeconds: 60, prompt: "later" }, { stop: true }]) {
      await expect(h.runtime.schedule(args, h.ctx)).rejects.toThrow(/exits when this run ends/);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses a subagent child with a clear error", async () => {
    const h = setup(); vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    await expect(h.runtime.schedule({ delaySeconds: 60, prompt: "later" }, h.ctx)).rejects.toThrow(/subagent child/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("permits long-lived top-level RPC sessions", async () => {
    const h = setup(); h.ctx.mode = "rpc";
    await h.runtime.schedule({ delaySeconds: 60, prompt: "external timer" }, h.ctx);
    vi.advanceTimersByTime(60_000);
    expect(h.prompts()).toEqual(["external timer"]);
  });
});
