import { appendFileSync, mkdirSync, statSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";

function boundedText(value: unknown): string {
  let text: string;
  try { text = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value) ?? String(value); }
  catch { text = String(value); }
  // Truncate without cutting a UTF-8 code point or growing past 2 KiB on decode.
  while (Buffer.byteLength(text, "utf8") > 2048) text = text.slice(0, Math.max(0, text.length - Math.max(1, Math.ceil((Buffer.byteLength(text, "utf8") - 2048) / 4))));
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return text;
}

/** Same credential redaction as the organism's safeError, without a dependency cycle. */
export function safeReviewError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/\b(?:npm_|gh[opsu]_|sk-)[A-Za-z0-9_-]{8,}/g, "[redacted credential]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|authorization|password|token)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[redacted]")
    .slice(0, 500);
}

/** Raw replies stay on disk, never in model-visible receipts or tool results. */
export function persistReviewError(cwd: string, reviewer: "memory" | "skill", error: string, raw: unknown): void {
  const dir = paths.logs("worktree", cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "reviewer-errors.jsonl");
  const line = JSON.stringify({ ts: Date.now(), reviewer, error: safeReviewError(error), rawReply: boundedText(raw) }) + "\n";
  try {
    if (statSync(file).size + Buffer.byteLength(line, "utf8") > 1024 * 1024) renameSync(file, `${file}.1`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  appendFileSync(file, line, { mode: 0o600 });
  chmodSync(file, 0o600);
}
