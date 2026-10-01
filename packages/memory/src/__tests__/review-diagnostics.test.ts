import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { persistReviewError } from "../review-diagnostics";
let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
it("rotates diagnostics at 1 MiB and redacts provider error text", () => {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true }); root = mkdtempSync(join(scratch, "review-log-")); execFileSync("git", ["init", "-q", root]);
  const dir = join(root, ".spider", "logs"); mkdirSync(dir, { recursive: true });
  const file = join(dir, "reviewer-errors.jsonl"); writeFileSync(file, "x".repeat(1024*1024));
  persistReviewError(root, "skill", "api_key=SECRET password=HIDDEN Bearer AUTH", "raw reply");
  expect(statSync(file).size).toBeLessThanOrEqual(1024*1024);
  const record = JSON.parse(readFileSync(file, "utf8"));
  expect(record.error).not.toMatch(/SECRET|HIDDEN|AUTH/); expect(record.error).toContain("redacted"); expect(record.rawReply).toBe("raw reply");
  expect(statSync(file).mode & 0o777).toBe(0o600);
});
