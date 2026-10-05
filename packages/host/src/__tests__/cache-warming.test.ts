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
  spiderExtension({ registerTool() {}, registerCommand() {}, on(name: string, handler: Handler) { hooks.set(name, handler); } } as never);
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

  it("does not treat malformed values as enabled", () => {
    registerChild("parent", "active", child());
    writeFileSync(join(root, ".spider/config.json"), JSON.stringify({ "subagents.keepCacheWarm": "false" }));
    const handler = load();
    expect(handler).toBeTypeOf("function");
    expect(handler!(event("stop"), ctx)).toBeUndefined();
  });
});
