import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { openDbAt, paths } from "@spider/db-core";
import { readInjectionSnapshot } from "../injection-snapshot.js";
import { applyConfigEdit } from "../control/config-cmd.js";
import { controlConfig } from "../control.js";

const scratch = join(process.cwd(), "packages/host/.spider/scratch");
mkdirSync(scratch, { recursive: true });
const fixtures: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(scratch, "cfg-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fixtures.push(dir);
  return dir;
}
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("applyConfigEdit round-trip", () => {
  it("coerces, writes and reads back a boolean", () => {
    const dir = fixture();
    const r = applyConfigEdit(dir, "ui.footer", "false");
    expect(r.ok).toBe(true);
    expect(controlConfig("get", dir, "ui.footer")).toBe(false);
  });
  it("rejects an out-of-range number without writing", () => {
    const dir = fixture();
    const r = applyConfigEdit(dir, "memory.snapshotCharCap", "999999999");
    expect(r.ok).toBe(false);
    expect(controlConfig("get", dir, "memory.snapshotCharCap")).toBeUndefined();
  });
  it("clears a configured snapshot cap back to unlimited through the UI edit path", () => {
    const dir = fixture();
    expect(applyConfigEdit(dir, "memory.snapshotCharCap", "500").ok).toBe(true);
    expect(controlConfig("get", dir, "memory.snapshotCharCap")).toBe(500);
    expect(applyConfigEdit(dir, "memory.snapshotCharCap", "unlimited").ok).toBe(true);
    expect(controlConfig("get", dir, "memory.snapshotCharCap")).toBeUndefined();
  });
  it("clears the UI cap despite a global cap, leaving an unlimited override", () => {
    const dir = fixture();
    writeFileSync(join(paths.globalRoot, "config.json"), JSON.stringify({ "memory.snapshotCharCap": 100 }));
    try {
      const db = openDbAt(join(dir, ".git", "spider", "repo.db"), "repo");
      db.prepare("INSERT INTO memory (uuid, category, content, status, source, created_at) VALUES ('long', 'insight', ?, 'active', 'user', 1)").run("X".repeat(500));
      db.close();
      expect(readInjectionSnapshot(dir).capped).toBe(true);
      expect(applyConfigEdit(dir, "memory.snapshotCharCap", "500").ok).toBe(true);
      expect(applyConfigEdit(dir, "memory.snapshotCharCap", "").ok).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, ".spider", "config.json"), "utf8"))["memory.snapshotCharCap"]).toBe("unlimited");
      const snapshot = readInjectionSnapshot(dir);
      expect(snapshot.capped).toBe(false);
      expect(snapshot.counts.repo.injected).toBe(1);
    } finally { rmSync(join(paths.globalRoot, "config.json"), { force: true }); }
  });
  it("rejects an unknown key", () => {
    const dir = fixture();
    expect(applyConfigEdit(dir, "nope.nope", "x").ok).toBe(false);
  });
});
