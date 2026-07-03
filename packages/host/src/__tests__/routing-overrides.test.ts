import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDbAt, paths, listEvents } from "@spider/db-core";
import {
  validateDescription,
  countPatchLines,
  registerEditWriteOverrides,
} from "../routing/overrides.js";

let dbPath: string;
afterEach(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
});
function mkdb() {
  dbPath = join(paths.scratch("project", process.cwd()), `ovr-${randomUUID()}.db`);
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
