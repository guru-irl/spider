// packages/host/src/__tests__/organism-wiring.test.ts
//
// Regression guard for the Phase 6 whole-branch review gap: the organism MANUAL
// action surface (`skill`, `control skill curate`, `control insights`) is fully
// built + unit-tested in @spider/organism but was NEVER mounted in the host, so
// `/learn`, curation, and the learning-graph view had no user-reachable surface.
//
// This test builds the real extension against a fake pi, then drives the actual
// dispatch registry + handleControl. It MUST fail against an unwired host (skill
// falls through to the Phase-0 stub; control insights/skill hit the "not yet
// implemented" default) and PASS once the actions are routed.
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests } from "@spider/db-core";
import spiderExtension, { buildActionCtx } from "../extension";
import { getAction, type ActionCtx, type SpiderArgs } from "../dispatch";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `org-wire-${process.pid}`);
afterEach(() => { setGlobalDbPathForTests(null); rmSync(scratch, { recursive: true, force: true }); });

function fakePi() {
  const tools: Record<string, unknown> = {};
  const hooks: Record<string, unknown> = {};
  const commands: Record<string, unknown> = {};
  return {
    registerTool: (t: { name: string }) => { tools[t.name] = t; },
    registerCommand: (name: string, def: unknown) => { commands[name] = def; },
    registerMessageRenderer: () => {},
    on: (name: string, fn: unknown) => { hooks[name] = fn; },
    listModels: () => [],
    _tools: tools, _hooks: hooks, _commands: commands,
  };
}

/** Wire the extension against a fresh scratch DB and hand back an ActionCtx. */
function setup(sub: string): { pi: ReturnType<typeof fakePi>; ctx: ActionCtx; dir: string } {
  mkdirSync(scratch, { recursive: true });
  setGlobalDbPathForTests(join(scratch, `g-${sub}-${Date.now()}.db`));
  const dir = join(scratch, `proj-${sub}`); mkdirSync(dir, { recursive: true });
  const pi = fakePi();
  spiderExtension(pi as never);
  const ctx = buildActionCtx(pi as never, { action: "control", cwd: dir } as SpiderArgs, "s-org", dir);
  return { pi, ctx, dir };
}

describe("host mounts the organism manual action surface", () => {
  it("routes the `skill` action (list → array details; distill → /learn prompt)", async () => {
    const { ctx } = setup("skill");
    const skill = getAction("skill");
    expect(skill, "skill action must be registered (not the Phase-0 stub)").toBeTypeOf("function");

    const listed = await skill!({ action: "skill", op: "list" } as never, ctx) as { display: string; details: unknown };
    expect(listed.display).toBeTypeOf("string");
    expect(Array.isArray(listed.details)).toBe(true);

    const distilled = await skill!({ action: "skill", op: "distill", text: "x" } as never, ctx) as { details: { prompt: string } };
    expect(distilled.details.prompt).toContain("spider skill");

    ctx.db.close(); ctx.globalDb.close();
  });

  it("routes `control insights` to the learning graph (nodes/edges/stats), not the stub", async () => {
    const { ctx } = setup("insights");
    const control = getAction("control");
    expect(control).toBeTypeOf("function");
    const res = await control!({ action: "control", command: "insights" } as never, ctx) as { error?: string; details: { nodes?: unknown; edges?: unknown; stats?: unknown } };
    expect(res.error).toBeUndefined();
    expect(res.details).toBeTruthy();
    expect(res.details).toHaveProperty("nodes");
    expect(res.details).toHaveProperty("edges");
    expect(res.details).toHaveProperty("stats");
    ctx.db.close(); ctx.globalDb.close();
  });

  it("routes `control skill curate` to the curator decay pass, not an error", async () => {
    const { ctx } = setup("curate");
    const control = getAction("control");
    const res = await control!({ action: "control", command: "skill", sub: "curate", force: true } as never, ctx) as { error?: string; display?: string; details: { toStale?: unknown; toArchived?: unknown; skipped?: unknown } };
    expect(res.error).toBeUndefined();
    expect(res.display).toBeTypeOf("string");
    expect(res.details).toHaveProperty("toStale");
    expect(res.details).toHaveProperty("toArchived");
    expect(res.details).toHaveProperty("skipped");
    ctx.db.close(); ctx.globalDb.close();
  });
});
