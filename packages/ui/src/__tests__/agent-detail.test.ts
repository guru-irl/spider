import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { AgentDetail } from "../agents/agent-detail";
import * as conversation from "../agents/detail-conversation";
import type { AgentSnapshot, StoredRunEvent, ThemeAdapter } from "../agents/types";
import { plainTheme, snapshot, storedEvent } from "./fixtures/agent-detail";

function run(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return snapshot({ name: "critic", role: "reviewer", model: "fixture-model", thinking: "high", phase: "review",
    stepCount: 4, tokenCount: 88, startedAt: 0, task: "Inspect the change", ...overrides });
}

function makeDetail(
  agent: AgentSnapshot | undefined = run(), events: readonly StoredRunEvent[] = [],
  height = 30, now: () => number = () => 1000, theme: ThemeAdapter = plainTheme,
) {
  const viewport = { height };
  const requestRender = vi.fn();
  const detail = new AgentDetail("r1", theme, { viewport: () => ({ safeHeight: viewport.height }), requestRender, now });
  detail.update({ kind: "loaded", run: agent, events });
  return { detail, viewport, requestRender };
}

const strip = (line: string) => stripTerminalSequences(line);
const text = (lines: string[]) => lines.map(strip).join("\n");
const conversationText = (lines: string[]) => text(lines.slice(6, -2));
const numberedEvents = (count: number) => Array.from({ length: count }, (_, i) => storedEvent(i + 1, `message-${String(i).padStart(3, "0")}`));

describe("AgentDetail bounded rendering", () => {
  it("renders the newest conversation in exactly the safe height", () => {
    const event = storedEvent(1, Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n"));
    const { detail } = makeDetail(run(), [event], 30);
    const lines = detail.render(96);
    expect(lines).toHaveLength(30);
    expect(strip(lines[0]!)).toContain("critic");
    expect(strip(lines[0]!)).toContain("running");
    expect(strip(lines[29]!)).toContain("╯");
    expect(conversationText(lines)).toContain("line-199");
    expect(lines.every(line => visibleWidth(line) === 96)).toBe(true);
  });

  it("keeps metadata in four rows and reserves the actual status in a long title", () => {
    const agent = run({ name: "a very long agent name ".repeat(8), task: "alpha \n   beta ".repeat(30), costText: "$1.23" });
    const { detail } = makeDetail(agent);
    const lines = detail.render(60);
    expect(strip(lines[0]!)).toContain("running");
    expect(strip(lines[0]!)).toContain("…");
    expect(lines.every(line => visibleWidth(line) <= 60)).toBe(true);
    const header = lines.slice(1, 5).map(strip);
    expect(header[0]).toContain("fixture-model");
    expect(header[0]).toContain("reviewer");
    expect(header[0]).toContain("high");
    expect(header[0]).toContain("4 turns");
    expect(header[1]).toContain("88 tokens");
    expect(header[1]).toContain("$1.23");
    expect(header[1]).toContain("1s");
    expect(header[2]).toContain("r1");
    expect(header[3]).toContain("alpha beta");
    expect(header[3]).toContain("…");
    expect(strip(lines[5]!)).toContain("├");
    detail.updateRun(run({ model: undefined, task: undefined }));
    const missing = detail.render(60);
    expect(strip(missing[1]!)).toContain("unknown");
    expect(strip(missing[4]!)).toContain("No instructions");
    expect(missing).toHaveLength(30);
  });

  it("reaches long messages, history, warnings, tool times and activity by scrolling", () => {
    const notice = "thinking capped: requested max, model supports up to xhigh; using xhigh";
    const events: StoredRunEvent[] = [
      { ...storedEvent(1, notice), type: "warning", payload: { thinkingNotice: true } },
      storedEvent(2, Array.from({ length: 70 }, (_, i) => `long-line-${i}`).join("\n")),
      ...Array.from({ length: 130 }, (_, i) => storedEvent(i + 3, `history-${i}`)),
      { ...storedEvent(133, "result"), type: "tool_result", payload: { durationMs: 750 } },
    ];
    const { detail } = makeDetail(run({ activity: "reading now" }), events, 20);
    detail.render(80);
    detail.scroll(-10000);
    let collected = "";
    for (let i = 0; i < 30; i++) {
      collected += conversationText(detail.render(80)) + "\n";
      detail.scroll(10);
    }
    expect(collected).toContain(notice);
    expect(collected).toContain("long-line-0");
    expect(collected).toContain("long-line-69");
    expect(collected).toContain("history-0");
    expect(collected).toContain("history-129");
    expect(collected).toContain("tool time 750ms");
    expect(collected).toContain("reading now");
  });

  it("shows recorded response and concurrent tool times without summing them", () => {
    const events: StoredRunEvent[] = [
      { ...storedEvent(1, "Report"), payload: { durationMs: 1250 } },
      { ...storedEvent(2, ""), payload: { durationMs: 250 } },
      { ...storedEvent(3, "read a"), type: "tool_result", payload: { durationMs: 800 } },
      { ...storedEvent(4, "read b"), type: "tool_result", payload: { durationMs: 800 } },
      { ...storedEvent(5, "read empty"), type: "tool_result", payload: { durationMs: 0 } },
    ];
    const { detail } = makeDetail(run(), events, 30);
    const lines = detail.render(100), joined = text(lines);
    expect(joined).toContain("response time 1.3s");
    expect(joined).toContain("response time 250ms");
    expect(lines.filter(line => strip(line).includes("tool time 800ms"))).toHaveLength(2);
    expect(joined).toContain("tool time 0ms");
    expect(joined).not.toContain("1.6s");
    expect(strip(lines[1]!)).toContain("4 turns");
    expect(strip(lines[2]!)).toContain("1s");
    for (const width of [30, 60, 100]) {
      expect(detail.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("keeps a long tool result's timing reachable and omits malformed timings", () => {
    const events: StoredRunEvent[] = [
      { ...storedEvent(1, "A long tool result ".repeat(20)), type: "tool_result", payload: { durationMs: 750 } },
      storedEvent(2, "Legacy"),
      ...[undefined, -1, Infinity, "5"].map((durationMs, i) => ({
        ...storedEvent(i + 3, "Legacy tool"), type: "tool_result", payload: { durationMs },
      })),
    ];
    const { detail } = makeDetail(run(), events, 30);
    for (const width of [30, 60, 100]) {
      detail.render(width); detail.scroll(-1000);
      expect(text(detail.render(width))).toContain("tool time 750ms");
    }
    const legacy = makeDetail(run(), events.slice(1), 30).detail;
    const output = text(legacy.render(100));
    expect(output).toContain("Legacy tool");
    expect(output).not.toContain("response time");
    expect(output).not.toContain("tool time");
  });

  it("shows waiting, finished, missing and failed reads without exceeding the frame", () => {
    const { detail } = makeDetail(run(), [], 18);
    expect(text(detail.render(80))).toContain("Waiting for output");
    detail.update({ kind: "loaded", run: run({ status: "done" }), events: [] });
    expect(text(detail.render(80))).toContain("No recorded conversation");
    detail.update({ kind: "loaded", run: undefined, events: [] });
    expect(text(detail.render(80))).toContain("Run not found");
    expect(text(detail.render(80))).toContain("r1");
    // Use a fresh view whose first source read failed.
    const fresh = new AgentDetail("r1", plainTheme, { viewport: () => ({ safeHeight: 18 }), requestRender: () => {} });
    fresh.update({ kind: "failed" });
    expect(text(fresh.render(80))).toContain("Conversation unavailable");
    fresh.update({ kind: "loaded", run: run(), events: [storedEvent(1, "last good history")] });
    fresh.update({ kind: "failed" });
    const failure = fresh.render(80);
    expect(text(failure)).toContain("last good history");
    expect(strip(failure.at(-2)!)).toContain("Conversation unavailable");
    expect(failure).toHaveLength(18);
    fresh.update({ kind: "loaded", run: run(), events: [storedEvent(1, "last good history")] });
    expect(strip(fresh.render(80).at(-2)!)).not.toContain("Conversation unavailable");
  });

  it("keeps unread, read-error and Esc indicators visible at narrow widths", () => {
    const events = numberedEvents(20);
    const { detail } = makeDetail(run(), events, 12);
    detail.render(24); detail.scroll(-1);
    detail.update({ kind: "loaded", run: run(), events: [...events, storedEvent(21, "new")] });
    detail.update({ kind: "failed" });
    const controls = strip(detail.render(24).at(-2)!);
    expect(controls).toContain("↓ 1 new");
    expect(controls).toContain("read err");
    expect(controls).toContain("Esc");
    expect(visibleWidth(controls)).toBeLessThanOrEqual(24);
  });

  it.each(["failed", "cancelled"] as const)("keeps %s run history and actual status", status => {
    const { detail } = makeDetail(run({ status }), [storedEvent(1, "retained history")], 18);
    const kill = vi.fn(); detail.onKill(kill);
    const lines = detail.render(80);
    expect(strip(lines[0]!)).toContain(status);
    expect(conversationText(lines)).toContain("retained history");
    detail.handleInput("k"); detail.handleInput("k");
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("AgentDetail navigation", () => {
  it("moves visual rows with keys and retains unread counts until End", () => {
    const events = numberedEvents(20);
    const { detail, requestRender } = makeDetail(run(), events, 12);
    expect(conversationText(detail.render(60))).toContain("message-016");
    detail.handleInput("\x1b[A");
    expect(conversationText(detail.render(60))).toContain("message-015");
    expect(text(detail.render(60))).toContain("↓ 0 new");
    detail.handleInput("\x1b[5~");
    expect(conversationText(detail.render(60))).toContain("message-012");
    detail.handleInput("\x1b[B");
    expect(conversationText(detail.render(60))).toContain("message-013");
    const more = [...events, storedEvent(21, "new-1"), storedEvent(22, "new-2")];
    detail.update({ kind: "loaded", run: run(), events: more });
    const paused = detail.render(60);
    expect(conversationText(paused)).toContain("message-013");
    expect(text(paused)).toContain("↓ 2 new");
    expect(paused).toHaveLength(12);
    const before = conversationText(paused);
    expect(detail.handleInput("\x1b[D")).toBe(true);
    expect(detail.handleInput("\x1b[C")).toBe(true);
    expect(detail.handleInput("z")).toBe(true);
    expect(conversationText(detail.render(60))).toBe(before);
    detail.handleInput("\x1b[6~");
    expect(conversationText(detail.render(60))).toContain("message-016");
    detail.handleInput("\x1b[F");
    const end = detail.render(60);
    expect(conversationText(end)).toContain("new-2");
    expect(text(end)).not.toContain("↓ 2 new");
    expect(requestRender).toHaveBeenCalled();
  });

  it("clears unread messages when viewport growth reaches the bottom", () => {
    const events = numberedEvents(20);
    const { detail, viewport } = makeDetail(run(), events, 12);
    detail.render(60); detail.scroll(-1);
    detail.update({ kind: "loaded", run: run(), events: [...events, storedEvent(21, "new-1"), storedEvent(22, "new-2")] });
    expect(text(detail.render(60))).toContain("↓ 2 new");
    viewport.height = 15;
    const grown = detail.render(60);
    expect(conversationText(grown)).toContain("new-2");
    expect(text(grown)).not.toContain("↓ 2 new");
    detail.scroll(-1);
    expect(text(detail.render(60))).toContain("↓ 0 new");
  });

  it("keeps a paused source position and unread count through width changes", () => {
    const prose = Array.from({ length: 9 }, (_, i) => String(i).repeat(20)).join("");
    const first = storedEvent(1, prose);
    const { detail } = makeDetail(run(), [first], 10);
    detail.render(34); detail.scroll(-2);
    expect(strip(detail.render(34)[6]!)).toContain("333333");
    detail.update({ kind: "loaded", run: run(), events: [first, storedEvent(2, "new")] });
    expect(text(detail.render(34))).toContain("↓ 1 new");
    expect(strip(detail.render(24)[6]!)).toContain("333333");
    expect(strip(detail.render(44)[6]!)).toContain("333333");
    expect(text(detail.render(44))).toContain("↓ 1 new");
  });

  it("sends Esc to the selector and Ctrl+C to chat without forwarding text", () => {
    const { detail } = makeDetail();
    const back = vi.fn(); detail.onBack(back); detail.render(60);
    expect(detail.handleInput("\u001b")).toBe(true);
    expect(back).toHaveBeenLastCalledWith("selector");
    expect(detail.handleInput("\x03")).toBe(true);
    expect(back).toHaveBeenLastCalledWith("chat");
    expect(detail.handleInput("q")).toBe(true);
  });

  it("consumes wheel movements outside the conversation without scrolling it", () => {
    const { detail } = makeDetail(run(), numberedEvents(20), 12);
    detail.render(60);
    detail.scrollAt(6, -3);
    const paused = conversationText(detail.render(60));
    expect(paused).toContain("message-013");
    detail.scrollAt(2, -3);
    expect(conversationText(detail.render(60))).toBe(paused);
    detail.scrollAt(6, 1);
    expect(conversationText(detail.render(60))).toContain("message-014");
  });

  it("preserves paused position through compact resize and disables kill", () => {
    const { detail, viewport } = makeDetail(run(), numberedEvents(20), 12);
    const kill = vi.fn(); detail.onKill(kill);
    detail.render(60); detail.scroll(-3);
    const before = conversationText(detail.render(60));
    viewport.height = 8;
    const compact = detail.render(60);
    expect(compact).toHaveLength(8);
    expect(text(compact)).toMatch(/larger terminal/i);
    expect(compact.every(line => visibleWidth(line) <= 60)).toBe(true);
    detail.handleInput("k"); detail.handleInput("k");
    expect(kill).not.toHaveBeenCalled();
    viewport.height = 12;
    expect(conversationText(detail.render(60))).toBe(before);
  });

  it("requests safe closure once when a frame is unusable", async () => {
    const { detail, viewport } = makeDetail(run(), [], 2);
    const back = vi.fn(); detail.onBack(back);
    expect(detail.render(60)).toEqual([]);
    expect(detail.render(60)).toEqual([]);
    await Promise.resolve();
    expect(back).toHaveBeenCalledOnce();
    expect(back).toHaveBeenCalledWith("size");
    viewport.height = 12;
    expect(detail.render(2)).toEqual([]);
    await Promise.resolve();
    expect(back).toHaveBeenCalledOnce();
  });
});

describe("AgentDetail cache and basic kill", () => {
  it("does not read or rewrap unchanged history on render, scroll or ticks", () => {
    const wrap = vi.spyOn(conversation, "wrapConversation");
    const reads = vi.fn();
    const events = numberedEvents(15);
    let color = "31";
    let now = 1000;
    const theme: ThemeAdapter = { ...plainTheme, fg: (_token, value) => `\x1b[${color}m${value}\x1b[0m` };
    const { detail } = makeDetail(run(), [], 13, () => now, theme);
    const initial = { kind: "loaded" as const, run: run(), get events() { reads(); return events; } };
    detail.update(initial);
    detail.render(40);
    const readCount = reads.mock.calls.length;
    const wraps = wrap.mock.calls.length;
    detail.render(40); detail.scroll(-3); detail.render(40);
    now = 2000;
    expect(strip(detail.render(40)[2]!)).toContain("2s");
    expect(reads).toHaveBeenCalledTimes(readCount);
    expect(wrap).toHaveBeenCalledTimes(wraps);
    const first = conversationText(detail.render(40)).split("\n")[0]?.replace(/ +│$/, "│");
    const more = [...events, storedEvent(16, "new-one"), storedEvent(17, "new-two")];
    detail.update({ kind: "loaded", run: run(), events: more });
    expect(text(detail.render(40))).toContain("↓ 2 new");
    expect(wrap.mock.calls.length - wraps).toBe(2);
    const oldWraps = wrap.mock.calls.length;
    expect(conversationText(detail.render(48)).split("\n")[0]?.replace(/ +│$/, "│")).toBe(first);
    expect(wrap.mock.calls.length).toBeGreaterThan(oldWraps);
    color = "32"; detail.invalidate();
    const afterTheme = detail.render(48);
    expect(text(afterTheme)).toContain("↓ 2 new");
    expect(conversationText(afterTheme)).toContain("message-007");
    expect(afterTheme.join("")).toContain("\x1b[32m");
    detail.dispose(); wrap.mockRestore();
  });

  it("uses current in-memory credit formatting without rereading or rewrapping history", () => {
    const wrap = vi.spyOn(conversation, "wrapConversation");
    const reads = vi.fn();
    let credit = "60 credits";
    const formatter = vi.fn(() => credit);
    const events = numberedEvents(5);
    const detail = new AgentDetail("r1", plainTheme, { viewport: () => ({ safeHeight: 20 }), requestRender: () => {}, formatRunCost: formatter });
    detail.update({ kind: "loaded", run: run({ usageCosts: [{ provider: "github-copilot", cost: 0.3 }], cost: 0.3 }),
      get events() { reads(); return events; } });
    expect(detail.render(96).join("\n")).toContain("60 credits");
    const readCount = reads.mock.calls.length, wraps = wrap.mock.calls.length;
    credit = "90 credits";
    expect(detail.render(96).join("\n")).toContain("90 credits");
    expect(reads).toHaveBeenCalledTimes(readCount);
    expect(wrap).toHaveBeenCalledTimes(wraps);
    detail.dispose(); wrap.mockRestore();
  });

  it("retains cached credit text when the in-memory formatter fails", () => {
    const formatter = vi.fn(() => { throw new Error("unavailable"); });
    const detail = new AgentDetail("r1", plainTheme, { viewport: () => ({ safeHeight: 20 }), requestRender: () => {}, formatRunCost: formatter });
    detail.update({ kind: "loaded", run: run({ usageCosts: [{ provider: "github-copilot", cost: 0.3 }], costText: "60 credits" }), events: [] });
    expect(detail.render(96).join("\n")).toContain("60 credits");
    detail.updateRun(run({ usageCosts: undefined, costText: "cached" }));
    formatter.mockClear();
    expect(detail.render(96).join("\n")).toContain("cached");
    expect(formatter).not.toHaveBeenCalled();
    detail.dispose();
  });

  it("rewraps only a changed activity when metadata changes", () => {
    const wrap = vi.spyOn(conversation, "wrapConversation");
    const events = numberedEvents(5);
    const { detail } = makeDetail(run(), events, 20);
    detail.render(60);
    const before = wrap.mock.calls.length;
    detail.updateRun(run({ activity: "reading" }));
    expect(text(detail.render(60))).toContain("reading");
    expect(wrap.mock.calls.length - before).toBe(1);
    const afterActivity = wrap.mock.calls.length;
    detail.updateRun(run({ activity: "reading", stepCount: 6 }));
    detail.render(60);
    expect(wrap).toHaveBeenCalledTimes(afterActivity);
    detail.dispose(); wrap.mockRestore();
  });

  it("requires two fresh kill presses and disarms on another key or expiry", () => {
    let now = 1000;
    const { detail } = makeDetail(run(), [], 20, () => now);
    const kill = vi.fn(); detail.onKill(kill); detail.render(60);
    detail.handleInput("k");
    expect(text(detail.render(60))).toContain("k again to kill");
    expect(kill).not.toHaveBeenCalled();
    detail.handleInput("j"); detail.handleInput("k");
    expect(kill).not.toHaveBeenCalled();
    now = 2000; detail.handleInput("k");
    expect(kill).toHaveBeenCalledExactlyOnceWith("r1");
    detail.handleInput("k"); now = 6001; detail.handleInput("k");
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("disarms when a run ends", () => {
    const { detail } = makeDetail(run(), [], 20);
    const kill = vi.fn(); detail.onKill(kill); detail.render(60);
    detail.handleInput("k");
    detail.updateRun(run({ status: "done" }));
    expect(text(detail.render(60))).not.toContain("k again to kill");
    detail.handleInput("k");
    expect(kill).not.toHaveBeenCalled();
    expect(text(detail.render(60))).not.toContain("k again to kill");
  });
});

describe("AgentDetail asynchronous kill", () => {
  it.each([[2999, 1], [3000, 0], [3001, 0]])("accepts a second press at %s ms only before expiry", (elapsed, expected) => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      const { detail } = makeDetail(run(), [], 20, Date.now);
      const kill = vi.fn(); detail.onKill(kill); detail.render(96);
      detail.handleInput("k");
      expect(kill).not.toHaveBeenCalled();
      expect(text(detail.render(96))).toContain("k again to kill");
      vi.advanceTimersByTime(elapsed);
      detail.handleInput("k");
      expect(kill).toHaveBeenCalledTimes(expected);
      if (expected) expect(kill).toHaveBeenCalledWith("r1");
      else expect(text(detail.render(96))).toContain("k again to kill");
      detail.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("checks the exact deadline even if its timer callback has not run", () => {
    vi.useFakeTimers();
    try {
      let now = 100;
      const { detail } = makeDetail(run(), [], 20, () => now);
      const kill = vi.fn(); detail.onKill(kill); detail.render(96);
      detail.handleInput("k"); now = 3100; detail.handleInput("k");
      expect(kill).not.toHaveBeenCalled();
      expect(text(detail.render(96))).toContain("k again to kill");
      detail.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("disarms when a completed run arrives in a full snapshot", () => {
    const { detail } = makeDetail(run(), [], 20);
    const kill = vi.fn(); detail.onKill(kill); detail.render(96);
    detail.handleInput("k");
    detail.update({ kind: "loaded", run: run({ status: "done" }), events: [] });
    expect(text(detail.render(96))).not.toContain("k again to kill");
    detail.handleInput("k"); expect(kill).not.toHaveBeenCalled();
    detail.dispose();
  });

  it("repaints when the one-shot arm expires and cancels the timer on disposal", () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      const { detail, requestRender } = makeDetail(run(), [], 20, Date.now);
      detail.onKill(vi.fn()); detail.render(96); detail.handleInput("k");
      requestRender.mockClear();
      vi.advanceTimersByTime(3000);
      expect(requestRender).toHaveBeenCalledOnce();
      expect(text(detail.render(96))).not.toContain("k again to kill");
      detail.handleInput("k");
      expect(vi.getTimerCount()).toBe(1);
      detail.dispose();
      expect(vi.getTimerCount()).toBe(0);
      requestRender.mockClear(); vi.advanceTimersByTime(3000);
      expect(requestRender).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("disarms on other keys and wheel input but not on live data updates", () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      const events = numberedEvents(20), { detail } = makeDetail(run(), events, 12, Date.now);
      const kill = vi.fn(); detail.onKill(kill); detail.render(60);
      detail.handleInput("k");
      detail.update({ kind: "loaded", run: run(), events: [...events, storedEvent(21, "new")] });
      expect(text(detail.render(60))).toContain("k again to kill");
      expect(kill).not.toHaveBeenCalled();
      detail.handleInput("x");
      expect(text(detail.render(60))).not.toContain("k again to kill");
      detail.handleInput("k"); detail.scrollAt(2, -3);
      expect(text(detail.render(60))).not.toContain("k again to kill");
      detail.handleInput("k");
      expect(kill).not.toHaveBeenCalled();
      detail.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("keeps the unread marker, confirmation and Esc in the fixed controls", () => {
    const events = numberedEvents(20), { detail } = makeDetail(run(), events, 12);
    detail.onKill(vi.fn()); detail.render(60); detail.scroll(-1);
    detail.update({ kind: "loaded", run: run(), events: [...events, storedEvent(21, "a"), storedEvent(22, "b")] });
    const before = detail.render(60);
    detail.handleInput("k");
    const armed = detail.render(60), controls = strip(armed.at(-2)!);
    expect(controls).toContain("↓ 2 new");
    expect(controls).toContain("k again to kill");
    expect(controls).toContain("Esc");
    expect(armed).toHaveLength(before.length);
    expect(conversationText(armed)).toBe(conversationText(before));
    detail.dispose();
  });

  it("does not arm when narrow paused controls cannot show confirmation", () => {
    const events = numberedEvents(20), { detail } = makeDetail(run(), events, 12);
    const kill = vi.fn(); detail.onKill(kill); detail.render(24); detail.scroll(-1);
    detail.update({ kind: "loaded", run: run(), events: [...events, storedEvent(21, "a"), storedEvent(22, "b")] });
    detail.render(24); detail.handleInput("k"); detail.handleInput("k");
    const paused = strip(detail.render(24).at(-2)!);
    expect(paused).toContain("↓ 2 new"); expect(paused).toContain("Esc");
    expect(paused).not.toContain("k again to kill"); expect(kill).not.toHaveBeenCalled();
    detail.handleInput("\x1b[F"); detail.render(24); detail.handleInput("k");
    expect(strip(detail.render(24).at(-2)!)).toContain("k again to kill");
    expect(strip(detail.render(24).at(-2)!)).toContain("Esc");
    detail.dispose();
  });

  it("disarms when a resize would hide a paused confirmation", () => {
    const events = numberedEvents(20), { detail } = makeDetail(run(), events, 12);
    const kill = vi.fn(); detail.onKill(kill); detail.render(60); detail.scroll(-1);
    detail.update({ kind: "loaded", run: run(), events: [...events, storedEvent(21, "a"), storedEvent(22, "b")] });
    detail.render(60); detail.handleInput("k");
    expect(text(detail.render(60))).toContain("k again to kill");
    const narrow = strip(detail.render(24).at(-2)!);
    expect(narrow).toContain("↓ 2 new"); expect(narrow).toContain("Esc");
    detail.render(60); detail.handleInput("k");
    expect(kill).not.toHaveBeenCalled();
    expect(text(detail.render(60))).toContain("k again to kill");
    detail.handleInput("k"); expect(kill).toHaveBeenCalledOnce();
    detail.dispose();
  });

  it("sanitizes terminal controls in a kill failure", () => {
    const { detail } = makeDetail(run(), [], 20);
    detail.onKill(() => detail.setKillPending()); detail.render(96);
    detail.handleInput("k"); detail.handleInput("k");
    detail.setKillError("denied \u001b[31mred\u001b[0m\nagain");
    const rendered = detail.render(96).join("\n");
    expect(rendered).toContain("denied red again");
    expect(rendered).not.toContain("\u001b");
    detail.dispose();
  });

  it("shows pending and failure, ignores repeated presses, and requires two fresh retry presses", () => {
    const { detail } = makeDetail(run(), [], 20);
    const kill = vi.fn(() => detail.setKillPending());
    const back = vi.fn(); detail.onBack(back); detail.onKill(kill); detail.render(96);
    detail.handleInput("k"); detail.handleInput("k");
    expect(kill).toHaveBeenCalledExactlyOnceWith("r1");
    expect(text(detail.render(96))).toContain("Stopping");
    detail.handleInput("k"); detail.handleInput("k");
    expect(kill).toHaveBeenCalledTimes(1);
    detail.handleInput("\u001b"); expect(back).toHaveBeenCalledWith("selector");
    detail.setKillError("permission denied");
    expect(text(detail.render(96))).toContain("permission denied");
    detail.handleInput("k"); expect(kill).toHaveBeenCalledTimes(1);
    detail.handleInput("k"); expect(kill).toHaveBeenCalledTimes(2);
    detail.dispose();
  });

  it("never arms an unavailable, missing, ended or compact run", () => {
    const missingAction = makeDetail().detail; missingAction.render(96);
    missingAction.handleInput("k");
    expect(text(missingAction.render(96))).not.toContain("k again to kill");
    missingAction.handleInput("k");
    expect(text(missingAction.render(96))).not.toContain("k again to kill");
    const { detail, viewport } = makeDetail(run(), [], 20);
    const kill = vi.fn(); detail.onKill(kill); detail.render(96); detail.handleInput("k");
    viewport.height = 8; detail.render(96); detail.handleInput("k"); detail.handleInput("k");
    viewport.height = 20; detail.render(96);
    expect(text(detail.render(96))).not.toContain("k again to kill");
    detail.update({ kind: "loaded", run: undefined, events: [] });
    detail.handleInput("k"); detail.handleInput("k");
    detail.update({ kind: "loaded", run: run({ status: "done" }), events: [] });
    detail.handleInput("k"); detail.handleInput("k");
    expect(kill).not.toHaveBeenCalled();
    detail.dispose(); missingAction.dispose();
  });
});
