import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { mountUsage } from "../mount.js";
import type { UsageRuntime } from "../runtime.js";
import type { UsageRuntimeSnapshot } from "../protocol.js";
import * as pricing from "../price.js";
vi.mock("../ledger.js", () => ({ openUsageLedger: () => { throw new Error("main-thread ledger open forbidden"); } }));
const config = { footer: true, counterPoll: true, alertsSessionCredits: 0, alertsRunCredits: 0 };
const stamp = "2026-10-04T12:00:00.000Z";
const usage = (input: number) => ({ input, output: 10, cacheRead: 20, cacheWrite: 0, totalTokens: input + 30, cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } });
const assistant = (id: string, input: number) => ({ type: "message", id, parentId: null, timestamp: stamp, message: { role: "assistant", content: [], api: "openai-responses", provider: "github-copilot", model: "gpt-6.1-sol", usage: usage(input), stopReason: "stop", timestamp: Date.parse(stamp) } });
const generic = (type: string, id: string, input: number) => ({ type, id, parentId: null, timestamp: stamp, kind: "cache_warm", provider: "github-copilot", model: "gpt-6.1-sol", usage: usage(input) });
type Footer = Component & { dispose?(): void };
function fixture(mode: ExtensionContext["mode"] = "tui") {
  let entries: unknown[] = [assistant("a", 100)]; let file = "fixture-a.jsonl";
  const events = new Map<string, Set<(event: unknown, ctx: ExtensionContext) => void>>();
  let footer: Footer | undefined;
  const unsubBranch = vi.fn(); const requestRender = vi.fn();
  const theme = { fg: (_name: string, text: string) => text } as Theme;
  const data: ReadonlyFooterDataProvider = { getGitBranch: () => "fixture", getExtensionStatuses: () => new Map([["fixture", "status"]]), getAvailableProviderCount: () => 1, onBranchChange: () => unsubBranch };
  const setFooter = vi.fn((factory: Parameters<ExtensionContext["ui"]["setFooter"]>[0]) => {
    footer?.dispose?.(); footer = factory?.({ requestRender } as unknown as TUI, theme, data);
  });
  const getEntries = vi.fn(() => [...entries]); const getBranch = vi.fn(() => entries.slice(0, 1));
  const registry = { getProvider: vi.fn(() => ({ auth: { oauth: { isSubscription: true } } })), isUsingOAuth: vi.fn(() => true) };
  const ctx = { mode, hasUI: mode === "tui" || mode === "rpc", cwd: "/fixture/project", sessionManager: { getEntries, getBranch, getSessionFile: () => file, getSessionId: () => file }, ui: { setFooter, setWidget: vi.fn(), notify: vi.fn() }, model: { id: "gpt-6.1-sol", provider: "github-copilot", contextWindow: 100000, reasoning: true }, modelRegistry: registry, getContextUsage: vi.fn(() => ({ percent: 25, tokens: 25000, contextWindow: 100000 })), thinkingLevel: "high" } as unknown as ExtensionContext;
  const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
    if (!events.has(name)) events.set(name, new Set()); events.get(name)!.add(handler);
    return () => events.get(name)?.delete(handler);
  }, getSessionName: () => "fixture name", getThinkingLevel: () => "high" } as unknown as ExtensionAPI;
  let snapshot: UsageRuntimeSnapshot = { health: null, counter: null, reconciliation: null, backfill: "pending", errorCode: null };
  const runtime = { snapshot: () => snapshot, configure: vi.fn(), refresh: vi.fn() } as unknown as UsageRuntime;
  return { pi, ctx, runtime, setFooter, getEntries, getBranch, registry, unsubBranch, requestRender,
    append: (entry: unknown) => entries.push(entry), replace: (next: unknown[], nextFile = file) => { entries = next; file = nextFile; },
    counter: (creditsUsed: number, ts = 100) => { snapshot = { ...snapshot, counter: { availability: "available", role: "owner", lastAttemptAt: ts, lastSuccessAt: ts, nextPollAt: ts + 600000, snapshotAgeMs: 0, errorCode: null, notice: null, latest: { creditsUsed, entitlement: 100, ts, raw: {} } } }; },
    failWorker: () => { snapshot = { ...snapshot, errorCode: "usage-worker-failed" }; },
    emit: (name: string, event: unknown = {}) => { for (const handler of [...events.get(name) ?? []]) handler(event, ctx); },
    render: (width = 200) => footer!.render(width), invalidate: () => footer!.invalidate(), listenerCount: () => [...events.values()].reduce((n, set) => n + set.size, 0) };
}
let mounted: ReturnType<typeof mountUsage> | undefined;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { mounted?.dispose(); mounted = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
function mount(f: ReturnType<typeof fixture>) { return mounted = mountUsage(f.pi, f.ctx, f.runtime, config); }
describe("public usage footer mount", () => {
  it("sets AIC footer on parent TUI startup and keeps model/thinking at 40 columns", () => {
    const f = fixture(); mount(f);
    expect(f.render().join("\n")).toMatch(/AIC/); expect(f.render().join("\n")).not.toMatch(/\$/);
    expect(f.render(40)[0]).toMatch(/gpt-6.1-sol.*high/);
  });
  it("footer false restores pi with setFooter(undefined) and leaves the agents widget alone", () => {
    const f = fixture(); mount(f); mounted!.configure({ ...config, footer: false });
    expect(f.setFooter).toHaveBeenLastCalledWith(undefined); expect(f.unsubBranch).toHaveBeenCalledTimes(1);
    expect(f.ctx.ui.setWidget).not.toHaveBeenCalled();
    mounted!.configure(config); expect(f.render()[1]).toMatch(/AIC/);
  });
  it("poll changes hot-apply separately from footer and alerts", () => {
    const f = fixture(); mount(f); mounted!.configure({ ...config, counterPoll: false, alertsSessionCredits: 10 });
    expect(f.runtime.configure).toHaveBeenLastCalledWith(false); expect(f.render()[1]).toMatch(/AIC/);
  });
  it("reads public thinking name context and subscription flag and omits unknown auto state", () => {
    const f = fixture(); mount(f);
    expect(f.render()[0]).toMatch(/fixture name.*high/); expect(f.render()[1]).toMatch(/25.0%\/100k/);
    expect(f.render().join("\n")).not.toMatch(/\(auto\)/);
    expect(f.registry.getProvider).toHaveBeenCalledWith("github-copilot"); expect(f.registry.isUsingOAuth).toHaveBeenCalledWith(f.ctx.model);
  });
  it("absent context usage matches pi 0.0 percent with the model window", () => {
    const f = fixture(); vi.mocked(f.ctx.getContextUsage).mockReturnValue(undefined); mount(f);
    expect(f.render()[1]).toContain("0.0%/100k");
    vi.mocked(f.ctx.getContextUsage).mockReturnValue({ percent: null, tokens: null, contextWindow: 100000 });
    mounted!.refresh(); expect(f.render()[1]).toContain("?/100k");
  });
  it("all-entry initial load and tree navigation match installed pi, including abandoned branches", () => {
    const f = fixture(); f.append(assistant("abandoned", 200)); mount(f);
    expect(f.render()[1]).toMatch(/↑300 ↓20/);
    f.emit("session_tree"); expect(f.render()[1]).toMatch(/↑300 ↓20/); expect(f.getBranch).not.toHaveBeenCalled();
    f.append(generic("branch_summary", "summary", 30)); f.emit("session_tree");
    expect(f.render()[1]).toMatch(/↑330 ↓30/);
  });
  it("only new entries are priced on append, never on render or invalidate", () => {
    const spy = vi.spyOn(pricing, "priceCall"); const f = fixture(); mount(f); expect(spy).toHaveBeenCalledTimes(1);
    f.render(); f.invalidate(); f.render(); mounted!.refresh(); expect(spy).toHaveBeenCalledTimes(1);
    f.append(assistant("b", 200)); f.emit("turn_end"); expect(spy).toHaveBeenCalledTimes(2);
    expect(f.render()[1]).toMatch(/↑300 ↓20/);
  });
  it("message usage summaries and async usage refresh after settlement and the UI tick", () => {
    const f = fixture(); mount(f);
    f.append({ ...assistant("tool", 5), message: { role: "toolResult", usage: usage(5) } }); f.emit("message_end");
    f.append(generic("usage", "aux", 15)); f.emit("agent_settled");
    f.append(generic("usage", "warmer", 20)); vi.advanceTimersByTime(1000);
    expect(f.render()[1]).toMatch(/↑140 ↓40/);
  });
  it("tick catches a throwing dependency, notifies once without writing over the TUI, and recovers", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture(); mount(f); f.render();
    f.getEntries.mockImplementation(() => { throw new Error("fixture dependency failed"); });
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith("[spider usage] footer tick failed; will retry", "warning");
    expect(warning).not.toHaveBeenCalled();
    expect(f.render()[1]).toMatch(/↑100 ↓10/);
    f.getEntries.mockImplementation(() => [assistant("a", 100), assistant("b", 200)]);
    vi.advanceTimersByTime(1000);
    expect(f.render()[1]).toMatch(/↑300 ↓20/);
    expect(f.setFooter).toHaveBeenCalledTimes(1);
  });
  it("idle ticks check entries without requesting another TUI render", () => {
    const f = fixture(); mount(f); f.render();
    f.requestRender.mockClear(); f.getEntries.mockClear();
    vi.advanceTimersByTime(3000);
    expect(f.getEntries).toHaveBeenCalledTimes(3);
    expect(f.requestRender).not.toHaveBeenCalled();
    f.append(generic("usage", "warmer", 20)); vi.advanceTimersByTime(1000);
    expect(f.requestRender).toHaveBeenCalledTimes(1);
    expect(f.render()[1]).toMatch(/↑120 ↓20/);
    vi.advanceTimersByTime(1000); expect(f.requestRender).toHaveBeenCalledTimes(1);
  });
  it("tick renders changed context/model/thinking but not unrendered context tokens", () => {
    const f = fixture(); mount(f); f.render(); f.requestRender.mockClear();
    vi.mocked(f.ctx.getContextUsage).mockReturnValue({ percent: 25, tokens: 25001, contextWindow: 100000 });
    vi.advanceTimersByTime(1000); expect(f.requestRender).not.toHaveBeenCalled();
    vi.mocked(f.ctx.getContextUsage).mockReturnValue({ percent: 26, tokens: 26000, contextWindow: 100000 });
    vi.advanceTimersByTime(1000); expect(f.requestRender).toHaveBeenCalledTimes(1); expect(f.render()[1]).toMatch(/26.0%/);
    f.ctx.model = { ...f.ctx.model!, id: "fixture-other-model" };
    vi.advanceTimersByTime(1000); expect(f.requestRender).toHaveBeenCalledTimes(2); expect(f.render()[0]).toContain("fixture-other-model");
    f.pi.getThinkingLevel = () => "low";
    vi.advanceTimersByTime(1000); expect(f.requestRender).toHaveBeenCalledTimes(3); expect(f.render()[0]).toContain("low");
  });
  it("counter changes render only when the displayed month percentage changes", () => {
    const f = fixture(); f.counter(10); mount(f); f.render(); f.requestRender.mockClear();
    f.counter(10, 200); vi.advanceTimersByTime(1000); expect(f.requestRender).not.toHaveBeenCalled();
    f.counter(11, 300); vi.advanceTimersByTime(1000); expect(f.requestRender).toHaveBeenCalledTimes(1);
    expect(f.render()[1]).toContain("month 11.0%");
  });
  it("same-file session_start re-reduces without double counting", () => {
    const f = fixture(); mount(f); f.emit("session_start");
    expect(f.render()[1]).toMatch(/↑100 ↓10/);
    f.append(assistant("b", 200)); f.emit("turn_end");
    expect(f.render()[1]).toMatch(/↑300 ↓20/);
  });
  it("compaction adds summary usage without resetting pre-compaction totals", () => {
    const f = fixture(); mount(f); f.append(generic("compaction", "compact", 50)); f.emit("session_compact");
    expect(f.render()[1]).toMatch(/↑150 ↓20/);
  });
  it.each(["new", "resume", "fork"])("session %s replacement resets totals and releases subscriptions", reason => {
    const f = fixture(); mount(f); f.replace([assistant("replacement", 7)], `fixture-${reason}.jsonl`);
    f.emit("session_start", { reason }); expect(f.render()[1]).toMatch(/↑7 ↓10/); expect(f.unsubBranch).toHaveBeenCalledTimes(1);
    mounted!.dispose(); mounted!.dispose(); expect(f.listenerCount()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("switching session file without a lifecycle event resets rather than appends", () => {
    const f = fixture(); mount(f); f.replace([assistant("a", 9)], "fixture-other.jsonl"); mounted!.refresh(); expect(f.render()[1]).toMatch(/↑9 ↓10/);
  });
  it("history reset in the same file resets the cursor", () => {
    const f = fixture(); mount(f); f.replace([assistant("other", 11)]); mounted!.refresh(); expect(f.render()[1]).toMatch(/↑11 ↓10/);
  });
  it.each(["rpc", "json", "print"] as const)("%s mode installs no terminal footer", mode => {
    const f = fixture(mode); mount(f); expect(f.setFooter).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("child mode installs no footer or polling", () => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "1"); const f = fixture(); mount(f); expect(f.setFooter).not.toHaveBeenCalled(); expect(f.runtime.configure).not.toHaveBeenCalled();
  });
  it("worker error does not uninstall a working footer", () => {
    const f = fixture(); mount(f); f.failWorker(); mounted!.refresh(); expect(f.render()[1]).toMatch(/AIC/); expect(f.setFooter).toHaveBeenCalledTimes(1);
  });
});
