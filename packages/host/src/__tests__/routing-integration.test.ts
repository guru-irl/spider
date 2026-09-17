import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { openDbAt, listEvents } from "@spider/db-core";
import { testScratchPath } from "./testutil.js";
import { registerRouting, DEFAULT_ROUTING_CONFIG } from "../routing/index";
import { markToolCallError } from "../result";

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
  const base = testScratchPath(".spider-test");
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

  // Mechanism (B): §2b/§2c of pi-tool-error-contract-report.md — this hook is the ONLY
  // place that can flip ToolResultMessage.isError while preserving content/details. The
  // three tests below assert the new marked-toolCallId branch fires ONLY when a prior
  // execute() call flagged that exact id (via extension.ts -> result.ts), and never
  // otherwise — the test just above (no toolCallId marked) is the ordinary case this
  // branch must NOT disturb; it is left unmodified deliberately (see report §2: it
  // already asserts the correct behavior for an UNmarked call, which is still exactly
  // what happens when nothing was ever marked for that id).
  it("flags a marked spider toolCallId as isError via tool_result, content/details preserved verbatim", async () => {
    const { pi } = setup();
    markToolCallError("call-err-1");
    const ret: any = await pi._hooks.tool_result(
      { toolName: "spider", toolCallId: "call-err-1", content: [{ type: "text", text: "Error: boom" }], details: { error: "boom" } },
      {},
    );
    expect(ret?.isError).toBe(true);
    expect(ret?.content).toEqual([{ type: "text", text: "Error: boom" }]);
    expect(ret?.details).toEqual({ error: "boom" });
  });

  it("is one-shot: a second tool_result for the same toolCallId is untouched (no leak across calls)", async () => {
    const { pi } = setup();
    markToolCallError("call-err-2");
    const first: any = await pi._hooks.tool_result({ toolName: "spider", toolCallId: "call-err-2", content: [] }, {});
    expect(first?.isError).toBe(true);
    const second = await pi._hooks.tool_result({ toolName: "spider", toolCallId: "call-err-2", content: [] }, {});
    expect(second == null).toBe(true);
  });

  it("interleaves a failing and a succeeding spider toolCallId without cross-contamination", async () => {
    const { pi } = setup();
    // Only "call-fail-1" is ever marked — "call-ok-1" represents a normal, successful
    // spider call running concurrently (parallel tool execution can interleave
    // tool_result delivery in either order; a single scalar — instead of a per-id
    // Map/Set — would leak the flag onto the wrong call here).
    markToolCallError("call-fail-1");
    const okRet = await pi._hooks.tool_result({ toolName: "spider", toolCallId: "call-ok-1", content: [{ type: "text", text: "fine" }] }, {});
    expect(okRet == null).toBe(true);
    const failRet: any = await pi._hooks.tool_result({ toolName: "spider", toolCallId: "call-fail-1", content: [{ type: "text", text: "boom" }] }, {});
    expect(failRet?.isError).toBe(true);
    expect(failRet?.content).toEqual([{ type: "text", text: "boom" }]);
  });

  it("keeps all scratch under the spider root, never /tmp", () => {
    setup();
    const root = testScratchPath(".spider-test");
    expect(dbPath.startsWith(root)).toBe(true);
    expect(workDir.startsWith(root)).toBe(true);
    expect(dbPath.startsWith(tmpdir())).toBe(false);
    expect(dbPath.includes("/tmp/")).toBe(false);
  });

  // A-M1 (branch-review A-architecture.md): overrides.ts used to signal an edit/write
  // validation failure ONLY via an `isError: true` field on its OWN resolved value —
  // pi's `execute()` contract has no such field, so it was silently dropped and the
  // failure reached pi (and therefore the model/UI) as a SUCCESS. This is the full,
  // real round trip: the override's execute() call marks the toolCallId, then the SAME
  // toolCallId's tool_result event (fired by pi for EVERY tool, edit/write included)
  // must now come back flagged isError — not just for the spider mega-tool.
  it("A-M1: a blocked edit's isError actually reaches pi through the SAME tool_result mechanism the spider tool uses — not just an inert field on its own return", async () => {
    const { pi } = setup();
    const res: any = await pi._tools.edit.execute(
      "c-bad-edit",
      { path: "f.txt", edits: [] }, // no description -> validation failure
      undefined, undefined, {},
    );
    expect(res?.isError).toBe(true); // the (inert-to-pi, still-honest) field on the return itself
    // The decisive check: pi always fires tool_result for every tool call, edit/write
    // included. Before the fix this branch only fired for tool === "spider".
    const ret: any = await pi._hooks.tool_result(
      { toolName: "edit", toolCallId: "c-bad-edit", content: res.content, details: res.details },
      {},
    );
    expect(ret?.isError).toBe(true);
    expect(ret?.content).toEqual(res.content);
  });

  it("A-M1: a blocked write ALSO reaches pi via tool_result, not just the spider tool", async () => {
    const { pi } = setup();
    const res: any = await pi._tools.write.execute(
      "c-bad-write",
      { path: "f.txt", content: "x" }, // no description -> validation failure
      undefined, undefined, {},
    );
    expect(res?.isError).toBe(true);
    const ret: any = await pi._hooks.tool_result(
      { toolName: "write", toolCallId: "c-bad-write", content: res.content, details: res.details },
      {},
    );
    expect(ret?.isError).toBe(true);
  });

  it("A-M1: a VALID edit's tool_result is untouched (no false-positive marking)", async () => {
    const { pi } = setup();
    const file = join(workDir, "g.txt");
    writeFileSync(file, "old\n");
    const res: any = await pi._tools.edit.execute(
      "c-good-edit",
      { path: "g.txt", description: "fine", edits: [{ oldText: "old", newText: "new" }] },
      undefined, undefined, {},
    );
    expect(res?.isError).toBeFalsy();
    const ret = await pi._hooks.tool_result({ toolName: "edit", toolCallId: "c-good-edit", content: res.content }, {});
    // Falls through to the pre-existing OVERRIDDEN-tool no-op path (edit/write already
    // recorded their own after-event) — no isError, no re-processing.
    expect((ret as any)?.isError).toBeFalsy();
  });
});
