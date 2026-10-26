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

  it("rejects extra text in the interval field without replacing a trigger", async () => {
    const h = setup(); h.setIdle(false);
    await h.runtime.loop({ interval: "1m", prompt: "old" }, h.ctx);
    const before = await h.runtime.loop({}, h.ctx);
    await expect(h.runtime.loop({ interval: "1m extra", prompt: "new" }, h.ctx)).rejects.toThrow(/interval/);
    expect(await h.runtime.loop({}, h.ctx)).toEqual(before);
  });

  it.each(["watch", "all"])("gives name-specific stop instructions for self-paced loop %s", async name => {
    const h = setup(); h.setIdle(false);
    const result = await h.runtime.loop({ name, prompt: "watch" }, h.ctx);
    expect(result.text).toContain(`spider loop name:${JSON.stringify(name)} stop:true`);
    expect(result.text).not.toContain("/loop stop ends it");
  });

  it("keeps line breaks inside a short prompt preview on one listing line", async () => {
    const h = setup();
    await h.runtime.schedule({ delaySeconds: 60, prompt: "a\nb" }, h.ctx);
    const result = await h.runtime.loop({}, h.ctx);
    expect(result.text.split("\n")).toHaveLength(1);
    expect(result.text).toContain("a b");
  });

  it.each([
    ["30s", "every 1m (requested 30s)", 60],
    ["120s", "every 2m", 120], ["2h", "every 2h", 7200], ["1d", "every 1d", 86400],
  ])("lists the effective cadence for requested interval %s", async (interval, label, seconds) => {
    const h = setup(); h.setIdle(false);
    await h.runtime.loop({ interval, prompt: "tick" }, h.ctx);
    const result = await h.runtime.loop({}, h.ctx);
    expect(result.text).toContain(`loop: ${label};`);
    expect(result.details.triggers).toEqual([expect.objectContaining({ interval, intervalSeconds: seconds })]);
  });

  it("claims a one-shot replacement only when the name was already active", async () => {
    const h = setup();
    const created = await h.runtime.schedule({ delaySeconds: 60, prompt: "first" }, h.ctx);
    expect(created.text).not.toMatch(/replac/i);
    const replaced = await h.runtime.schedule({ delaySeconds: 120, prompt: "second" }, h.ctx);
    expect(replaced.text).toContain("It replaced the trigger named wakeup.");
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
  it("retries busy due work once per second instead of spinning", async () => {
    const h = setup();
    await h.runtime.schedule({ delaySeconds: 60, prompt: "wait" }, h.ctx);
    const idle = vi.fn(() => false);
    h.ctx.isIdle = idle;
    vi.setSystemTime(NOW + 60_000);
    await vi.advanceTimersToNextTimerAsync();
    idle.mockClear();
    await vi.advanceTimersByTimeAsync(3000);
    expect(idle.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(idle.mock.calls.length).toBeLessThanOrEqual(4);
    expect(h.prompts()).toEqual([]);
    h.ctx.isIdle = () => true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.prompts()).toEqual(["wait"]);
  });

  it("releases the dispatch gate after failed preparation so the next trigger fires within one second", async () => {
    const h = setup();
    await h.runtime.schedule({ name: "a", delaySeconds: 60, prompt: "lost write" }, h.ctx);
    await h.runtime.schedule({ name: "b", delaySeconds: 60, prompt: "next" }, h.ctx);
    h.appendEntry.mockImplementationOnce(() => { throw new Error("disk full"); });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.prompts()).toEqual([]);
    expect(h.notifications).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.prompts()).toEqual(["next"]);
  });

  it("blocks delivery during a run even when the context reports idle and no gate exists", async () => {
    const h = setup();
    await h.runtime.schedule({ delaySeconds: 60, prompt: "after run" }, h.ctx);
    await h.emit("agent_start");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.prompts()).toEqual([]);
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual([expect.objectContaining({ state: "due" })]);
    await h.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.prompts()).toEqual(["after run"]);
  });

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
    vi.setSystemTime(NOW + 120_000); await vi.advanceTimersToNextTimerAsync();
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
    // At the Date boundary, the next anchored minute is outside the representable range.
    const anchor = kind === "interval-failed" ? 8.64e15 - 90_000 : NOW;
    vi.setSystemTime(anchor);
    const h = setup(time); h.setIdle(false);
    if (kind === "once") await h.runtime.schedule({ delaySeconds: 60, prompt: "check" }, h.ctx);
    else await h.runtime.loop({ prompt: "check", ...(kind.startsWith("cron") ? { cron: "0 8 * * *" } : kind.startsWith("interval") ? { interval: "1m" } : {}) }, h.ctx);
    if (kind === "cron-failed") time.occurrences.set("0 8 * * *", []);
    h.ctx.mode = "print"; h.setIdle(true);
    vi.setSystemTime(anchor + 60_000); await vi.advanceTimersToNextTimerAsync();
    expect(h.prompts()).toEqual([]);
    expect(h.notifications).toHaveLength(1);
    if (kind === "interval-failed") expect(h.notifications[0].text).toContain("Cannot advance interval");
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
    const anchor = kind === "interval" ? 8.64e15 - 90_000 : NOW;
    vi.setSystemTime(anchor);
    const h = setup(time); h.setIdle(false);
    await h.runtime.loop({ prompt: "last", ...(kind === "cron" ? { cron: "0 8 * * *" } : { interval: "1m" }) }, h.ctx);
    h.setIdle(true); vi.setSystemTime(anchor + 60_000); await vi.advanceTimersToNextTimerAsync();
    expect(h.prompts()).toEqual(["last"]);
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual([]);
    expect(h.notifications).toHaveLength(1);
    if (kind === "interval") expect(h.notifications[0].text).toContain("Cannot advance interval");
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


describe("named re-arms and prompt security", () => {
  it("does not seal a one-shot when tool loop stop leaves it untouched during a run", async () => {
    const h = setup();
    await h.runtime.schedule({ name: "ci", delaySeconds: 60, prompt: "first" }, h.ctx);
    await h.emit("agent_start");
    expect((await h.runtime.loop({ name: "ci", stop: true }, h.ctx)).details).toEqual({ stopped: false });
    await h.runtime.schedule({ name: "ci", delaySeconds: 120, prompt: "retimed" }, h.ctx);
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual([expect.objectContaining({ name: "ci", prompt: "retimed", nextAt: NOW + 120_000 })]);
  });

  it("keeps named one-shots separate from loop re-arms", async () => {
    const h = setup();
    await h.runtime.schedule({ name: "build", delaySeconds: 60, prompt: "build" }, h.ctx);
    await h.runtime.schedule({ name: "deploy", delaySeconds: 120, prompt: "deploy" }, h.ctx);
    await h.runtime.loop({ name: "watch", prompt: "watch check" }, h.ctx);
    expect(h.prompts()[0]).toContain('name:"watch"');
    await h.settleDelivery();
    await h.runtime.schedule({ name: "watch", delaySeconds: 180, prompt: "/loop watch check" }, h.ctx);
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "watch", kind: "self-paced", nextAt: NOW + 180_000 })]));
    await vi.advanceTimersByTimeAsync(60_000); expect(h.prompts().at(-1)).toBe("build"); await h.settleDelivery();
    await vi.advanceTimersByTimeAsync(60_000); expect(h.prompts().at(-1)).toBe("deploy"); await h.settleDelivery();
    await vi.advanceTimersByTimeAsync(60_000); expect(h.prompts().at(-1)).toContain("watch check\n");
    expect(h.prompts()).toHaveLength(4);
    await h.settleDelivery();
    await h.runtime.schedule({ name: "watch", delaySeconds: 60, prompt: "ordinary replacement" }, h.ctx);
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual([expect.objectContaining({ name: "watch", kind: "once" })]);
  });

  it.each([false, true])("seals only the stopped or replaced name until settled, absent=%s", async absent => {
    const h = setup(); h.setIdle(false);
    if (!absent) await h.runtime.loop({ name: "a", prompt: "a" }, h.ctx);
    await h.runtime.loop({ name: "b", prompt: "b" }, h.ctx);
    h.setIdle(true); await h.emit("agent_settled"); await vi.advanceTimersByTimeAsync(0);
    await h.settleDelivery(); await h.settleDelivery();
    await h.emit("agent_start"); h.setIdle(false);
    await h.runtime.loop({ name: "a", stop: true }, h.ctx);
    for (const prompt of ["plain", "/loop a", " /loop reworded"]) {
      await expect(h.runtime.schedule({ name: "a", delaySeconds: 60, prompt }, h.ctx)).rejects.toThrow(/a loop was ended or replaced/);
    }
    await h.runtime.schedule({ name: "b", delaySeconds: 60, prompt: "/loop b" }, h.ctx);
    await h.runtime.schedule({ name: "c", delaySeconds: 60, prompt: "c" }, h.ctx);
    await h.emit("agent_end");
    await expect(h.runtime.schedule({ name: "a", prompt: "/bad" }, h.ctx)).rejects.toThrow(/a loop was ended or replaced/);
    await h.emit("agent_settled");
    await h.runtime.schedule({ name: "a", delaySeconds: 60, prompt: "allowed" }, h.ctx);
    await h.emit("agent_start");
    await h.runtime.loop({ name: "a", prompt: "replacement" }, h.ctx);
    await expect(h.runtime.schedule({ name: "a", delaySeconds: 60, prompt: "/reworded" }, h.ctx)).rejects.toThrow(/a loop was ended or replaced/);
    expect((await h.runtime.schedule({ name: "a", stop: true }, h.ctx)).details).toEqual({ cancelled: false });
    h.setIdle(true); await h.emit("agent_settled"); await vi.advanceTimersByTimeAsync(0);
    expect(h.prompts().at(-1)).toContain("replacement\n");
  });

  it("manual compaction does not create per-name seals", async () => {
    const h = setup(); h.setIdle(false);
    await h.runtime.loop({ name: "a", stop: true }, h.ctx);
    await h.runtime.loop({ name: "a", prompt: "a" }, h.ctx);
    await h.runtime.schedule({ name: "a", at: "2026-10-20T12:02Z", prompt: "/loop a" }, h.ctx);
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual([expect.objectContaining({ name: "a", kind: "self-paced", nextAt: NOW + 120_000 })]);
  });

  it.each([120_000, 120_001])("adds a late note only beyond two minutes: %s", async late => {
    const h = setup(); h.setIdle(false);
    await h.runtime.loop({ name: "watch", prompt: "watch" }, h.ctx);
    vi.setSystemTime(NOW + late); h.setIdle(true);
    await h.emit("agent_settled"); await vi.advanceTimersByTimeAsync(0);
    const prompt = h.prompts()[0] as string;
    expect(prompt.startsWith("watch\n\n[/loop, self-paced]")).toBe(true);
    if (late === 120_000) expect(prompt).not.toContain("Running late");
    else {
      const note = "[spider schedule] Scheduled for 2026-10-20 12:00:00.000 Test/Zone (2026-10-20T12:00:00.000Z UTC). Running late because the session was busy, pi was closed or the machine was asleep.";
      expect(prompt.endsWith(note)).toBe(true);
      expect(prompt.indexOf("Skip the call")).toBeLessThan(prompt.indexOf(note));
    }
    const slash = setup(); slash.setIdle(false);
    await slash.slash("/user-only unchanged");
    vi.setSystemTime(Date.now() + 180_000); slash.setIdle(true);
    await slash.emit("agent_settled"); await vi.advanceTimersByTimeAsync(0);
    expect(slash.prompts()[0]).not.toContain("Running late");
  });
});


describe("slash trigger controls", () => {
  it.each(["5m check", "stop", "stop all"])("notifies once when a slash %s snapshot write fails", async command => {
    const h = setup(); h.setIdle(false);
    if (command.startsWith("stop")) await h.slash("5m old");
    h.notifications.length = 0;
    h.appendEntry.mockImplementationOnce(() => { throw new Error("disk full"); });
    await h.slash(command);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].text).toContain("disk full");
  });

  it.each(["1h", "2h", "1d", "30s"])("preserves the slash interval token %s in snapshots and after reload", async interval => {
    let h = setup(); h.setIdle(false);
    await h.slash(`${interval} check`);
    expect(h.snapshots().at(-1)!.triggers).toEqual([expect.objectContaining({ interval })]);
    h = await h.restart("reload");
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual([expect.objectContaining({ interval })]);
  });

  it("lists before usage without changing definitions", async () => {
    const h = setup(); await h.runtime.schedule({ delaySeconds: 60, prompt: "once" }, h.ctx);
    const state = await h.runtime.loop({}, h.ctx), writes = h.snapshots().length;
    await h.slash("");
    expect(h.notifications.at(-1)!.text).toMatch(/wakeup:[\s\S]*Usage/);
    expect(await h.runtime.loop({}, h.ctx)).toEqual(state); expect(h.snapshots()).toHaveLength(writes);
  });
  it("default slash stop removes only loop and wakeup", async () => {
    const h = setup(); h.setIdle(false);
    await h.runtime.loop({ prompt: "loop" }, h.ctx);
    await h.runtime.schedule({ delaySeconds: 60, prompt: "wakeup" }, h.ctx);
    await h.runtime.schedule({ name: "other", delaySeconds: 60, prompt: "other" }, h.ctx);
    await h.slash("stop");
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual([expect.objectContaining({ name: "other" })]);
  });
  it.each(["once", "interval", "cron", "self-paced"])("named slash stop removes one %s trigger", async kind => {
    const time = fakeTime(); time.occurrences.set("0 8 * * *", [NOW + 60_000]);
    const h = setup(time); h.setIdle(false);
    if (kind === "once") await h.runtime.schedule({ name: "target", delaySeconds: 60, prompt: "once" }, h.ctx);
    else await h.runtime.loop({ name: "target", prompt: "loop", ...(kind === "cron" ? { cron: "0 8 * * *" } : kind === "interval" ? { interval: "1m" } : {}) }, h.ctx);
    await h.runtime.schedule({ name: "other", delaySeconds: 60, prompt: "other" }, h.ctx);
    const count = h.snapshots().length;
    await h.emit("agent_start"); await h.slash("stop target");
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual([expect.objectContaining({ name: "other" })]);
    expect(h.snapshots()).toHaveLength(count + 1);
    if (kind !== "once") await expect(h.runtime.schedule({ name: "target", delaySeconds: 60, prompt: "old" }, h.ctx)).rejects.toThrow(/ended or replaced/);
  });
  it("stop all seals removed loop names but all remains a tool name", async () => {
    const h = setup(); h.setIdle(false);
    await h.runtime.loop({ name: "all", prompt: "all" }, h.ctx);
    await h.runtime.loop({ name: "b", prompt: "b" }, h.ctx);
    await h.runtime.schedule({ name: "once", delaySeconds: 60, prompt: "once" }, h.ctx);
    await h.emit("agent_start"); const count = h.snapshots().length;
    await h.slash("stop all");
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual([]);
    expect(h.snapshots()).toHaveLength(count + 1);
    for (const name of ["all", "b"]) await expect(h.runtime.schedule({ name, delaySeconds: 60, prompt: "old" }, h.ctx)).rejects.toThrow(/ended or replaced/);
    await h.runtime.schedule({ name: "once", delaySeconds: 60, prompt: "allowed" }, h.ctx);
    await h.emit("agent_settled");
    await h.runtime.loop({ name: "all", prompt: "all" }, h.ctx);
    await h.runtime.loop({ name: "all", stop: true }, h.ctx);
    expect((await h.runtime.loop({}, h.ctx)).details.triggers).toEqual([expect.objectContaining({ name: "once" })]);
  });
});
