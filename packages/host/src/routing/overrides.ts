import { Type } from "typebox";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { recordResult } from "./tracking";
import type { Db } from "@spider/db-core";

export function validateDescription(desc: unknown): string | null {
  if (typeof desc !== "string" || desc.trim() === "")
    return "A one-line `description` is required for edit/write: explain WHY this change is made.";
  if (desc.includes("\n")) return "`description` must be a single line (no newlines).";
  return null;
}

export function countPatchLines(patch: string): { added: number; removed: number } {
  let added = 0,
    removed = 0;
  for (const line of (patch ?? "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function errorResult(message: string) {
  return { content: [{ type: "text", text: message }], details: {}, isError: true };
}

export interface OverrideDeps {
  db: Db;
  getSessionId: () => string;
  getCwd: () => string;
  makeEditDelegate?: (cwd: string) => { execute: Function };
  makeWriteDelegate?: (cwd: string) => { execute: Function };
}

export function registerEditWriteOverrides(pi: { registerTool: Function }, deps: OverrideDeps): void {
  const editDelegate = deps.makeEditDelegate ?? ((cwd: string) => createEditToolDefinition(cwd));
  const writeDelegate = deps.makeWriteDelegate ?? ((cwd: string) => createWriteToolDefinition(cwd));
  pi.registerTool({
    name: "edit",
    label: "Edit",
    description: "Edit a file by replacing text. Requires a one-line `description` of the change.",
    parameters: Type.Object({
      path: Type.String({ description: "File to edit." }),
      description: Type.String({ description: "One-line explanation of WHY this edit is made (no newlines)." }),
      edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
    }),
    async execute(toolCallId: string, params: any, signal: unknown, onUpdate: unknown, ctx: any) {
      const err = validateDescription(params?.description);
      if (err) return errorResult(err);
      const { description, ...rest } = params;
      const delegate = editDelegate(deps.getCwd());
      const result: any = await delegate.execute(toolCallId, rest, signal, onUpdate, ctx);
      if (!result?.isError) {
        const { added, removed } = countPatchLines(result?.details?.patch ?? "");
        recordResult(deps.db, { sessionId: deps.getSessionId(), tool: "edit", description, added, removed });
      }
      return result;
    },
  });
  pi.registerTool({
    name: "write",
    label: "Write",
    description: "Write (create/overwrite) a file. Requires a one-line `description` of the change.",
    parameters: Type.Object({
      path: Type.String({ description: "File to write." }),
      description: Type.String({ description: "One-line explanation of WHY this file is written (no newlines)." }),
      content: Type.String({ description: "Full file content." }),
    }),
    async execute(toolCallId: string, params: any, signal: unknown, onUpdate: unknown, ctx: any) {
      const err = validateDescription(params?.description);
      if (err) return errorResult(err);
      const { description, ...rest } = params;
      const cwd = deps.getCwd();
      const abs = isAbsolute(rest.path) ? rest.path : join(cwd, rest.path);
      let removed = 0;
      try {
        if (existsSync(abs)) removed = readFileSync(abs, "utf-8").split("\n").length;
      } catch {}
      const added = String(rest.content ?? "").split("\n").length;
      const delegate = writeDelegate(cwd);
      const result: any = await delegate.execute(toolCallId, rest, signal, onUpdate, ctx);
      if (!result?.isError) recordResult(deps.db, { sessionId: deps.getSessionId(), tool: "write", description, added, removed });
      return result;
    },
  });
}
