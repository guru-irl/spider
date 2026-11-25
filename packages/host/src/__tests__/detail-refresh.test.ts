import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDetail, type AgentSnapshot, type DetailRead, type RunEvent, type RunRow, type RunSource, type StoredRunEvent } from "@spider/ui";
import { startDetailRefresh } from "../agents/detail-refresh";
import { plainTheme, snapshot, storedEvent } from "../../../ui/src/__tests__/fixtures/agent-detail";

class PassiveStore {
  current: AgentSnapshot[];
  listeners = new Set<() => void>();
  lastListener?: () => void;
  constructor(initial: AgentSnapshot[]) { this.current = initial; }
  snapshot = vi.fn(() => [...this.current]);
  onChange = vi.fn((fn: () => void) => {
    this.lastListener = fn; this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  });
  change(next: AgentSnapshot[]): void { this.current = next; for (const fn of [...this.listeners]) fn(); }
}

class SourceFixture implements RunSource {
  row: RunRow | undefined = { id: "r1", session_id: "s", agent: "worker", name: "alpha", status: "running",
    step_count: 1, token_count: 100, started_at: 0, cost: 0.3, usageCosts: [{ provider: "github-copilot", cost: 0.3 }] };
  events: StoredRunEvent[] = [storedEvent(1, "first")];
  failRow = false;
  failEvents = false;
  readTimes: number[] = [];
  listeners = new Set<(event: RunEvent) => void>();
  lastListener?: (event: RunEvent) => void;
  listActive = vi.fn(() => []);
  getRun = vi.fn((_id: string) => {
    this.readTimes.push(Date.now());
    if (this.failRow) throw new Error("row unavailable");
    return this.row;
  });
  listEvents = vi.fn((_id: string) => {
    if (this.failEvents) throw new Error("events unavailable");
    return [...this.events];
  });
  subscribe = vi.fn((fn: (event: RunEvent) => void) => {
    this.lastListener = fn; this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  });
  emit(runId = "r1"): void {
    for (const fn of [...this.listeners]) fn({ runId, sessionId: "s", ts: Date.now(), type: "message" });
  }
}

const run = (overrides: Partial<AgentSnapshot> = {}) => snapshot({
  runId: "r1", name: "alpha", status: "running", startedAt: 0,
  usageCosts: [{ provider: "github-copilot", cost: 0.3 }], ...overrides,
});
const asStore = (store: PassiveStore) => store as unknown as import("@spider/ui").AgentStore;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("detail refresh", () => {
  it("loads once and coalesces selected invalidations into trailing 100ms reads", () => {
    const source = new SourceFixture(), store = new PassiveStore([run()]);
    const apply = vi.fn(), applyRun = vi.fn(), repaint = vi.fn();
    const stop = startDetailRefresh({ source, store: asStore(store), runId: "r1", apply, applyRun, requestRender: repaint });
    expect(source.readTimes).toEqual([0]);
    source.emit();
    vi.advanceTimersByTime(10); source.emit();
    vi.advanceTimersByTime(89); source.emit();
    expect(source.readTimes).toEqual([0]);
    vi.advanceTimersByTime(1);
    expect(source.readTimes).toEqual([0, 100]);
    vi.advanceTimersByTime(50); source.emit();
    vi.advanceTimersByTime(99); expect(source.readTimes).toEqual([0, 100]);
    vi.advanceTimersByTime(1);
    expect(source.readTimes).toEqual([0, 100, 250]);
    expect(source.getRun).toHaveBeenCalledTimes(3);
    expect(source.listEvents).toHaveBeenCalledTimes(3);
    expect(apply).toHaveBeenCalledTimes(3);
    source.emit("other"); vi.advanceTimersByTime(500);
    expect(source.readTimes).toEqual([0, 100, 250]);
    stop();
  });

  it("applies selected metadata immediately, retains evicted data, and formats current costs", () => {
    const source = new SourceFixture(), current = run({ activity: "reading" });
    const store = new PassiveStore([current]);
    const apply = vi.fn(), applyRun = vi.fn(), repaint = vi.fn();
    let credit = "60 credits";
    const stop = startDetailRefresh({ source, store: asStore(store), runId: "r1", apply, applyRun, requestRender: repaint,
      formatRunCost: () => credit });
    expect(apply.mock.calls[0]![0]).toMatchObject({ kind: "loaded", run: { runId: "r1", activity: "reading", costText: "60 credits" } });
    applyRun.mockClear(); repaint.mockClear();
    const completed = run({ status: "done", activity: "finished" });
    credit = "90 credits"; store.change([completed]);
    expect(applyRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: "r1", status: "done", costText: "90 credits" }));
    expect(repaint).toHaveBeenCalled();
    expect(source.getRun).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(source.getRun).toHaveBeenCalledTimes(2);
    applyRun.mockClear();
    const lastGood = apply.mock.calls.at(-1)![0];
    const applied = apply.mock.calls.length;
    store.change([]);
    expect(applyRun).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(applied);
    expect(apply).toHaveBeenLastCalledWith(lastGood);
    expect(source.getRun).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(100);
    expect(source.getRun).toHaveBeenCalledTimes(3);
    expect(apply.mock.calls.at(-1)![0]).toMatchObject({ kind: "loaded", run: { runId: "r1" } });
    stop();
  });

  it("disarms a completed run before its coalesced history read", () => {
    const source = new SourceFixture(), store = new PassiveStore([run()]);
    const repaint = vi.fn(), kill = vi.fn();
    const view = new AgentDetail("r1", plainTheme, { viewport: () => ({ safeHeight: 20 }), requestRender: repaint });
    view.onKill(kill);
    const stop = startDetailRefresh({ source, store: asStore(store), runId: "r1", apply: read => view.update(read),
      applyRun: value => view.updateRun(value), requestRender: repaint });
    view.render(96); view.handleInput("k");
    expect(view.render(96).join("\n")).toContain("k again to kill");
    store.change([run({ status: "done" })]);
    expect(view.render(96).join("\n")).not.toContain("k again to kill");
    view.handleInput("k");
    expect(kill).not.toHaveBeenCalled();
    expect(source.getRun).toHaveBeenCalledTimes(1);
    stop(); view.dispose();
  });

  it("does not requery history for unrelated store changes or duplicate notifications", () => {
    const source = new SourceFixture(), selected = run(), store = new PassiveStore([selected, run({ runId: "r2" })]);
    const apply = vi.fn(), applyRun = vi.fn();
    const stop = startDetailRefresh({ source, store: asStore(store), runId: "r1", apply, applyRun, requestRender: () => {} });
    store.change([selected, run({ runId: "r2", activity: "other" })]);
    vi.advanceTimersByTime(500);
    expect(source.getRun).toHaveBeenCalledTimes(1);
    expect(applyRun).not.toHaveBeenCalled();
    source.emit(); source.emit(); source.emit(); vi.advanceTimersByTime(100);
    expect(source.listEvents).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls.at(-1)![0].events).toEqual([storedEvent(1, "first")]);
    stop();
  });

  it("reports an initial failure and a missing first run without partial snapshots", () => {
    const source = new SourceFixture(), store = new PassiveStore([run()]), apply = vi.fn();
    source.failRow = true;
    const stop = startDetailRefresh({ source, store: asStore(store), runId: "r1", apply, applyRun: () => {}, requestRender: () => {} });
    expect(apply).toHaveBeenLastCalledWith({ kind: "failed" });
    source.failRow = false; source.row = undefined; source.emit(); vi.advanceTimersByTime(100);
    expect(apply).toHaveBeenLastCalledWith({ kind: "loaded", run: undefined, events: source.events });
    stop();
  });

  it("preserves paused history and unread identity through failed reads and recovery", () => {
    const source = new SourceFixture(), store = new PassiveStore([run()]);
    source.events = Array.from({ length: 20 }, (_, i) => storedEvent(i + 1, `line-${i}`));
    const view = new AgentDetail("r1", plainTheme, { viewport: () => ({ safeHeight: 12 }), requestRender: () => {} });
    const back = vi.fn(); view.onBack(back);
    const stop = startDetailRefresh({ source, store: asStore(store), runId: "r1", apply: read => view.update(read),
      applyRun: value => view.updateRun(value), requestRender: () => {} });
    view.render(60); view.scroll(-1);
    source.events.push(storedEvent(21, "new-1")); source.emit(); vi.advanceTimersByTime(100);
    const before = view.render(60).slice(6, -2).join("\n");
    expect(view.render(60).join("\n")).toContain("↓ 1 new");
    source.failEvents = true; source.emit(); vi.advanceTimersByTime(100);
    expect(view.render(60).slice(6, -2).join("\n")).toBe(before);
    expect(view.render(60).join("\n")).toContain("↓ 1 new");
    expect(view.render(60).join("\n")).toContain("Conversation unavailable");
    source.failEvents = false; source.events.push(storedEvent(22, "new-2")); source.emit(); vi.advanceTimersByTime(100);
    expect(view.render(60).slice(6, -2).join("\n")).toBe(before);
    expect(view.render(60).join("\n")).toContain("↓ 2 new");
    expect(view.render(60).join("\n")).not.toContain("Conversation unavailable");
    view.handleInput("\u001b"); expect(back).toHaveBeenCalledWith("selector");
    stop(); view.dispose();
  });

  it("lets navigation and resize repaint immediately while data is pending", () => {
    const source = new SourceFixture(), store = new PassiveStore([run()]), repaint = vi.fn();
    source.events = Array.from({ length: 20 }, (_, i) => storedEvent(i + 1, `line-${i}`));
    let height = 12;
    const view = new AgentDetail("r1", plainTheme, { viewport: () => ({ safeHeight: height }), requestRender: repaint, now: Date.now });
    const stop = startDetailRefresh({ source, store: asStore(store), runId: "r1", apply: read => view.update(read),
      applyRun: value => view.updateRun(value), requestRender: repaint });
    view.render(60); source.emit(); repaint.mockClear();
    view.scroll(-1);
    expect(repaint).toHaveBeenCalled();
    height = 14; view.render(60);
    vi.advanceTimersByTime(50); view.render(60);
    expect(source.getRun).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(source.getRun).toHaveBeenCalledTimes(2);
    stop(); view.dispose();
  });

  it("disposes pending work and subscriptions, including late stale callbacks", () => {
    const source = new SourceFixture(), store = new PassiveStore([run()]), apply = vi.fn(), applyRun = vi.fn();
    const stop = startDetailRefresh({ source, store: asStore(store), runId: "r1", apply, applyRun, requestRender: () => {} });
    source.emit(); stop(); stop();
    expect(source.listeners.size).toBe(0);
    expect(store.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    source.lastListener?.({ runId: "r1", sessionId: "s", ts: 1, type: "message" });
    store.current = [run({ status: "done" })];
    store.lastListener?.();
    expect(vi.getTimerCount()).toBe(0);
    expect(applyRun).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(source.getRun).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("can dispose from inside a scheduled apply callback", () => {
    const source = new SourceFixture(), store = new PassiveStore([run()]);
    let stop = () => {};
    let calls = 0;
    stop = startDetailRefresh({ source, store: asStore(store), runId: "r1", apply: (_read: DetailRead) => {
      calls++; if (calls === 2) stop();
    }, applyRun: () => {}, requestRender: () => {} });
    source.emit(); vi.advanceTimersByTime(100);
    source.emit(); vi.advanceTimersByTime(500);
    expect(calls).toBe(2);
    expect(source.getRun).toHaveBeenCalledTimes(2);
    expect(source.listeners.size).toBe(0);
  });
});
