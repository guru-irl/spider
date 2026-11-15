import { withPiEvents, hostUnitPorts } from './fixtures/pi-events';
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult } from "@earendil-works/pi-coding-agent";
import { paths } from "@spider/db-core";
import { registerChild, teardownAll, type ChildHandle, type RunStatus } from "@spider/subagents";
import spiderExtension from "../extension";
import { configValues, controlConfig } from "../control";
import { applyConfigEdit, applyConfigUnset } from "../control/config-cmd";

type Handler = (event: CacheWarmingDecisionEvent, ctx: unknown) => CacheWarmingDecisionEventResult | undefined;
const event = (action: "warm" | "stop"): CacheWarmingDecisionEvent => ({
  type: "cache_warming_decision", warmCost: 0.1, missCost: 0.5, continuationProbability: 0.15, action,
});

function load() {
  const hooks = new Map<string, Handler>();
  spiderExtension(withPiEvents({ registerTool() {}, registerCommand() {}, on(name: string, handler: Handler) { hooks.set(name, handler); } } as never), hostUnitPorts);
  return hooks.get("cache_warming_decision");
}

// A starting child has a handle before pi finishes its startup handshake.
function child(status: RunStatus = "running"): ChildHandle {
  return { runStatus: status, wait: () => new Promise(() => {}), kill() {}, detach() {} } as ChildHandle;
}

describe("parent cache warming while subagents run", () => {
  let root: string;
  let ctx: { cwd: string; sessionManager: { getSessionId(): string } };
  beforeEach(() => {
    const scratch = resolve(".spider/scratch/warm-while-subagents/fixtures");
    mkdirSync(scratch, { recursive: true });
    root = mkdtempSync(join(scratch, "host-"));
    mkdirSync(join(root, ".spider"));
    // Stub only path resolution, so config reads cannot climb into the checkout.
    vi.spyOn(paths, "projectRoot").mockImplementation(cwd => join(cwd, ".spider"));
    ctx = { cwd: root, sessionManager: { getSessionId: () => "parent" } };
  });
  afterEach(() => {
    teardownAll();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(["warm", "stop"] as const)("overrides pi's %s decision with one active child", action => {
    registerChild("parent", "active", child());
    const handler = load();
    expect(handler).toBeTypeOf("function");
    expect(handler!(event(action), ctx)).toEqual({ action: "warm" });
  });

  it.each(["warm", "stop"] as const)("leaves pi's %s decision alone without active children", action => {
    const handler = load();
    expect(handler).toBeTypeOf("function");
    expect(handler!(event(action), ctx)).toBeUndefined();
  });

  it("counts a child still starting", () => {
    registerChild("parent", "starting", child("queued"));
    const handler = load();
    expect(handler).toBeTypeOf("function");
    expect(handler!(event("stop"), ctx)).toEqual({ action: "warm" });
  });

  it.each(["done", "cancelled", "failed", "paused"] as const)("does not hold warming for a %s child", status => {
    registerChild("parent", status, child(status));
    const handler = load();
    expect(handler).toBeTypeOf("function");
    expect(handler!(event("stop"), ctx)).toBeUndefined();
  });

  it("does not count another session's child", () => {
    registerChild("other", "other-run", child());
    const handler = load();
    expect(handler).toBeTypeOf("function");
    expect(handler!(event("stop"), ctx)).toBeUndefined();
    expect(handler!(event("stop"), { ...ctx, sessionManager: { getSessionId: () => "other" } })).toEqual({ action: "warm" });
  });

  it("ignores missing session identity instead of borrowing a different session", () => {
    registerChild("parent", "active", child());
    const handler = load();
    expect(handler).toBeTypeOf("function");
    expect(handler!(event("stop"), { cwd: root })).toBeUndefined();
  });

  it("honors live config changes without reload", () => {
    registerChild("parent", "active", child());
    const handler = load();
    expect(handler).toBeTypeOf("function");
    expect(handler!(event("stop"), ctx)).toEqual({ action: "warm" });
    controlConfig("set", root, "subagents.keepCacheWarm", false);
    expect(handler!(event("stop"), ctx)).toBeUndefined();
    controlConfig("unset", root, "subagents.keepCacheWarm");
    expect(handler!(event("stop"), ctx)).toEqual({ action: "warm" });
  });

  it("allows the schema-backed config action to disable warming and unset to its default", () => {
    expect(configValues(root)).toMatchObject({ config: { "subagents.keepCacheWarm": true }, sources: { "subagents.keepCacheWarm": "default" } });
    expect(applyConfigEdit(root, "subagents.keepCacheWarm", "false")).toMatchObject({ ok: true });
    expect(controlConfig("get", root, "subagents.keepCacheWarm")).toBe(false);
    expect(applyConfigUnset(root, "subagents.keepCacheWarm")).toMatchObject({ ok: true });
    expect(controlConfig("get", root, "subagents.keepCacheWarm")).toBe(true);
    expect(applyConfigEdit(root, "subagents.keepCacheWarm", "bogus")).toMatchObject({ ok: false });
  });

  it("does not register an override in a child process", () => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    expect(load()).toBeUndefined();
  });

  it("is a no-op if child identity changes after registration", () => {
    registerChild("parent", "active", child());
    const handler = load();
    expect(handler).toBeTypeOf("function");
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    expect(handler!(event("stop"), ctx)).toBeUndefined();
  });

  it("swallows session identity errors", () => {
    const handler = load();
    expect(handler).toBeTypeOf("function");
    expect(handler!(event("stop"), { sessionManager: { getSessionId() { throw new Error("session unavailable"); } } })).toBeUndefined();
  });

  it("swallows run tracking errors", () => {
    const handle = child();
    Object.defineProperty(handle, "runStatus", { get() { throw new Error("tracking unavailable"); } });
    registerChild("parent", "broken", handle);
    const handler = load();
    expect(handler).toBeTypeOf("function");
    expect(handler!(event("stop"), ctx)).toBeUndefined();
  });

  it("swallows config reader errors", () => {
    registerChild("parent", "active", child());
    const handler = load();
    expect(handler).toBeTypeOf("function");
    vi.mocked(paths.projectRoot).mockImplementation(() => { throw new Error("config unavailable"); });
    expect(handler!(event("stop"), ctx)).toBeUndefined();
  });

  describe("idle cap", () => {
    let now = 1_000_000;
    beforeEach(() => { now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now); });
    const minutes = (count: number) => count * 60_000;
    // Children here stay chatty, so only the parent's idle time can end warming.
    const live: ChildHandle[] = [];
    afterEach(() => { live.length = 0; });
    function liveChild(): ChildHandle { const handle = child(); live.push(handle); return handle; }

    // Several spider modules listen to the same pi events, so keep every handler.
    function loadAll() {
      const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
      spiderExtension(withPiEvents({ registerTool() {}, registerCommand() {}, on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      } } as never), hostUnitPorts);
      const fire = (name: string, at: typeof ctx = ctx) => { for (const handler of hooks.get(name) ?? []) { try { void handler({ type: name, messages: [] }, at); } catch { /* other modules' fakes */ } } };
      const decide = (action: "warm" | "stop", at: unknown = ctx) => { for (const handle of live) handle.lastEventAt = now; return (hooks.get("cache_warming_decision")!.at(-1) as Handler)(event(action), at); };
      return { fire, decide };
    }

    it("stops overriding pi after an hour of idle time by default", () => {
      registerChild("parent", "active", liveChild());
      const { fire, decide } = loadAll();
      fire("agent_start");
      fire("agent_end");
      now += minutes(59);
      expect(decide("stop")).toEqual({ action: "warm" });
      now += minutes(1);
      expect(decide("stop")).toBeUndefined();
      expect(decide("warm")).toBeUndefined();
    });

    it("restarts the idle clock when the parent takes another turn", () => {
      registerChild("parent", "active", liveChild());
      const { fire, decide } = loadAll();
      fire("agent_end");
      now += minutes(61);
      expect(decide("stop")).toBeUndefined();
      fire("agent_start");
      expect(decide("stop")).toEqual({ action: "warm" });
      now += minutes(5);
      fire("agent_end");
      now += minutes(30);
      expect(decide("stop")).toEqual({ action: "warm" });
    });

    it("starts the idle clock at the first decision when no turn end was seen", () => {
      registerChild("parent", "active", liveChild());
      const { decide } = loadAll();
      expect(decide("stop")).toEqual({ action: "warm" });
      now += minutes(59);
      expect(decide("stop")).toEqual({ action: "warm" });
      now += minutes(1);
      expect(decide("stop")).toBeUndefined();
    });

    it("keeps a separate idle clock per session", () => {
      registerChild("parent", "active", liveChild());
      registerChild("other", "other-run", liveChild());
      const other = { ...ctx, sessionManager: { getSessionId: () => "other" } };
      const { fire, decide } = loadAll();
      fire("agent_end");
      now += minutes(50);
      fire("agent_end", other);
      now += minutes(20);
      expect(decide("stop")).toBeUndefined();
      expect(decide("stop", other)).toEqual({ action: "warm" });
    });

    it("honors a configured limit and falls back to an hour for malformed values", () => {
      registerChild("parent", "active", liveChild());
      const { fire, decide } = loadAll();
      fire("agent_end");
      controlConfig("set", root, "subagents.keepCacheWarmMaxIdleMinutes", 10);
      now += minutes(9);
      expect(decide("stop")).toEqual({ action: "warm" });
      now += minutes(1);
      expect(decide("stop")).toBeUndefined();
      writeFileSync(join(root, ".spider/config.json"), JSON.stringify({ "subagents.keepCacheWarmMaxIdleMinutes": "bogus" }));
      expect(decide("stop")).toEqual({ action: "warm" });
      now += minutes(50);
      expect(decide("stop")).toBeUndefined();
    });

    it("exposes the limit through the schema-backed config action", () => {
      expect(configValues(root)).toMatchObject({ config: { "subagents.keepCacheWarmMaxIdleMinutes": 60 } });
      expect(applyConfigEdit(root, "subagents.keepCacheWarmMaxIdleMinutes", "90")).toMatchObject({ ok: true });
      expect(controlConfig("get", root, "subagents.keepCacheWarmMaxIdleMinutes")).toBe(90);
      expect(applyConfigEdit(root, "subagents.keepCacheWarmMaxIdleMinutes", "0")).toMatchObject({ ok: false });
      expect(applyConfigUnset(root, "subagents.keepCacheWarmMaxIdleMinutes")).toMatchObject({ ok: true });
      expect(controlConfig("get", root, "subagents.keepCacheWarmMaxIdleMinutes")).toBe(60);
    });
  });

  it("does not treat malformed values as enabled", () => {
    registerChild("parent", "active", child());
    writeFileSync(join(root, ".spider/config.json"), JSON.stringify({ "subagents.keepCacheWarm": "false" }));
    const handler = load();
    expect(handler).toBeTypeOf("function");
    expect(handler!(event("stop"), ctx)).toBeUndefined();
  });
});
