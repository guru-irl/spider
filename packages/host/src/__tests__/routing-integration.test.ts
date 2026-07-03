import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { openDbAt, paths, listEvents } from "@spider/db-core";
import { registerRouting, DEFAULT_ROUTING_CONFIG } from "../routing/index.js";

let dbPath = "";
let workDir = "";
afterEach(() => {
  for (const s of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${s}`, { force: true });
    } catch {
      // ignore
    }
  }
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function fakePi() {
  const hooks: Record<string, Function> = {};
  const tools: Record<string, any> = {};
  return {
    on: (n: string, f: Function) => {
      hooks[n] = f;
    },
    registerTool: (t: any) => {
      tools[t.name] = t;
    },
    _hooks: hooks,
    _tools: tools,
  };
}

function setup() {
  const base = paths.scratch("project", process.cwd());
  dbPath = join(base, `rint-${randomUUID()}.db`);
  workDir = join(base, `rwork-${randomUUID()}`);
  mkdirSync(workDir, { recursive: true });
  const db = openDbAt(dbPath, "project");
  const pi = fakePi();
  registerRouting(pi as any, {
    db,
    getSessionId: () => "s1",
    getCwd: () => workDir,
    config: DEFAULT_ROUTING_CONFIG,
  });
  return { db, pi };
}

describe("routing integration smoke", () => {
  it("logs tool_call intent (phase=before) for a tracked tool", async () => {
    const { db, pi } = setup();
    await pi._hooks.tool_call({ toolName: "bash", input: { command: "ls" } }, {});
    const before = listEvents(db, { phase: "before" });
    expect(before.some((e) => e.tool === "bash")).toBe(true);
    db.close();
  });

  it("scrubs a secret in tool_result, replaces content, and records flagged (phase=after)", async () => {
    const { db, pi } = setup();
    const token = "ghp_" + "f".repeat(20);
    const ret: any = await pi._hooks.tool_result(
      { toolName: "bash", content: [{ type: "text", text: `export T=${token}` }] },
      {},
    );
    expect(JSON.stringify(ret.content)).not.toContain(token);
    expect(JSON.stringify(ret.content)).toContain("[REDACTED:");
    const after = listEvents(db, { phase: "after" }).find((e) => e.tool === "bash");
    expect(after?.flagged).toContain("github_personal_token");
    db.close();
  });

  it("auto-indexes a large clean tool_result into the content KB", async () => {
    const { db, pi } = setup();
    const big = "alpha bravo charlie ".repeat(700); // > 10000 chars, no secrets
    await pi._hooks.tool_result({ toolName: "bash", content: [{ type: "text", text: big }] }, {});
    const n = (db.prepare("SELECT COUNT(*) c FROM content").get() as { c: number }).c;
    expect(n).toBeGreaterThan(0);
    db.close();
  });

  it("edit override does a REAL edit, records +/- once, and tool_result(edit) does NOT double-record", async () => {
    const { db, pi } = setup();
    const file = join(workDir, "f.txt");
    writeFileSync(file, "old line\nkeep\n");
    const res: any = await pi._tools.edit.execute(
      "c-edit",
      { path: "f.txt", description: "swap old for new", edits: [{ oldText: "old line", newText: "new line\nsecond" }] },
      undefined,
      undefined,
      {},
    );
    expect(res?.isError).toBeFalsy();
    // fire the tool_result event for edit — must be SKIPPED (override already recorded)
    await pi._hooks.tool_result({ toolName: "edit", content: [{ type: "text", text: "edited" }] }, {});
    const editEvents = listEvents(db, { tool: "edit" });
    expect(editEvents).toHaveLength(1);
    expect(editEvents[0].description).toBe("swap old for new");
    expect(editEvents[0].added).toBeGreaterThan(0);
    db.close();
  });

  it("exempts the spider mega-tool (no events, no content replacement)", async () => {
    const { db, pi } = setup();
    await pi._hooks.tool_call({ toolName: "spider", input: {} }, {});
    const ret = await pi._hooks.tool_result({ toolName: "spider", content: [{ type: "text", text: "internal" }] }, {});
    expect(ret == null).toBe(true);
    expect(listEvents(db)).toHaveLength(0);
    db.close();
  });

  it("keeps all scratch under the spider root, never /tmp", () => {
    setup();
    const root = paths.scratch("project", process.cwd());
    expect(dbPath.startsWith(root)).toBe(true);
    expect(workDir.startsWith(root)).toBe(true);
    expect(dbPath.startsWith(tmpdir())).toBe(false);
    expect(dbPath.includes("/tmp/")).toBe(false);
  });
});
