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
  it.each(["edit", "write"])("adds model-facing text when a %s delegate returns empty content", async (name) => {
    const db = mkdb();
    const pi = fakePi();
    const empty = { content: [{ type: "text", text: "" }], details: { patch: "" } };
    registerEditWriteOverrides(pi as any, {
      db,
      getSessionId: () => "s-empty",
      getCwd: () => process.cwd(),
      makeEditDelegate: () => ({ execute: async () => empty }),
      makeWriteDelegate: () => ({ execute: async () => empty }),
    });
    try {
      const tool = pi.tools.find((t) => t.name === name)!;
      const params = name === "edit"
        ? { path: "unused.txt", description: "test empty content", edits: [{ oldText: "a", newText: "b" }] }
        : { path: "unused.txt", description: "test empty content", content: "new" };
      const result: any = await tool.execute(`empty-${name}`, params, undefined, undefined, {});
      expect(result.content.some((block: any) => block.type === "text" && block.text.length > 0)).toBe(true);
      expect(result.details).toBe(empty.details);
    } finally { db.close(); }
  });

  it.each(["edit", "write"])("replaces whitespace-only %s delegate text", async (name) => {
    const db = mkdb();
    const pi = fakePi();
    registerEditWriteOverrides(pi as any, {
      db,
      getSessionId: () => "s-whitespace",
      getCwd: () => process.cwd(),
      makeEditDelegate: () => ({ execute: async () => ({ content: [{ type: "text", text: "  \n" }], details: {} }) }),
      makeWriteDelegate: () => ({ execute: async () => ({ content: [{ type: "text", text: "  \n" }], details: {} }) }),
    });
    try {
      const tool = pi.tools.find((t) => t.name === name)!;
      const params = name === "edit"
        ? { path: "unused.txt", description: "test whitespace", edits: [{ oldText: "a", newText: "b" }] }
        : { path: "unused.txt", description: "test whitespace", content: "new" };
      const result: any = await tool.execute(`whitespace-${name}`, params, undefined, undefined, {});
      expect(result.content[0].text).toBe("(no message)");
    } finally { db.close(); }
  });

  it.each(["edit", "write"])("adds model-facing text when a %s delegate returns no content blocks", async (name) => {
    const db = mkdb();
    const pi = fakePi();
    registerEditWriteOverrides(pi as any, {
      db,
      getSessionId: () => "s-empty-blocks",
      getCwd: () => process.cwd(),
      makeEditDelegate: () => ({ execute: async () => ({ content: [], details: {} }) }),
      makeWriteDelegate: () => ({ execute: async () => ({ content: [], details: {} }) }),
    });
    try {
      const tool = pi.tools.find((t) => t.name === name)!;
      const params = name === "edit"
        ? { path: "unused.txt", description: "test missing blocks", edits: [{ oldText: "a", newText: "b" }] }
        : { path: "unused.txt", description: "test missing blocks", content: "new" };
      const result: any = await tool.execute(`no-blocks-${name}`, params, undefined, undefined, {});
      expect(result.content.some((block: any) => block.type === "text" && block.text.length > 0)).toBe(true);
    } finally { db.close(); }
  });

  it.each(["edit", "write"])("rethrows blank %s delegate errors with a readable message", async (name) => {
    const db = mkdb();
    const pi = fakePi();
    const original = new Error("");
    registerEditWriteOverrides(pi as any, {
      db,
      getSessionId: () => "s-blank-throw",
      getCwd: () => process.cwd(),
      makeEditDelegate: () => ({ execute: async () => { throw original; } }),
      makeWriteDelegate: () => ({ execute: async () => { throw original; } }),
    });
    try {
      const tool = pi.tools.find((t) => t.name === name)!;
      const params = name === "edit"
        ? { path: "unused.txt", description: "test blank throw", edits: [{ oldText: "a", newText: "b" }] }
        : { path: "unused.txt", description: "test blank throw", content: "new" };
      await expect(tool.execute(`blank-throw-${name}`, params, undefined, undefined, {}))
        .rejects.toMatchObject({ message: `${name} delegate failed: Error with no message`, cause: original });
    } finally { db.close(); }
  });

  it.each(["edit", "write"])("preserves nonblank %s delegate errors", async (name) => {
    const db = mkdb();
    const pi = fakePi();
    const original = new Error("permission denied");
    registerEditWriteOverrides(pi as any, {
      db,
      getSessionId: () => "s-readable-throw",
      getCwd: () => process.cwd(),
      makeEditDelegate: () => ({ execute: async () => { throw original; } }),
      makeWriteDelegate: () => ({ execute: async () => { throw original; } }),
    });
    try {
      const tool = pi.tools.find((t) => t.name === name)!;
      const params = name === "edit"
        ? { path: "unused.txt", description: "test readable throw", edits: [{ oldText: "a", newText: "b" }] }
        : { path: "unused.txt", description: "test readable throw", content: "new" };
      await expect(tool.execute(`readable-throw-${name}`, params, undefined, undefined, {})).rejects.toBe(original);
    } finally { db.close(); }
  });

  it.each(["edit", "write"])("returns an existing %s delegate result unchanged", async (name) => {
    const db = mkdb();
    const pi = fakePi();
    const original = { content: [{ type: "text", text: "Already meaningful" }], details: { patch: "" } };
    registerEditWriteOverrides(pi as any, {
      db,
      getSessionId: () => "s-meaningful",
      getCwd: () => process.cwd(),
      makeEditDelegate: () => ({ execute: async () => original }),
      makeWriteDelegate: () => ({ execute: async () => original }),
    });
    try {
      const tool = pi.tools.find((t) => t.name === name)!;
      const params = name === "edit"
        ? { path: "unused.txt", description: "test preservation", edits: [{ oldText: "a", newText: "b" }] }
        : { path: "unused.txt", description: "test preservation", content: "new" };
      expect(await tool.execute(`meaningful-${name}`, params, undefined, undefined, {})).toBe(original);
    } finally { db.close(); }
  });
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

  it("passes through non-empty text returned by pi's real write and edit delegates", async () => {
    const db = mkdb();
    const pi = fakePi();
    const cwd = testScratchPath(`delegate-${randomUUID()}`);
    const path = "delegate-check.txt";
    registerEditWriteOverrides(pi as any, { db, getSessionId: () => "s-real", getCwd: () => cwd });
    try {
      const write = pi.tools.find((t) => t.name === "write")!;
      const edit = pi.tools.find((t) => t.name === "edit")!;
      const written: any = await write.execute("real-write", { path, content: "original", description: "create delegate fixture" }, undefined, undefined, { cwd });
      expect(written.content[0].text).toBe(`Successfully wrote to ${path}`);
      const edited: any = await edit.execute("real-edit", { path, description: "update delegate fixture", edits: [{ oldText: "original", newText: "updated" }] }, undefined, undefined, { cwd });
      expect(edited.content[0].text).toBe(`Successfully replaced 1 block(s) in ${path}.`);
    } finally { db.close(); rmSync(cwd, { recursive: true, force: true }); }
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
