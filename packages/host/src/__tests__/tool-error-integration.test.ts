// packages/host/src/__tests__/tool-error-integration.test.ts
//
// Mechanism (B) end-to-end proof (pi-tool-error-contract-report.md §1-§3): a
// genuinely failed spider action must reach the model as
// ToolResultMessage.isError === true, with content/details intact, while an
// ordinary successful call carries no such override.
//
// Unlike result.test.ts (Tier 1: toToolResult in isolation) and
// routing-integration.test.ts (Tier 2: the tool_result hook wired in isolation via
// registerRouting(), with markToolCallError called BY HAND), this file drives the
// REAL, unmodified `spiderExtension()` entry point end to end: a real `execute()`
// call on the actually-registered "spider" tool (real dispatch()/buildActionCtx(),
// real DB opens against an isolated git fixture) is what must call
// markToolCallError internally — nothing here calls it directly — and the SAME
// toolCallId is then fed to the SAME registered tool_result hook. That closes the
// one gap Tier 1/2 cannot: proving extension.ts and routing/index.ts are actually
// wired together correctly, not just independently correct.
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { setGlobalDbPathForTests, type Db } from "@spider/db-core";
import spiderExtension, { buildActionCtx } from "../extension";
import { assertPreflightIsolation, assertPostOpenIsolation, type ExpectedRoots } from "./fixture-safety";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `toolerr-${process.pid}`);
const probeHandles: Db[] = [];
afterEach(() => {
  for (const db of probeHandles.splice(0)) { try { db.close(); } catch { /* best-effort */ } }
  setGlobalDbPathForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

// Mirrors extension.test.ts's own convention: gitInitScratch() inits the WHOLE
// fixture root once, so every subdirectory a test creates resolves worktree AND
// repo tier to `scratch` itself — both expected roots below are `scratch`.
const EXPECTED: ExpectedRoots = { worktree: scratch, repo: scratch, global: scratch };

function gitInitScratch(): void {
  mkdirSync(scratch, { recursive: true });
  execFileSync("git", ["init", "-q", scratch]);
  assertPreflightIsolation(scratch, scratch);
}

interface ExecuteResult { content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }

function fakePi() {
  const tools: Record<string, { execute(id: string, args: unknown, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<ExecuteResult> }> = {};
  const hooks: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  return {
    registerTool: (t: any) => { tools[t.name] = t; },
    registerCommand: (_name: string, _def: unknown) => {},
    on: (name: string, fn: (...args: unknown[]) => unknown) => { hooks[name] = fn as never; },
    _tools: tools,
    _hooks: hooks,
  };
}

/** Registers the REAL, unmodified spiderExtension against an isolated git fixture
 *  directory, then returns the actually-registered "spider" tool's execute() and
 *  the actually-registered tool_result hook — both taken straight off the fakePi
 *  capture, never reimplemented or called out of band. */
function setupSpider(dir: string) {
  setGlobalDbPathForTests(join(scratch, `g-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
  const pi = fakePi();
  spiderExtension(pi as never);
  // Pre-action isolation probe, mirroring the exact resolution shape the real
  // execute() calls below use (explicit args.cwd, sessionId "").
  const probe = buildActionCtx(pi as never, { action: "control", cwd: dir } as never, "", dir);
  probeHandles.push(probe.db, probe.repoDb, probe.globalDb);
  assertPostOpenIsolation(probe, EXPECTED, { requireRepoKey: true });
  const tool = pi._tools.spider;
  const toolResult = pi._hooks.tool_result;
  expect(tool, "spider tool must be registered by spiderExtension()").toBeTruthy();
  expect(toolResult, "tool_result hook must be registered by spiderExtension() (routing)").toBeTypeOf("function");
  return { tool, toolResult };
}

describe("tool_result isError correlation \u2014 real failing/succeeding calls through the registered spider tool", () => {
  it("a genuinely failing spider call (real dispatch 'unknown action') surfaces isError:true with content/details intact", async () => {
    gitInitScratch();
    const dir = join(scratch, "proj-fail"); mkdirSync(dir, { recursive: true });
    const { tool, toolResult } = setupSpider(dir);

    // Real production failure path: dispatch()'s own unknown-action guard
    // (packages/host/src/dispatch.ts), not a mock/stub.
    const execResult = await tool.execute("call-real-fail", { action: "definitely-not-a-real-action", cwd: dir }, undefined, undefined, {});
    expect(execResult.isError).toBe(true);
    expect(JSON.stringify(execResult.content)).toContain("unknown action");

    // What pi's real runtime constructs for a NORMAL resolve is always isError:false
    // at this point (report §1b) — the hook itself must be the one to flip it.
    const ret: any = await toolResult(
      { toolName: "spider", toolCallId: "call-real-fail", content: execResult.content, details: execResult.details, isError: false },
      {},
    );
    expect(ret?.isError).toBe(true);
    expect(ret?.content).toEqual(execResult.content);
    expect(ret?.details).toEqual(execResult.details);
  });

  it("a genuinely succeeding spider call ('todo' list) carries no isError override", async () => {
    gitInitScratch();
    const dir = join(scratch, "proj-ok"); mkdirSync(dir, { recursive: true });
    const { tool, toolResult } = setupSpider(dir);

    const execResult = await tool.execute("call-real-ok", { action: "todo", op: "list", cwd: dir }, undefined, undefined, {});
    expect(execResult.isError).toBeFalsy();

    const ret = await toolResult(
      { toolName: "spider", toolCallId: "call-real-ok", content: execResult.content, details: execResult.details, isError: false },
      {},
    );
    expect(ret == null).toBe(true);
  });

  it("interleaves a real failing call and a real succeeding call: each keeps its own flag regardless of tool_result firing order", async () => {
    gitInitScratch();
    const dir = join(scratch, "proj-mix"); mkdirSync(dir, { recursive: true });
    const { tool, toolResult } = setupSpider(dir);

    // Both real execute() calls complete BEFORE either tool_result fires \u2014 the shape
    // pi documents for parallel tool execution. Only the failing one is ever marked.
    const failExec = await tool.execute("call-mix-fail", { action: "definitely-not-a-real-action", cwd: dir }, undefined, undefined, {});
    const okExec = await tool.execute("call-mix-ok", { action: "todo", op: "list", cwd: dir }, undefined, undefined, {});
    expect(failExec.isError).toBe(true);
    expect(okExec.isError).toBeFalsy();

    // Fire the SUCCEEDING call's tool_result FIRST. A single scalar "pending error"
    // (instead of a per-toolCallId Set) would either wrongly flag this call or wrongly
    // consume/clear the still-pending failing call's mark before it is ever read.
    const okRet = await toolResult(
      { toolName: "spider", toolCallId: "call-mix-ok", content: okExec.content, details: okExec.details, isError: false },
      {},
    );
    expect(okRet == null).toBe(true);

    // The failing call's own tool_result, fired SECOND, must still carry its flag,
    // with its own (different) content/details untouched by the interleaving.
    const failRet: any = await toolResult(
      { toolName: "spider", toolCallId: "call-mix-fail", content: failExec.content, details: failExec.details, isError: false },
      {},
    );
    expect(failRet?.isError).toBe(true);
    expect(failRet?.content).toEqual(failExec.content);
    expect(failRet?.details).toEqual(failExec.details);
  });
});
