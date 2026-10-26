import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Trigger, TriggerSnapshot } from "../index";
import { fakeTime, setup, type Harness } from "./harness";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const once: Trigger = { name: "once", kind: "once", prompt: "once", origin: "model", tz: "Test/Zone", delaySeconds: 60, nextAt: NOW + 60_000, noop: false };
function entry(data: unknown, id = "saved"): SessionEntry {
  return { type: "custom", customType: "spider-triggers", id, parentId: null, timestamp: "2026-10-20T12:00:00Z", data };
}
function saved(triggers: Trigger[], overrides: Record<string, unknown> = {}) {
  return { sessionId: "test-session", entries: [entry({ version: 1, sessionId: "test-session", triggers, ...overrides })], leafId: "saved" };
}
async function rows(h: Harness) { return (await h.runtime.loop({}, h.ctx)).details.triggers; }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); vi.stubEnv("PI_SUBAGENT_CHILD", "0"); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("trigger persistence", () => {
  it("writes full defensive snapshots only for changed definitions", async () => {
    const h = setup(); h.setIdle(false);
    expect(h.snapshots()).toHaveLength(0);
    await h.runtime.schedule({ delaySeconds: 60, prompt: "first" }, h.ctx);
    expect(h.snapshots()).toEqual([{ version: 1, sessionId: "test-session", triggers: [{ ...once, name: "wakeup", prompt: "first" }] }]);
    const copy = h.snapshots(); copy[0].triggers.length = 0;
    expect(h.snapshots()[0].triggers).toHaveLength(1);
    await h.runtime.schedule({ delaySeconds: 120, prompt: "second" }, h.ctx); expect(h.snapshots()).toHaveLength(2);
    await rows(h); expect(h.snapshots()).toHaveLength(2);
    await expect(h.runtime.schedule({ prompt: "bad" }, h.ctx)).rejects.toThrow(); expect(h.snapshots()).toHaveLength(2);
    await h.runtime.schedule({ stop: true }, h.ctx); expect(h.snapshots()).toHaveLength(3);
    expect(h.snapshots().at(-1)!.triggers).toEqual([]);
    await h.runtime.schedule({ stop: true }, h.ctx); expect(h.snapshots()).toHaveLength(3);
    await h.runtime.loop({ prompt: "watch" }, h.ctx); expect(h.snapshots()).toHaveLength(4);
    await h.runtime.schedule({ name: "loop", delaySeconds: 60, prompt: "/loop watch" }, h.ctx); expect(h.snapshots()).toHaveLength(5);
    await h.runtime.loop({ stop: true }, h.ctx); expect(h.snapshots()).toHaveLength(6);
    await h.runtime.loop({ stop: true }, h.ctx); expect(h.snapshots()).toHaveLength(6);
    await h.emit("session_shutdown", { reason: "reload" }); expect(h.snapshots()).toHaveLength(6);
  });

  it.each(["once", "cron", "self-paced", "interval"])("saves %s consumption before delivery except successful interval ticks", async kind => {
    const time = fakeTime(); time.occurrences.set("0 8 * * *", [NOW + 60_000, NOW + 120_000]);
    const h = setup(time); h.setIdle(false);
    if (kind === "once") await h.runtime.schedule({ delaySeconds: 60, prompt: "fire" }, h.ctx);
    else await h.runtime.loop({ prompt: "fire", ...(kind === "cron" ? { cron: "0 8 * * *" } : kind === "interval" ? { interval: "1m" } : {}) }, h.ctx);
    expect(h.snapshots()).toHaveLength(1);
    const append = h.appendEntry.getMockImplementation()!;
    h.appendEntry.mockImplementation((type, data) => { expect(h.prompts()).toEqual([]); append(type, data); });
    vi.setSystemTime(NOW + 60_000); h.setIdle(true); await h.emit("agent_settled"); await vi.advanceTimersByTimeAsync(0);
    expect(h.prompts()).toHaveLength(1);
    expect(h.snapshots()).toHaveLength(kind === "interval" ? 1 : 2);
    if (kind === "once") expect(h.snapshots().at(-1)!.triggers).toEqual([]);
    if (kind === "self-paced") expect(h.snapshots().at(-1)!.triggers).toEqual([expect.objectContaining({ nextAt: null })]);
    if (kind === "cron") expect(h.snapshots().at(-1)!.triggers).toEqual([expect.objectContaining({ nextAt: NOW + 120_000 })]);
  });

  it.each(["startup", "reload", "resume", "new", "fork"] as const)("restores only the same session for %s", async reason => {
    const h = setup();
    await h.runtime.schedule({ delaySeconds: 60, prompt: "saved" }, h.ctx);
    const restored = await h.restart(reason);
    expect(await rows(restored)).toHaveLength(reason === "new" || reason === "fork" ? 0 : 1);
    expect(restored.snapshots()).toHaveLength(1);
    const foreign = setup(fakeTime(), { ...saved([once]), sessionId: "other" });
    await foreign.emit("session_start", { reason });
    expect(await rows(foreign)).toEqual([]);
  });

  it("selects matching snapshots by file order and never revives a cancellation", async () => {
    const h = setup(fakeTime(), { sessionId: "test-session", leafId: "older", entries: [
      { ...entry({ version: 1, sessionId: "test-session", triggers: [once] }, "older"), timestamp: "2099-01-01T00:00:00Z" },
      entry({ version: 1, sessionId: "foreign", triggers: [once] }, "foreign"),
      { ...entry({ version: 1, sessionId: "test-session", triggers: [] }, "cancel"), timestamp: "2000-01-01T00:00:00Z" },
    ] });
    await h.emit("session_start", { reason: "reload" });
    expect(await rows(h)).toEqual([]); expect(h.snapshots()).toHaveLength(3);
  });

  it("restores the newest snapshot after tree navigation", async () => {
    const time = fakeTime(); time.occurrences.set("0 8 * * *", [NOW + 60_000, NOW + 180_000, NOW + 300_000]);
    let h = setup(time);
    h.appendEntry("fixture", {}); const early = h.entries[0].id;
    await h.runtime.loop({ name: "cron", cron: "0 8 * * *", prompt: "cron" }, h.ctx);
    await vi.advanceTimersByTimeAsync(60_000); expect(h.prompts()).toEqual(["cron"]); await h.settleDelivery();
    expect(h.snapshots()).toHaveLength(2);
    h.branch(early);
    await h.runtime.schedule({ name: "once", delaySeconds: 60, prompt: "once" }, h.ctx);
    expect(h.entries.at(-1)!.parentId).toBe(early);
    expect(h.snapshots().at(-1)!.triggers).toHaveLength(2);
    h.branch(early); h = await h.restart("reload");
    expect(await rows(h)).toEqual([expect.objectContaining({ name: "cron", nextAt: NOW + 180_000 }), expect.objectContaining({ name: "once" })]);
    await vi.advanceTimersByTimeAsync(0); expect(h.prompts()).toEqual([]);
    await h.runtime.schedule({ name: "once", stop: true }, h.ctx); h.branch(early);
    h = await h.restart("reload"); expect(await rows(h)).toEqual([expect.objectContaining({ name: "cron" })]);
    await h.runtime.schedule({ name: "once", delaySeconds: 60, prompt: "once" }, h.ctx);
    await vi.advanceTimersByTimeAsync(60_000); expect(h.prompts()).toEqual(["once"]);
    h.branch(early); h = await h.restart("reload");
    expect(await rows(h)).toEqual([expect.objectContaining({ name: "cron", nextAt: NOW + 180_000 })]);
  });

  it.each([{ mode: "print" as const }, { mode: "json" as const }, { child: true }, { mode: "rpc" as const, child: true }])("does not restore or consume in restricted starts %j", async start => {
    const time = fakeTime(); time.occurrences.set("0 8 * * *", [NOW + 300_000]);
    const data = saved([once, { name: "cron", kind: "cron", cron: "0 8 * * *", prompt: "cron", tz: "Test/Zone", origin: "model", nextAt: NOW + 60_000 }]);
    let h = setup(time, data); vi.setSystemTime(NOW + 180_000);
    h = await h.restart("reload", start);
    expect(vi.getTimerCount()).toBe(0); expect(h.snapshots()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000); await h.emit("agent_settled"); await vi.advanceTimersByTimeAsync(0);
    expect(h.prompts()).toEqual([]); expect(vi.getTimerCount()).toBe(0); expect(h.snapshots()).toHaveLength(1);
    h.ctx.mode = "tui"; vi.stubEnv("PI_SUBAGENT_CHILD", "0");
    expect(await rows(h)).toEqual([]);
    h = await h.restart("reload"); await vi.advanceTimersByTimeAsync(0); await h.settleDelivery();
    expect(h.prompts()).toHaveLength(2); expect(h.snapshots()).toHaveLength(3);
  });

  it.each([90_000, 240_001])("fires restored missed once and cron once with original due time, elapsed=%s", async elapsed => {
    const time = fakeTime(); time.occurrences.set("0 8 * * *", [NOW + 60_000, NOW + 86_400_000]);
    let h = setup(time);
    await h.runtime.schedule({ name: "a", at: "2026-10-20T12:01Z", prompt: "once" }, h.ctx);
    await h.runtime.loop({ name: "b", cron: "0 8 * * *", prompt: "cron" }, h.ctx);
    await h.emit("session_shutdown"); vi.setSystemTime(NOW + elapsed);
    h = await h.restart("reload"); await vi.advanceTimersByTimeAsync(0); await h.settleDelivery();
    expect(h.prompts()).toHaveLength(2);
    for (const prompt of h.prompts() as string[]) {
      if (elapsed > 180_000) {
        expect(prompt).toContain("2026-10-20 12:01:00.000 Test/Zone"); expect(prompt).toContain("2026-10-20T12:01:00.000Z UTC");
      } else expect(prompt).not.toContain("Running late");
    }
    expect(await rows(h)).toEqual([expect.objectContaining({ name: "b", nextAt: NOW + 86_400_000 })]);
    h = await h.restart("resume"); await vi.advanceTimersByTimeAsync(10_000); expect(h.prompts()).toEqual([]);
  });

  it("resumes intervals from their anchor without catching up", async () => {
    let h = setup(); await h.runtime.loop({ interval: "1m", prompt: "tick" }, h.ctx);
    await h.emit("session_shutdown"); vi.setSystemTime(NOW + 610_000);
    h = await h.restart("resume");
    expect(await rows(h)).toEqual([expect.objectContaining({ anchor: NOW, nextAt: NOW + 660_000 })]);
    await vi.advanceTimersByTimeAsync(49_999); expect(h.prompts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); expect(h.prompts()).toEqual(["tick"]);
  });

  it("keeps user origin across restore", async () => {
    let h = setup(); h.setIdle(false); await h.slash("trusted");
    await h.runtime.schedule({ name: "loop", delaySeconds: 60, prompt: "/loop trusted" }, h.ctx);
    h = await h.restart("reload"); await vi.advanceTimersByTimeAsync(60_000);
    expect(h.messages).toEqual([{ prompt: expect.stringContaining("trusted\n"), options: { deliverAs: "followUp", expandPromptTemplates: true } }]);
    await h.settleDelivery(); await h.runtime.schedule({ delaySeconds: 60, prompt: "model" }, h.ctx);
    h = await h.restart("reload"); await vi.advanceTimersByTimeAsync(60_000);
    expect(h.messages).toEqual([{ prompt: "model", options: { deliverAs: "followUp", expandPromptTemplates: false } }]);
  });

  it("drops a consumed self-paced re-arm after reload", async () => {
    const h = setup();
    await h.runtime.loop({ name: "watch", prompt: "watch check" }, h.ctx);
    await h.runtime.schedule({ name: "watch", delaySeconds: 60, prompt: "/loop watch check" }, h.ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.snapshots().at(-1)!.triggers).toEqual([expect.objectContaining({ name: "watch", kind: "self-paced", nextAt: null })]);
    const restored = await h.restart("reload");
    expect((await restored.runtime.loop({}, restored.ctx)).details).toEqual({ triggers: [] });
    await vi.advanceTimersByTimeAsync(3_600_000); expect(restored.prompts()).toEqual([]);
  });

  it("keeps a pending self-paced iteration on reload", async () => {
    let h = setup(); await h.runtime.loop({ prompt: "watch" }, h.ctx);
    await h.runtime.schedule({ name: "loop", delaySeconds: 60, prompt: "/loop watch" }, h.ctx);
    h = await h.restart("reload"); await vi.advanceTimersByTimeAsync(60_000);
    expect(h.prompts()).toEqual([expect.stringContaining("watch\n")]);
    await vi.advanceTimersByTimeAsync(60_000); expect(h.prompts()).toHaveLength(1);
  });

  it.each([
    { version: 2 }, { triggers: "bad" }, { triggers: [{ ...once, name: "bad name" }] },
    { triggers: Array.from({ length: 21 }, (_, i) => ({ ...once, name: `n${i}` })) }, { triggers: [once, once] },
    { triggers: [{ ...once, tz: "Bad/Zone" }] }, { triggers: [{ ...once, kind: "cron", cron: "invalid" }] },
    { triggers: [{ ...once, kind: "cron", cron: "60 * * * *" }] }, { triggers: [{ ...once, prompt: " /unsafe" }] },
    { triggers: [{ ...once, origin: "unknown" }] }, { triggers: [{ ...once, nextAt: null }] },
    { triggers: [{ ...once, delaySeconds: undefined, at: undefined }] }, { triggers: [{ ...once, at: "2026-10-20T12:01Z" }] },
    { triggers: [{ ...once, delaySeconds: 1 }] }, { triggers: [{ ...once, noop: "bad" }] },
    { triggers: [{ ...once, kind: "interval", interval: "1m", intervalSeconds: 60, anchor: "bad" }] },
  ])("rejects latest malformed snapshot without falling back: %j", async malformed => {
    const data = saved([once]); data.entries.push(entry({ version: 1, sessionId: "test-session", triggers: [once], ...malformed }, "latest"));
    const h = setup(fakeTime(), data); await h.emit("session_start", { reason: "reload" });
    expect(await rows(h)).toEqual([]); expect(h.notifications).toHaveLength(1); expect(h.notifications[0].text).toMatch(/snapshot/i);
    expect(vi.getTimerCount()).toBe(0); expect(h.snapshots()).toHaveLength(2);
  });

  it.each([null, [], "str", undefined, { version: 2 }, { version: 1, sessionId: 5 }].map(data => ({ data })))("does not revive an older snapshot when the latest data is %j", async ({ data: malformed }) => {
    const data = saved([once]);
    data.entries.push(entry(malformed, "latest"));
    data.entries.push(entry({ version: 1, sessionId: "foreign", triggers: [once] }, "foreign"));
    const h = setup(fakeTime(), data);
    await h.emit("session_start", { reason: "reload" });
    expect(await rows(h)).toEqual([]);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].text).toMatch(/snapshot/i);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["Bad/Zone", "", undefined, 5])("skips only an invalid-zone trigger and reports it: %s", async tz => {
    const data = saved([once]);
    data.entries.push(entry({ version: 1, sessionId: "test-session", triggers: [
      { ...once, name: "bad-zone", tz }, { ...once, name: "valid" },
    ] }, "latest"));
    const time = fakeTime();
    const resolveZone = time.resolveTimeZone;
    vi.spyOn(time, "resolveTimeZone").mockImplementation(tz => {
      if (tz === "") throw new Error("Invalid time zone");
      return resolveZone(tz);
    });
    const h = setup(time, data);
    await h.emit("session_start", { reason: "reload" });
    expect(await rows(h)).toEqual([expect.objectContaining({ name: "valid" })]);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].text).toMatch(/bad-zone.*zone/i);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.prompts()).toEqual(["once"]);
  });

  it("rejects other malformed data even on a trigger whose zone is invalid", async () => {
    const data = saved([once]);
    data.entries.push(entry({ version: 1, sessionId: "test-session", triggers: [
      { ...once, name: "valid" }, { ...once, name: "bad-zone", tz: "Bad/Zone", noop: "bad" },
    ] }, "latest"));
    const h = setup(fakeTime(), data);
    await h.emit("session_start", { reason: "reload" });
    expect(await rows(h)).toEqual([]);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].text).toMatch(/snapshot/i);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["0 0 29 2 *", "0 0 30 2 *"])("restores other triggers alongside a cron with no future occurrence: %s", async cron => {
    const time = fakeTime(); const search = vi.spyOn(time, "nextCronAt");
    const old = Date.parse("2096-02-29T00:00Z"); vi.setSystemTime(Date.parse("2096-03-01T00:00Z"));
    const h = setup(time, saved([{ name: "a", kind: "cron", cron, prompt: "last cron", tz: "Test/Zone", origin: "model", nextAt: old }, { ...once, name: "b", nextAt: old }]));
    await h.emit("session_start", { reason: "reload" });
    expect(await rows(h)).toHaveLength(2); expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.prompts()).toEqual([expect.stringContaining("last cron\n")]);
    expect(h.snapshots().at(-1)!.triggers).toEqual([expect.objectContaining({ name: "b" })]);
    expect(h.notifications).toHaveLength(1);
    await h.settleDelivery(); expect(h.prompts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000); expect(h.notifications).toHaveLength(1);
  });

  it.each(["once", "self-paced", "interval", "cron", "interval-advance", "cron-advance"])("saves consumed check or advance failures once: %s", async kind => {
    const time = fakeTime(); time.occurrences.set("0 8 * * *", [NOW + 60_000, NOW + 120_000]);
    const anchor = kind === "interval-advance" ? 8.64e15 - 90_000 : NOW;
    vi.setSystemTime(anchor);
    const h = setup(time); h.setIdle(false);
    if (kind === "once") await h.runtime.schedule({ delaySeconds: 60, prompt: "fire" }, h.ctx);
    else await h.runtime.loop({ prompt: "fire", ...(kind.startsWith("cron") ? { cron: "0 8 * * *" } : kind.startsWith("interval") ? { interval: "1m" } : {}) }, h.ctx);
    expect(h.snapshots()).toHaveLength(1);
    if (kind === "cron-advance") time.occurrences.clear();
    h.ctx.mode = "print"; h.setIdle(true); vi.setSystemTime(anchor + 60_000); await vi.advanceTimersToNextTimerAsync();
    expect(h.snapshots()).toHaveLength(2); expect(h.notifications).toHaveLength(1); expect(h.prompts()).toEqual([]);
    if (kind === "interval-advance") {
      expect(h.notifications[0].text).toContain("Cannot advance interval");
      expect(h.snapshots().at(-1)!.triggers).toEqual([]);
    }
    await vi.advanceTimersByTimeAsync(10_000); expect(h.snapshots()).toHaveLength(2); expect(h.notifications).toHaveLength(1);
  });

  it.each(["once", "cron", "self-paced", "check-and-write", "advance-and-write"])("does not retry a failed fire snapshot: %s", async kind => {
    const time = fakeTime(); time.occurrences.set("0 8 * * *", [NOW + 60_000, NOW + 120_000]);
    let h = setup(time); h.setIdle(false);
    if (kind === "once" || kind === "check-and-write") await h.runtime.schedule({ delaySeconds: 60, prompt: "fire" }, h.ctx);
    else await h.runtime.loop({ prompt: "fire", ...(kind === "cron" || kind === "advance-and-write" ? { cron: "0 8 * * *" } : {}) }, h.ctx);
    expect(h.snapshots()).toHaveLength(1);
    h.appendEntry.mockImplementation(() => { throw new Error("disk full"); });
    if (kind === "check-and-write") h.ctx.mode = "print";
    if (kind === "advance-and-write") time.occurrences.clear();
    h.setIdle(true); vi.setSystemTime(NOW + 60_000); await vi.advanceTimersToNextTimerAsync();
    expect(h.prompts()).toEqual([]); expect(h.notifications).toHaveLength(1); expect(h.notifications[0].text).toContain("disk full");
    if (kind === "check-and-write") expect(h.notifications[0].text).toContain("print run");
    if (kind === "advance-and-write") expect(h.notifications[0].text).toContain("No cron occurrence");
    expect(h.appendEntry).toHaveBeenCalledTimes(2);
    h.ctx.mode = "tui";
    expect(await rows(h)).toEqual(kind === "self-paced" ? [expect.objectContaining({ nextAt: null })] : kind === "cron" ? [expect.objectContaining({ nextAt: NOW + 120_000 })] : []);
    await vi.advanceTimersByTimeAsync(10_000); expect(h.appendEntry).toHaveBeenCalledTimes(2); expect(h.notifications).toHaveLength(1);
    // Failed storage cannot guarantee exactly once across restart: the older durable snapshot remains.
    h = await h.restart("reload"); expect(await rows(h)).toHaveLength(1);
  });

  it.each(["create", "replace", "stop", "cancel", "rearm"])("keeps definition changes in memory when snapshot writes fail: %s", async op => {
    const h = setup(); h.setIdle(false);
    if (op === "stop" || op === "rearm") await h.runtime.loop({ name: "target", prompt: "watch" }, h.ctx);
    else if (op !== "create") await h.runtime.schedule({ name: "target", delaySeconds: 60, prompt: "old" }, h.ctx);
    const before = h.snapshots().length; expect(before).toBe(op === "create" ? 0 : 1);
    const append = h.appendEntry.getMockImplementation()!;
    h.appendEntry.mockImplementation(() => { throw new Error("disk full"); });
    const result = op === "stop" ? await h.runtime.loop({ name: "target", stop: true }, h.ctx)
      : await h.runtime.schedule({ name: "target", ...(op === "cancel" ? { stop: true } : { delaySeconds: 120, prompt: op === "rearm" ? "/loop watch" : "new" }) }, h.ctx);
    expect(result.text).toContain("disk full"); expect(result.details.warning).toContain("disk full"); expect(h.notifications).toHaveLength(1);
    expect(result.details).toMatchObject(op === "stop" ? { stopped: true } : op === "cancel" ? { cancelled: true } : { delaySeconds: 120, noop: false });
    const retained = await rows(h);
    expect(retained).toEqual(op === "stop" || op === "cancel" ? [] : [expect.objectContaining({ name: "target", nextAt: NOW + 120_000 })]);
    await vi.advanceTimersByTimeAsync(10_000); expect(h.snapshots()).toHaveLength(before); expect(h.notifications).toHaveLength(1);
    expect(h.appendEntry).toHaveBeenCalledTimes(before + 1);
    h.appendEntry.mockImplementation(append);
    await h.runtime.schedule({ name: "other", delaySeconds: 60, prompt: "other" }, h.ctx);
    expect(h.snapshots()).toHaveLength(before + 1);
    expect(h.snapshots().at(-1)!.triggers).toHaveLength(op === "stop" || op === "cancel" ? 1 : 2);
  });

  it.each([false, true])("saves advance-only removal before final delivery, writeFails=%s", async writeFails => {
    const time = fakeTime(); time.occurrences.set("0 8 * * *", [NOW + 60_000]);
    const h = setup(time); await h.runtime.loop({ cron: "0 8 * * *", prompt: "last" }, h.ctx);
    expect(h.snapshots()).toHaveLength(1);
    const append = h.appendEntry.getMockImplementation()!;
    h.appendEntry.mockImplementation((type, data) => {
      expect(h.prompts()).toEqual([]); expect((data as TriggerSnapshot).triggers).toEqual([]);
      if (writeFails) throw new Error("disk full"); append(type, data);
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.prompts()).toEqual(writeFails ? [] : ["last"]); expect(h.notifications).toHaveLength(1);
    expect(h.snapshots()).toHaveLength(writeFails ? 1 : 2);
    await vi.advanceTimersByTimeAsync(10_000); expect(h.appendEntry).toHaveBeenCalledTimes(2); expect(h.notifications).toHaveLength(1);
  });

  it("drops an interval first prompt still waiting at reload", async () => {
    let h = setup(); h.setIdle(false); await h.runtime.loop({ interval: "1m", prompt: "first" }, h.ctx);
    h = await h.restart("reload"); await vi.advanceTimersByTimeAsync(59_999); expect(h.prompts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); expect(h.prompts()).toEqual(["first"]);
  });

  it("allows fresh calls after shutdown without reviving old timers", async () => {
    const h = setup(); await h.runtime.schedule({ delaySeconds: 60, prompt: "old" }, h.ctx);
    await h.emit("session_shutdown"); expect(vi.getTimerCount()).toBe(0); expect(h.snapshots()).toHaveLength(1);
    await h.runtime.schedule({ delaySeconds: 120, prompt: "fresh" }, h.ctx);
    await vi.advanceTimersByTimeAsync(60_000); expect(h.prompts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000); expect(h.prompts()).toEqual(["fresh"]);
  });
});
