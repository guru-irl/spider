// packages/host/src/__tests__/control-memory-admin.test.ts
//
// Defect 1: `control memory consolidate` returned `{ entries: listActive(...), usage:
// activeCharTotal(...) }` -- a read-only report wearing an action's name. Nothing was ever
// merged, pruned, or rewritten. Fixed by renaming the report to `control memory status` and
// making the old name fail with a clear, actionable error instead of silently misleading.
//
// Defect 2: the memory cap (DEFAULT_MEMORY_CHAR_CAP, 8000 active chars per scope) had no
// eviction path once full -- pending/approve/reject/consolidate cover the staging workflow,
// but none of them can remove an already-active entry. Fixed by `control memory forget
// <uuid>`, which is scope-aware (never reaches across global/repo/worktree) and never
// hard-deletes (archives, matching reject/removeMemory).
//
// These tests drive the REAL tool.execute() path (buildActionCtx -> dispatch ->
// handleControl), the same way c1-memory-routing.test.ts does, against isolated,
// git-initialized scratch directories -- never the real repo.db or global spider.db.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { setGlobalDbPathForTests, openRepo, resolveProject } from "@spider/db-core";
import { addMemory } from "@spider/memory";
import spiderExtension from "../extension";
import { renderSpiderResult } from "../render-result";

vi.mock("@spider/memory", async original => ({
  ...await original<typeof import("@spider/memory")>(), resolveEmbedder: async () => null,
}));
function rendered(res: unknown, sub: string): string {
  return renderSpiderResult(res, { expanded: true }, {}, { args: { action: "control", command: "memory", sub } }).render(160).join("\n");
}

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `cma-${process.pid}`);

beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
  // git-init the SCRATCH ROOT (not each per-test subdir): every subdirectory a test
  // creates below it then shares this as its nearest .git, so `git rev-parse
  // --show-toplevel` / `--git-common-dir` resolve HERE and never walk up into the real
  // spider repo this test file lives in (see task note: an un-init'd scratch dir nested
  // inside a real repo silently inherits the real repo's DB -- that is how two junk rows
  // ended up in the real repo.db before this task).
  execFileSync("git", ["init", "-q"], { cwd: scratch });
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: scratch });
  execFileSync("git", ["config", "user.name", "test"], { cwd: scratch });
  setGlobalDbPathForTests(join(scratch, `g-${Date.now()}.db`));
});

afterEach(() => {
  setGlobalDbPathForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

function fakePi() {
  const tools: Record<string, unknown> = {};
  return {
    registerTool: (t: { name: string }) => { tools[t.name] = t; },
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    on: () => {},
    _tools: tools,
  };
}

function makeTool() {
  const pi = fakePi();
  spiderExtension(pi as never);
  return (pi as unknown as { _tools: Record<string, unknown> })._tools["spider"] as {
    execute(id: string, args: unknown, ctx?: unknown): Promise<{ content: { text: string }[]; details: unknown }>;
  };
}

describe("control memory admin: status / consolidate / forget", () => {
  it("status reports active entries with uuids and usage", async () => {
    const dir = join(scratch, "status-repo"); mkdirSync(dir, { recursive: true });
    const tool = makeTool();
    await tool.execute("r1", { action: "remember", category: "tool-quirk", content: "widget alpha", cwd: dir }, {});

    const res = await tool.execute("s1", { action: "control", command: "memory", sub: "status", cwd: dir }, {});
    const details = res.details as { entries: Array<{ uuid: string; content: string }>; usage: number };

    expect(details.entries.some((e) => e.content === "widget alpha")).toBe(true);
    expect(details.entries.every((e) => typeof e.uuid === "string" && e.uuid.length > 0)).toBe(true);
    expect(details.usage).toBeGreaterThan(0);
    const text = rendered(res, "status");
    expect(text).toContain("widget alpha");
    expect(text).toContain(details.entries[0].uuid);
    expect(text).not.toMatch(/\{|"entries"|"usage"/);
  });

  it("consolidate returns a clear error instead of a silent report", async () => {
    const dir = join(scratch, "consolidate-repo"); mkdirSync(dir, { recursive: true });
    const tool = makeTool();

    const res = await tool.execute("c1", { action: "control", command: "memory", sub: "consolidate", cwd: dir }, {});

    // The model-facing text (what a caller relying on the old name actually sees) must be
    // a clear error, not silence -- and it must point at the replacements.
    expect(res.content[0].text).toMatch(/^Error:/);
    expect(res.content[0].text.toLowerCase()).toMatch(/status/);
    expect(res.content[0].text.toLowerCase()).toMatch(/forget/);
    expect((res.details as { entries?: unknown })?.entries).toBeUndefined();
    const text = rendered(res, "consolidate");
    expect(text).toContain("status");
    expect(text).toContain("forget");
    expect(text).not.toContain("0 active");
  });

  it("forget removes an entry by uuid so it's gone from status and recall", async () => {
    const dir = join(scratch, "forget-repo"); mkdirSync(dir, { recursive: true });
    const tool = makeTool();
    const w = await tool.execute("r2", { action: "remember", category: "tool-quirk", content: "widget beta", cwd: dir }, {});
    const uuid = (w.details as { uuid?: string }).uuid!;
    expect(uuid).toBeTruthy();

    const forgetRes = await tool.execute("f1", { action: "control", command: "memory", sub: "forget", uuid, cwd: dir }, {});
    expect((forgetRes.details as { ok?: boolean }).ok).toBe(true);
    const text = rendered(forgetRes, "forget");
    expect(text).toMatch(/archived/i);
    expect(text).toContain(uuid);
    expect(text).not.toMatch(/\{|"ok"|"removed"/);

    const status = await tool.execute("s2", { action: "control", command: "memory", sub: "status", cwd: dir }, {});
    expect(JSON.stringify(status.details)).not.toContain("widget beta");

    const recallRes = await tool.execute("rc1", { action: "recall", query: "widget beta", cwd: dir }, {});
    expect((recallRes.details as Array<{ content: string }>).some((r) => r.content === "widget beta")).toBe(false);
  });

  it("forget on an unknown uuid returns a clear error, not silent success", async () => {
    const dir = join(scratch, "forget-missing-repo"); mkdirSync(dir, { recursive: true });
    const tool = makeTool();
    const uuid = "00000000-0000-0000-0000-000000000000";

    const res = await tool.execute(
      "f2",
      { action: "control", command: "memory", sub: "forget", uuid, cwd: dir },
      {},
    );

    // Must name the actual uuid that wasn't found (not just "sub unknown" --
    // that would also match /^Error:/ before this feature existed).
    expect(res.content[0].text).toMatch(/^Error:/);
    expect(res.content[0].text).toContain(uuid);
  });

  it("forget without a uuid returns a clear error", async () => {
    const dir = join(scratch, "forget-no-uuid-repo"); mkdirSync(dir, { recursive: true });
    const tool = makeTool();

    const res = await tool.execute("f3", { action: "control", command: "memory", sub: "forget", cwd: dir }, {});

    expect(res.content[0].text).toMatch(/^Error:/);
    expect(res.content[0].text.toLowerCase()).toContain("uuid");
  });

  it("is scope-aware: forgetting a repo-scope uuid under scope=global neither finds nor deletes it", async () => {
    const dir = join(scratch, "scope-safety-repo"); mkdirSync(dir, { recursive: true });
    const tool = makeTool();
    const w = await tool.execute(
      "r3",
      { action: "remember", category: "tool-quirk", content: "repo scoped fact", cwd: dir, scope: "repo" },
      {},
    );
    const uuid = (w.details as { uuid?: string }).uuid!;

    // Wrong-scope forget: must not silently delete, must report not-found (naming the scope
    // and uuid) -- not just "sub unknown", which would also match /^Error:/ either way.
    const wrongScope = await tool.execute(
      "f4",
      { action: "control", command: "memory", sub: "forget", uuid, scope: "global", cwd: dir },
      {},
    );
    expect(wrongScope.content[0].text).toMatch(/^Error:/);
    expect(wrongScope.content[0].text).toContain(uuid);
    expect(wrongScope.content[0].text).toContain("global");

    // The repo-scope entry must still be there, untouched.
    const recallRes = await tool.execute("rc2", { action: "recall", query: "repo scoped fact", cwd: dir, scope: "repo" }, {});
    expect((recallRes.details as Array<{ content: string }>).some((r) => r.content === "repo scoped fact")).toBe(true);
  });

  it("forgetting a repo-scope entry after cap overflow lets a previously-blocked write succeed", async () => {
    const dir = join(scratch, "overflow-repo"); mkdirSync(dir, { recursive: true });
    const tool = makeTool();

    // Seed close to the 8000-char cap directly against the exact repo DB file the tool
    // will resolve `cwd` to -- reproducing "Memory cap exceeded: 7822 + new content would
    // exceed 8000 chars" without needing 160 individual remember calls.
    const project = resolveProject(dir);
    const repoDb = openRepo(project.repoKey!);
    let seededUuid: string;
    try {
      seededUuid = addMemory(repoDb, "repo", { category: "tool-quirk", content: "z".repeat(7999) }).uuid;
    } finally {
      repoDb.close();
    }

    // Blocked: 7999 + 50 > 8000. Before this feature, this was a dead end short of raw SQL.
    await expect(
      tool.execute("r4", { action: "remember", category: "tool-quirk", content: "y".repeat(50), cwd: dir }, {}),
    ).rejects.toThrow(/Memory cap exceeded/);

    const forgetRes = await tool.execute("f5", { action: "control", command: "memory", sub: "forget", uuid: seededUuid, cwd: dir }, {});
    expect((forgetRes.details as { ok?: boolean }).ok).toBe(true);

    // The SAME write that was blocked now succeeds.
    const retry = await tool.execute("r5", { action: "remember", category: "tool-quirk", content: "y".repeat(50), cwd: dir }, {});
    expect((retry.details as { status?: string }).status).toBe("active");
  });
});
