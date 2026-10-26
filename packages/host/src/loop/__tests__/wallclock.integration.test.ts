import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import spiderExtension from "../../extension";
import { clearActions } from "../../dispatch";
import { registerLoopSchedule, type SchedulerTimeMath, type TriggerListing } from "../index";
import { createTimeMath } from "../time-math";
import { zoneSource } from "../zoned";
import { setup, type Harness } from "./harness";

const ms = Date.parse;
const real = () => setup(createTimeMath());
async function rows(h: Harness): Promise<TriggerListing[]> {
  return (await h.runtime.loop({}, h.ctx)).details.triggers as TriggerListing[];
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-26T02:29:00Z")); vi.stubEnv("PI_SUBAGENT_CHILD", "0"); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); clearActions(); });

describe("real wall-clock triggers", () => {
  it("delivers consecutive daily Kolkata 08:00 occurrences without drifting", async () => {
    const h = real();
    await h.runtime.loop({ name: "morning", cron: "0 8 * * *", tz: "Asia/Kolkata", prompt: "daily" }, h.ctx);
    expect(h.prompts()).toEqual([]);
    for (const [due, next] of [
      ["2026-10-26T02:30:00Z", "2026-10-27T02:30:00.000Z"],
      ["2026-10-27T02:30:00Z", "2026-10-28T02:30:00.000Z"],
      ["2026-10-28T02:30:00Z", "2026-10-29T02:30:00.000Z"],
    ]) {
      if (h.prompts().length) vi.setSystemTime(ms(due) - 30_000);
      const before = h.prompts().length;
      if (before) await vi.advanceTimersToNextTimerAsync(); else await vi.advanceTimersByTimeAsync(60_000);
      expect(h.prompts()).toHaveLength(before + 1);
      const lateness = Date.now() - ms(due);
      expect(lateness).toBeGreaterThanOrEqual(0); expect(lateness).toBeLessThan(60_000);
      expect(await rows(h)).toEqual([expect.objectContaining({ name: "morning", nextAtUtc: next, nextAtLocal: next.slice(0, 10) + " 08:00:00 Asia/Kolkata" })]);
      await h.settleDelivery();
    }
  });

  it("detects sleep through wall-clock changes rather than timer advancement", async () => {
    const h = real();
    await h.runtime.loop({ name: "morning", cron: "0 8 * * *", tz: "Asia/Kolkata", prompt: "wake" }, h.ctx);
    vi.setSystemTime(new Date("2026-10-27T02:35:00Z"));
    await vi.advanceTimersToNextTimerAsync();
    expect(h.prompts()).toEqual([expect.stringContaining("Scheduled for 2026-10-26 08:00:00 Asia/Kolkata (2026-10-26T02:30:00.000Z UTC)")]);
    expect(await rows(h)).toEqual([expect.objectContaining({ nextAtUtc: "2026-10-28T02:30:00.000Z" })]);
    await vi.advanceTimersByTimeAsync(10_000); expect(h.prompts()).toHaveLength(1);
  });

  it.each([false, true])("waits when busy at the Kolkata due time, run=%s", async run => {
    const h = real();
    await h.runtime.loop({ cron: "0 8 * * *", tz: "Asia/Kolkata", prompt: "busy" }, h.ctx);
    h.setIdle(false); if (run) await h.emit("agent_start");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.prompts()).toEqual([]);
    expect(await rows(h)).toEqual([expect.objectContaining({ state: "due", nextAtUtc: "2026-10-26T02:30:00.000Z" })]);
    h.setIdle(true);
    if (run) { await h.emit("agent_settled"); await vi.advanceTimersByTimeAsync(0); }
    else await vi.advanceTimersByTimeAsync(1000);
    expect(h.prompts()).toEqual(["busy"]);
    expect(await rows(h)).toEqual([expect.objectContaining({ nextAtUtc: "2026-10-27T02:30:00.000Z" })]);
  });

  it.each([false, true])("delivers the final valid cron occurrence when the next five-year search throws, restore=%s", async restore => {
    vi.setSystemTime(new Date("2096-02-28T23:59:00Z"));
    let h = real();
    await h.runtime.loop({ name: "a-final", cron: "0 0 29 2 *", tz: "UTC", prompt: "last leap day" }, h.ctx);
    await h.runtime.schedule({ name: "b-once", at: "2096-02-29T00:01Z", prompt: "other" }, h.ctx);
    const entries = h.getEntries(), sessionId = h.getSessionId();
    if (restore) {
      await h.emit("session_shutdown");
      h = setup(createTimeMath(), { sessionId, entries, leafId: entries.at(-1)!.id });
    }
    vi.setSystemTime(new Date("2096-03-01T00:00:00Z"));
    if (restore) {
      await h.emit("session_start", { reason: "reload" });
      expect(await rows(h)).toHaveLength(2); expect(h.notifications).toEqual([]);
    }
    const append = h.appendEntry.getMockImplementation()!;
    h.appendEntry.mockImplementation((type, data) => { expect(h.prompts()).toEqual([]); append(type, data); });
    if (restore) await vi.advanceTimersByTimeAsync(0); else await vi.advanceTimersToNextTimerAsync();
    expect(h.prompts()).toEqual([expect.stringContaining("last leap day\n")]);
    expect(h.notifications).toHaveLength(1);
    expect(h.snapshots().at(-1)!.triggers).toEqual([expect.objectContaining({ name: "b-once" })]);
    expect(await rows(h)).toEqual([expect.objectContaining({ name: "b-once", state: "due" })]);
    h.appendEntry.mockImplementation(append);
    await h.settleDelivery(); expect(h.prompts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000); expect(h.notifications).toHaveLength(1); expect(h.prompts()).toHaveLength(2);
  });

  it.each([
    ["30 2 * * *", "America/New_York", "2026-03-08T05:00Z", "2026-03-08T07:00Z", "2026-03-09T06:30Z"],
    ["30 1 * * *", "America/New_York", "2026-11-01T04:00Z", "2026-11-01T05:30Z", "2026-11-02T06:30Z"],
    ["15 2 * * *", "Australia/Lord_Howe", "2026-10-03T14:00Z", "2026-10-03T15:30Z", "2026-10-04T15:15Z"],
    ["45 1 * * *", "Australia/Lord_Howe", "2026-04-04T13:00Z", "2026-04-04T14:45Z", "2026-04-05T15:15Z"],
  ])("resolves %s in %s through real scheduler advancement", async (cron, tz, after, due, next) => {
    vi.setSystemTime(ms(after)); const h = real();
    await h.runtime.loop({ cron, tz, prompt: "transition" }, h.ctx);
    expect((await rows(h))[0].nextAt).toBe(ms(due));
    vi.setSystemTime(ms(due) - 30_000); await vi.advanceTimersToNextTimerAsync();
    expect(h.prompts()).toEqual(["transition"]);
    expect((await rows(h))[0].nextAt).toBe(ms(next));
    await h.settleDelivery();
    vi.setSystemTime(ms(due) + 60 * 60_000); await vi.advanceTimersToNextTimerAsync();
    expect(h.prompts()).toEqual(["transition"]);
  });

  it("captures the default zone once through direct real registration", async () => {
    vi.stubEnv("TZ", "Asia/Kolkata");
    const time: SchedulerTimeMath = createTimeMath();
    const pi = { on() {}, registerCommand() {}, appendEntry() {}, sendUserMessage() {} };
    const scheduler = registerLoopSchedule(pi as unknown as ExtensionAPI, time);
    const ctx = { mode: "rpc", isIdle: () => true, sessionManager: { getSessionId: () => "zone", getEntries: () => [] }, ui: { notify() {} } } as unknown as ExtensionContext;
    await scheduler.loop({ cron: "0 8 * * *", prompt: "zone" }, ctx);
    vi.stubEnv("TZ", "America/New_York");
    const row = (await scheduler.loop({}, ctx)).details.triggers as TriggerListing[];
    expect(row).toEqual([expect.objectContaining({ tz: "Asia/Kolkata", nextAtUtc: "2026-10-26T02:30:00.000Z", nextAtLocal: "2026-10-26 08:00:00 Asia/Kolkata" })]);
  });

  it.each(["", "UTC0", "EST5", "UTC+3"])("creates and restores a plain schedule under TZ=%j", async tz => {
    vi.stubEnv("TZ", tz);
    // Exercise the real Intl default and Date offset without relying on the host symlink.
    vi.spyOn(zoneSource, "readLink").mockImplementation(() => { throw new Error("ENOENT"); });
    let h = real();
    await h.runtime.loop({ name: "morning", cron: "0 8 * * *", tz: "Asia/Kolkata", prompt: "daily" }, h.ctx);
    await h.runtime.schedule({ delaySeconds: 120, prompt: "plain wakeup" }, h.ctx);
    const created = await rows(h);
    expect(created).toHaveLength(2);
    expect(typeof created[1].tz).toBe("string");
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: created[1].tz })).not.toThrow();
    h = await h.restart("reload");
    expect(await rows(h)).toEqual(created);
    expect(h.notifications).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.prompts()).toEqual(["daily"]);
    await h.settleDelivery();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.prompts()).toEqual(["daily", "plain wakeup"]);
  });

  it.each(["reload", "resume", "new", "fork"] as const)("applies real-math named listing and restore lifetime on %s", async reason => {
    let h = real();
    await h.runtime.loop({ name: "morning", cron: "0 8 * * *", tz: "Asia/Kolkata", prompt: "daily" }, h.ctx);
    await h.runtime.schedule({ name: "once", at: "2026-10-26T08:01+05:30", prompt: "once" }, h.ctx);
    expect(h.snapshots()).toHaveLength(2);
    h = await h.restart(reason);
    expect(await rows(h)).toHaveLength(reason === "new" || reason === "fork" ? 0 : 2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.prompts()).toEqual(reason === "new" || reason === "fork" ? [] : ["daily"]);
  });

  it("preserves per-name seals and slash stop forms with real math", async () => {
    const h = real(); h.setIdle(false);
    await h.runtime.loop({ name: "watch", prompt: "watch" }, h.ctx);
    await h.runtime.schedule({ name: "other", delaySeconds: 60, prompt: "other" }, h.ctx);
    await h.emit("agent_start"); await h.slash("stop watch");
    await expect(h.runtime.schedule({ name: "watch", delaySeconds: 60, prompt: "/reworded" }, h.ctx)).rejects.toThrow(/ended or replaced/);
    await h.runtime.schedule({ name: "free", at: "2026-10-26T08:02+05:30", prompt: "free" }, h.ctx);
    await h.slash("stop"); expect((await rows(h)).map(t => t.name)).toEqual(["free", "other"]);
    await h.slash("stop all"); expect(await rows(h)).toEqual([]);
    h.setIdle(true); await h.emit("agent_settled"); await vi.advanceTimersByTimeAsync(180_000); expect(h.prompts()).toEqual([]);
  });

  it("does not repeat a consumed self-paced iteration through real-math restore", async () => {
    let h = real();
    await h.runtime.loop({ name: "watch", prompt: "watch" }, h.ctx);
    await h.runtime.schedule({ name: "watch", at: "2026-10-26T08:00+05:30", prompt: "/loop watch" }, h.ctx);
    await vi.advanceTimersByTimeAsync(60_000); expect(h.prompts()).toHaveLength(2);
    expect(h.snapshots().at(-1)!.triggers).toEqual([expect.objectContaining({ nextAt: null })]);
    h = await h.restart("reload"); expect(await rows(h)).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_600_000); expect(h.prompts()).toEqual([]);
  });

  it("routes real cron and offset-bearing at through the unmocked registered host tool", async () => {
    const tools = new Map<string, any>();
    const entries: unknown[] = [], messages: string[] = [];
    const pi = {
      on() {}, registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
      appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
      sendUserMessage(prompt: string) { messages.push(prompt); },
    };
    const cwd = resolve(".spider/scratch/wallclock-integration/real-host");
    const ctx = { cwd, mode: "rpc", isIdle: () => true, ui: { notify() {} }, sessionManager: { getSessionId: () => "real-host", getEntries: () => entries } };
    spiderExtension(pi);
    const run = (args: unknown) => tools.get("spider").execute("real", args, undefined, undefined, ctx);
    await run({ action: "loop", name: "morning", cron: "0 8 * * *", tz: "Asia/Kolkata", prompt: "real daily" });
    await run({ action: "schedule", name: "once", at: "2026-10-26T08:01+05:30", prompt: "real once" });
    expect(messages).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000); expect(messages).toEqual(["real daily"]);
    await vi.advanceTimersByTimeAsync(60_000); expect(messages).toEqual(["real daily", "real once"]);
    expect((await run({ action: "loop" })).details.triggers).toEqual([expect.objectContaining({ name: "morning", cron: "0 8 * * *", tz: "Asia/Kolkata", nextAtUtc: "2026-10-27T02:30:00.000Z", nextAtLocal: "2026-10-27 08:00:00 Asia/Kolkata" })]);
    expect(existsSync(resolve(cwd, ".spider/project.db"))).toBe(false);
    expect(entries).toHaveLength(4);
  });
});
