import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { paths, assertTestConfigPath, type ThinkingResolution } from "@spider/db-core";

/** Effective thinking is diagnostic metadata, never part of the reviewer's verdict. */
export function reviewerThinkingDiagnostic(cwd: string, reviewer: "memory" | "skill", model: string): (info: ThinkingResolution) => void {
  return info => {
    if (!info.notice) return;
    const dir = paths.logs("worktree", cwd);
    const file = join(dir, "reviewer-thinking.jsonl");
    assertTestConfigPath(file);
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), reviewer, model, ...info }) + "\n";
    try {
      if (statSync(file).size + Buffer.byteLength(line) > 1024 * 1024) renameSync(file, `${file}.1`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    appendFileSync(file, line, { mode: 0o600 });
  };
}
