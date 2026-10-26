import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeTime, setup } from "./harness";

const NOW = Date.parse("2026-10-20T12:00:00Z");
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); vi.stubEnv("PI_SUBAGENT_CHILD", "0"); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("named trigger definitions", () => {
  it("validates names and preserves case-sensitive independence", async () => {
    const h = setup();
    for (const name of ["a", "A", "a".repeat(40), "a._-9"]) await h.runtime.schedule({ name, delaySeconds: 60, prompt: name }, h.ctx);
    const before = await h.runtime.loop({}, h.ctx);
    expect(before.details.triggers).toHaveLength(4);
    for (const name of ["a".repeat(41), ".a", "-a", "_a", "a b", ""]) {
      await expect(h.runtime.schedule({ name, delaySeconds: 60, prompt: "bad" }, h.ctx)).rejects.toThrow(/name/i);
      expect(await h.runtime.loop({}, h.ctx)).toEqual(before);
    }
  });

  it("limits new names to twenty but validates replacements atomically", async () => {
    const h = setup();
    for (let i = 0; i < 20; i++) await h.runtime.schedule({ name: `n${i}`, delaySeconds: 60, prompt: "old" }, h.ctx);
    const before = await h.runtime.loop({}, h.ctx);
    await expect(h.runtime.schedule({ name: "new", delaySeconds: 60, prompt: "new" }, h.ctx)).rejects.toThrow(/20/);
    await expect(h.runtime.schedule({ name: "n0", at: "past", prompt: "bad" }, h.ctx)).rejects.toThrow();
    expect(await h.runtime.loop({}, h.ctx)).toEqual(before);
    await h.runtime.schedule({ name: "n0", delaySeconds: 120, prompt: "replacement" }, h.ctx);
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "n0", prompt: "replacement", nextAt: NOW + 120_000 })]));
  });

  it("validates argument combinations without mutating old state", async () => {
    const time = fakeTime(), h = setup(time);
    await h.runtime.schedule({ name: "old", delaySeconds: 60, prompt: "old" }, h.ctx);
    const before = await h.runtime.loop({}, h.ctx);
    for (const args of [
      { delaySeconds: 60, at: "2026-10-21T12:00Z", prompt: "bad" }, { prompt: "bad" },
      { at: "2026-10-19T12:00Z", prompt: "bad" }, { delaySeconds: 60, prompt: " \n" },
    ]) {
      await expect(h.runtime.schedule({ ...args, name: "old" }, h.ctx)).rejects.toThrow();
      expect(await h.runtime.loop({}, h.ctx)).toEqual(before);
    }
    for (const args of [
      { interval: "1m", cron: "0 8 * * *", prompt: "bad" }, { tz: "UTC", prompt: "bad" },
      { cron: "invalid", prompt: "bad" }, { prompt: " \n" }, { cron: "0 8 * * *", tz: "Bad/Zone", prompt: "bad" },
    ]) {
      await expect(h.runtime.loop({ ...args, name: "old" }, h.ctx)).rejects.toThrow();
      expect(await h.runtime.loop({}, h.ctx)).toEqual(before);
    }
    time.zone = "Changed/Zone";
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual([expect.objectContaining({ tz: "Test/Zone" })]);
  });

  it("ignores legacy cross-action fields and rejects new ones", async () => {
    const h = setup(); h.setIdle(false);
    await h.runtime.loop({ prompt: "loop", delaySeconds: 42, reason: "ignored", noop: true }, h.ctx);
    await h.runtime.schedule({ prompt: "once", delaySeconds: 60, interval: "ignored" }, h.ctx);
    for (const args of [{ at: "2026-10-21T00:00Z" }, { stop: true, at: "2026-10-21T00:00Z" }, { prompt: "loop", at: "2026-10-21T00:00Z" }]) {
      await expect(h.runtime.loop(args, h.ctx)).rejects.toThrow("spider loop does not accept at; use spider schedule");
    }
    for (const stop of [undefined, true]) {
      await expect(h.runtime.schedule({ stop, cron: "* * * * *" }, h.ctx)).rejects.toThrow("spider schedule does not accept cron; use spider loop");
      await expect(h.runtime.schedule({ stop, tz: "UTC" }, h.ctx)).rejects.toThrow("spider schedule does not accept tz; use spider loop with cron");
    }
    await expect(h.runtime.loop({ prompt: "/bad", at: "bad" }, h.ctx)).rejects.toThrow(/Slash commands are user-only/);
    await expect(h.runtime.schedule({ prompt: "/bad", cron: "bad" }, h.ctx)).rejects.toThrow(/Slash commands are user-only/);
    h.ctx.mode = "print";
    await expect(h.runtime.loop({ prompt: "/bad", at: "bad" }, h.ctx)).rejects.toThrow(/print run/);
    await expect(h.runtime.schedule({ prompt: "/bad", cron: "bad" }, h.ctx)).rejects.toThrow(/print run/);
  });

  it("formats the complete listing", async () => {
    const time = fakeTime(); time.occurrences.set("0 8 * * *", [NOW + 180_000]);
    const h = setup(time);
    expect(await h.runtime.loop({}, h.ctx)).toEqual({ text: "No triggers are active.", details: { triggers: [] } });
    await h.runtime.loop({ name: "z-self", prompt: "watch" }, h.ctx);
    await h.settleDelivery();
    await h.runtime.schedule({ name: "a-once", at: "2026-10-21T12:00Z", prompt: "x".repeat(90) + "\nsecond line" }, h.ctx);
    h.setIdle(false);
    await h.slash("1m user interval");
    await h.runtime.loop({ name: "cron", cron: "0 8 * * *", tz: "Asia/Kolkata", prompt: "daily" }, h.ctx);
    const result = await h.runtime.loop({}, h.ctx);
    expect(result.details.triggers).toEqual([
      expect.objectContaining({ name: "a-once", kind: "once", origin: "model", tz: "Test/Zone", state: "scheduled", prompt: "x".repeat(90) + "\nsecond line", nextAtUtc: "2026-10-21T12:00:00.000Z", nextAtLocal: "2026-10-21 12:00:00.000 Test/Zone" }),
      expect.objectContaining({ name: "cron", kind: "cron", cron: "0 8 * * *", tz: "Asia/Kolkata", state: "scheduled", nextAt: NOW + 180_000 }),
      expect.objectContaining({ name: "loop", kind: "interval", origin: "user", interval: "1m", intervalSeconds: 60, anchor: NOW, nextAt: NOW, state: "due" }),
      expect.objectContaining({ name: "z-self", kind: "self-paced", nextAt: null, state: "waiting-for-rearm", nextAtUtc: null, nextAtLocal: null }),
    ]);
    expect(result.text.split("\n")).toHaveLength(4);
    expect(result.text).toContain("x".repeat(80));
    expect(result.text).not.toContain("x".repeat(81));
    expect(result.text).toContain("due, waiting for idle");
    expect(result.text).toContain("waiting for re-arm");
    expect(result.text).toContain('cron "0 8 * * *" Asia/Kolkata');
  });
});


describe("ticker reconciliation", () => {
  it("uses one wall-clock ticker and preserves due work", async () => {
    const h = setup();
    await h.runtime.loop({ interval: "1m", prompt: "tick" }, h.ctx);
    expect(h.prompts()).toEqual(["tick"]);
    await h.settleDelivery();
    expect(vi.getTimerCount()).toBe(1);
    h.setIdle(false);
    vi.setSystemTime(NOW + 600_000);
    await vi.advanceTimersToNextTimerAsync();
    expect(h.prompts()).toEqual(["tick"]);
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual([expect.objectContaining({ nextAt: NOW + 60_000 })]);
    vi.setSystemTime(NOW + 610_000);
    h.setIdle(true); await h.emit("agent_settled"); await vi.advanceTimersByTimeAsync(0);
    expect(h.prompts()).toHaveLength(2);
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual([expect.objectContaining({ nextAt: NOW + 660_000 })]);
    await h.settleDelivery();
    vi.setSystemTime(NOW - 60_000); await vi.advanceTimersByTimeAsync(60_000);
    expect(h.prompts()).toHaveLength(2);
    await h.runtime.loop({ stop: true }, h.ctx);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("orders simultaneous due triggers without duplicate pending fires, equal=%s", async equal => {
    const h = setup();
    await h.runtime.schedule({ name: "b", delaySeconds: 60, prompt: "b" }, h.ctx);
    await h.runtime.schedule({ name: "a", delaySeconds: equal ? 60 : 120, prompt: "a" }, h.ctx);
    vi.setSystemTime(NOW + 180_000); await vi.advanceTimersToNextTimerAsync();
    expect(h.prompts()).toEqual([equal ? "a" : "b"]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.prompts()).toHaveLength(1);
    await h.emit("agent_start"); await h.emit("agent_end");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.prompts()).toHaveLength(1);
    await h.emit("agent_settled"); await vi.advanceTimersByTimeAsync(0);
    expect(h.prompts()).toEqual(equal ? ["a", "b"] : ["b", "a"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("opens a no-start gate at five seconds only when idle, busy=%s", async busy => {
    const h = setup();
    await h.runtime.schedule({ name: "a", delaySeconds: 60, prompt: "/handled-slash" }, h.ctx).catch(() => {});
    // User slash delivery exercises the same no-start fallback as ordinary prompts.
    await h.slash("1m /handled-slash");
    await h.runtime.schedule({ name: "b", delaySeconds: 60, prompt: "b" }, h.ctx);
    vi.setSystemTime(NOW + 60_000); await vi.advanceTimersToNextTimerAsync();
    const count = h.prompts().length;
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.prompts()).toHaveLength(count);
    h.setIdle(!busy);
    await vi.advanceTimersByTimeAsync(1);
    if (busy) {
      expect(h.prompts()).toHaveLength(count);
      h.setIdle(true); await vi.advanceTimersByTimeAsync(1000);
    }
    expect(h.prompts()).toHaveLength(count + 1);
  });

  it("an immediate first prompt waits behind a closed gate", async () => {
    const h = setup();
    await h.runtime.loop({ name: "first", prompt: "first" }, h.ctx);
    expect(h.prompts()).toHaveLength(1);
    await h.runtime.loop({ name: "second", prompt: "second" }, h.ctx);
    expect(h.prompts()).toHaveLength(1);
    await h.settleDelivery();
    expect(h.prompts()).toEqual([expect.stringContaining("first\n"), expect.stringContaining("second\n")]);
  });

  it.each(["once", "self-paced", "interval", "cron", "cron-failed", "interval-failed"])("consumes an occurrence whose delivery check fails and notifies once: %s", async kind => {
    const time = fakeTime(); time.occurrences.set("0 8 * * *", [NOW + 60_000, NOW + 120_000]);
    const h = setup(time); h.setIdle(false);
    if (kind === "once") await h.runtime.schedule({ delaySeconds: 60, prompt: "check" }, h.ctx);
    else await h.runtime.loop({ prompt: "check", ...(kind.startsWith("cron") ? { cron: "0 8 * * *" } : kind.startsWith("interval") ? { interval: "1m" } : {}) }, h.ctx);
    if (kind === "cron-failed") time.occurrences.set("0 8 * * *", []);
    if (kind === "interval-failed") vi.spyOn(Math, "floor").mockImplementationOnce(() => { throw new Error("Cannot advance interval"); });
    h.ctx.mode = "print"; h.setIdle(true);
    vi.setSystemTime(NOW + 60_000); await vi.advanceTimersToNextTimerAsync();
    expect(h.prompts()).toEqual([]);
    expect(h.notifications).toHaveLength(1);
    h.ctx.mode = "tui";
    const rows = (await h.runtime.loop({}, h.ctx)).details.triggers;
    if (kind === "once" || kind.endsWith("failed")) expect(rows).toEqual([]);
    else expect(rows).toEqual([expect.objectContaining({ nextAt: kind === "self-paced" ? null : NOW + 120_000 })]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.notifications).toHaveLength(1);
    expect(h.prompts()).toEqual([]);
    vi.restoreAllMocks();
  });

  it.each(["cron", "interval"])("delivers the current occurrence when only advancement fails: %s", async kind => {
    const time = fakeTime(); time.occurrences.set("0 8 * * *", [NOW + 60_000]);
    const h = setup(time); h.setIdle(false);
    await h.runtime.loop({ prompt: "last", ...(kind === "cron" ? { cron: "0 8 * * *" } : { interval: "1m" }) }, h.ctx);
    if (kind === "interval") vi.spyOn(Math, "floor").mockImplementationOnce(() => { throw new Error("Cannot advance interval"); });
    h.setIdle(true); vi.setSystemTime(NOW + 60_000); await vi.advanceTimersToNextTimerAsync();
    expect(h.prompts()).toEqual(["last"]);
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual([]);
    expect(h.notifications).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.notifications).toHaveLength(1); expect(h.prompts()).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("uses the latest activation context for fire-time checks", async () => {
    const h = setup();
    await h.runtime.schedule({ delaySeconds: 60, prompt: "old context" }, h.ctx);
    const latest = { ...h.ctx, mode: "print" as const };
    await expect(h.runtime.loop({}, latest)).rejects.toThrow();
    // Rejected calls must not replace the context of an eligible activation.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.prompts()).toEqual(["old context"]);
    await h.settleDelivery();
    await h.runtime.schedule({ delaySeconds: 60, prompt: "latest" }, h.ctx);
    const preStart = { ...h.ctx, isIdle: () => false };
    await h.runtime.loop({}, preStart);
    await vi.advanceTimersByTimeAsync(60_000); expect(h.prompts()).toHaveLength(1);
    await h.emit("session_start", { reason: "startup" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.prompts()).toEqual(["old context", "latest"]);
    await h.runtime.schedule({ delaySeconds: 60, prompt: "session context" }, preStart);
    await h.settleDelivery(); await vi.advanceTimersByTimeAsync(60_000);
    expect(h.prompts()).toEqual(["old context", "latest", "session context"]);
  });
});
