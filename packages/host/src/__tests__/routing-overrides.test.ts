import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDbAt, listEvents } from "@spider/db-core";
import { testScratchPath } from "./testutil.js";
import {
  validateDescription,
  countPatchLines,
  registerEditWriteOverrides,
} from "../routing/overrides";
import { consumeToolCallError } from "../result";

let dbPath: string;
afterEach(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
});
function mkdb() {
  dbPath = join(testScratchPath(".spider-test"), `ovr-${randomUUID()}.db`);
  return openDbAt(dbPath, "project");
}

function fakePi() {
  const tools: any[] = [];
  return { registerTool: (t: any) => tools.push(t), tools };
}

describe("validateDescription", () => {
  it("rejects a missing description", () => {
    expect(validateDescription(undefined)).toMatch(/required/);
  });
  it("rejects an empty/whitespace description", () => {
    expect(validateDescription("")).toMatch(/required/);
    expect(validateDescription("   ")).toMatch(/required/);
  });
  it("rejects a multiline description", () => {
    expect(validateDescription("line1\nline2")).toMatch(/single line/);
  });
  it("accepts a clean one-line description", () => {
    expect(validateDescription("fix the thing")).toBeNull();
  });
});

describe("countPatchLines", () => {
  it("counts +/- lines excluding headers", () => {
    const patch = ["--- a", "+++ b", "-old", "+new1", "+new2"].join("\n");
    expect(countPatchLines(patch)).toEqual({ added: 2, removed: 1 });
  });
  it("handles empty/nullish input", () => {
    expect(countPatchLines("")).toEqual({ added: 0, removed: 0 });
    expect(countPatchLines(undefined as any)).toEqual({ added: 0, removed: 0 });
  });
});

describe("edit override", () => {
  it("blocks an edit with no description (isError, no delegate, no event)", async () => {
    const db = mkdb();
    const pi = fakePi();
    let delegated = false;
    registerEditWriteOverrides(pi as any, {
      db,
      getSessionId: () => "s1",
      getCwd: () => process.cwd(),
      makeEditDelegate: () => ({
        execute: async () => {
          delegated = true;
          return { content: [], details: {} };
        },
      }),
      makeWriteDelegate: () => ({ execute: async () => ({ content: [], details: {} }) }),
    });
    const edit = pi.tools.find((t) => t.name === "edit")!;
    const result: any = await edit.execute("call-1", { path: "a.ts", edits: [] }, undefined, undefined, {});
    expect(result.isError).toBe(true);
    expect(delegated).toBe(false);
    expect(listEvents(db)).toHaveLength(0);
    db.close();
  });

  // A-M1 (branch-review A-architecture.md): pi's `AgentTool.execute()` contract has NO
  // `isError` field (verified against pi's own types) — returning one on the resolved
  // value, as the test above checks, is INERT; pi's runtime never reads it. The ONLY
  // working channel is `markToolCallError(toolCallId)` + the `tool_result` hook
  // (mechanism (B), routing/index.ts). A missing/invalid description must go through
  // that SAME real mechanism, not just carry a field nothing consumes.
  it("A-M1: a blocked edit marks its toolCallId via the REAL error-signaling mechanism (markToolCallError), not just an inert field", async () => {
    const db = mkdb();
    const pi = fakePi();
    registerEditWriteOverrides(pi as any, {
      db,
      getSessionId: () => "s1",
      getCwd: () => process.cwd(),
      makeEditDelegate: () => ({ execute: async () => ({ content: [], details: {} }) }),
      makeWriteDelegate: () => ({ execute: async () => ({ content: [], details: {} }) }),
    });
    const edit = pi.tools.find((t) => t.name === "edit")!;
    await edit.execute("call-marked-1", { path: "a.ts", edits: [] }, undefined, undefined, {});
    // consumeToolCallError deletes on read — true here proves markToolCallError fired.
    expect(consumeToolCallError("call-marked-1")).toBe(true);
    db.close();
  });

  it("A-M1: a blocked write ALSO marks its toolCallId via the real mechanism", async () => {
    const db = mkdb();
    const pi = fakePi();
    registerEditWriteOverrides(pi as any, {
      db,
      getSessionId: () => "s1",
      getCwd: () => process.cwd(),
      makeEditDelegate: () => ({ execute: async () => ({ content: [], details: {} }) }),
      makeWriteDelegate: () => ({ execute: async () => ({ content: [], details: {} }) }),
    });
    const write = pi.tools.find((t) => t.name === "write")!;
    await write.execute("call-marked-2", { path: "a.ts", content: "x" }, undefined, undefined, {});
    expect(consumeToolCallError("call-marked-2")).toBe(true);
    db.close();
  });

  it("A-M1: a VALID edit/write never marks a toolCallId (no false positives)", async () => {
    const db = mkdb();
    const pi = fakePi();
    registerEditWriteOverrides(pi as any, {
      db,
      getSessionId: () => "s1",
      getCwd: () => process.cwd(),
      makeEditDelegate: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }),
      makeWriteDelegate: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }),
    });
    const edit = pi.tools.find((t) => t.name === "edit")!;
    await edit.execute("call-ok-1", { path: "a.ts", description: "fine", edits: [{ oldText: "a", newText: "b" }] }, undefined, undefined, {});
    expect(consumeToolCallError("call-ok-1")).toBe(false);
    db.close();
  });

  it("delegates a valid edit and records line counts", async () => {
    const db = mkdb();
    const pi = fakePi();
    const patch = ["--- a", "+++ b", "-old", "+new1", "+new2"].join("\n");
    registerEditWriteOverrides(pi as any, {
      db,
      getSessionId: () => "s1",
      getCwd: () => process.cwd(),
      makeEditDelegate: () => ({
        execute: async () => ({ content: [{ type: "text", text: "ok" }], details: { patch } }),
      }),
      makeWriteDelegate: () => ({ execute: async () => ({ content: [], details: {} }) }),
    });
    const edit = pi.tools.find((t) => t.name === "edit")!;
    const result: any = await edit.execute(
      "call-2",
      { path: "a.ts", description: "swap old for new", edits: [{ oldText: "old", newText: "new" }] },
      undefined,
      undefined,
      {},
    );
    expect(result.isError).toBeFalsy();
    const [row] = listEvents(db, { phase: "after" });
    expect(row.tool).toBe("edit");
    expect(row.description).toBe("swap old for new");
    expect(row.added).toBe(2);
    expect(row.removed).toBe(1);
    db.close();
  });

  it("overrides omit renderCall/renderResult (native diff renderer inherited)", () => {
    const db = mkdb();
    const pi = fakePi();
    registerEditWriteOverrides(pi as any, {
      db,
      getSessionId: () => "s1",
      getCwd: () => process.cwd(),
    });
    for (const t of pi.tools) {
      expect(t.renderCall).toBeUndefined();
      expect(t.renderResult).toBeUndefined();
    }
    db.close();
  });
});
