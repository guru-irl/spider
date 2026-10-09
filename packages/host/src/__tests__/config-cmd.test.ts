import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { openDbAt, paths } from "@spider/db-core";
import { readInjectionSnapshot } from "../injection-snapshot.js";
import { applyConfigEdit } from "../control/config-cmd.js";
import { getField } from "@spider/ui";
import { UI_CONFIG_SCHEMA } from "../ui-thinking";
import { productionReaders } from "./config-reader-analysis.js";
import { resolve } from "node:path";
import { controlConfig } from "../control.js";

const scratch = join(process.cwd(), ".spider/scratch/host-tests/config-cmd");
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
    const previousGlobalRoot = paths.globalRoot;
    paths.globalRoot = join(dir, "global");
    mkdirSync(paths.globalRoot, { recursive: true });
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
    } finally { paths.globalRoot = previousGlobalRoot; }
  });
  it.each([
    ["organism.enabled", "false"], ["organism.passes.runMemoryTodo", "false"],
    ["organism.passes.todoMemory", "false"], ["organism.passes.learning", "false"],
    ["organism.passes.consolidation", "false"], ["organism.passes.reflection", "false"],
    ["organism.passes.insights", "false"], ["organism.selfNaming", "false"],
    ["organism.autoWriteBudget", "4"], ["curator.staleAfterDays", "10"],
    ["curator.archiveAfterDays", "20"], ["curator.minIntervalHours", "12"],
    ["curator.consolidate", "false"], ["routing.secret_scrub", "false"],
    ["routing.injection_scan", "false"], ["routing.auto_index_threshold", "10000"],
    ["memory.reviewer.thinking", "max"], ["skills.reviewer.thinking", "off"],
    ["models.defaults", '{"worker":"github-copilot/example"}'],
    ["auxiliary.background_review.provider", "provider"],
    ["auxiliary.background_review.model", "model"],
  ])("accepts production reader %s through control config set", (key, raw) => {
    const dir = fixture();
    expect(applyConfigEdit(dir, key, raw)).toMatchObject({ ok: true, scope: "local", file: join(dir, ".spider", "config.json") });
    expect(controlConfig("get", dir, key)).toEqual((key.startsWith("auxiliary.") || key.endsWith(".thinking")) ? raw : JSON.parse(raw));
  });
  it("every reachable production reader has a schema field accepted by config set except user-only security settings", () => {
    const dir = fixture();
    const previous = paths.globalRoot;
    paths.globalRoot = join(dir, "global");
    try {
      const declared = new Set(UI_CONFIG_SCHEMA.flatMap(group => group.fields.map(field => field.key)));
      for (const key of productionReaders(resolve("packages"))) {
        expect(declared.has(key), key).toBe(true);
        const field = getField(key, UI_CONFIG_SCHEMA)!;
        const raw = field.type === "model-ref" ? "fixture/model" : field.type === "model-map" ? "{}" : field.type === "absolute-path-list" ? "[]" : field.type === "number" ? String(field.exclusiveMin !== undefined ? field.exclusiveMin + 1 : field.min ?? field.default) : field.type === "enum" ? String(field.enum?.[0]) : field.type === "boolean" ? "false" : "example";
        if (["exec.enforce", "subagents.extensions"].includes(key)) {
          expect(applyConfigEdit(dir, key, raw).ok, key).toBe(false);
        } else if (field.scope === "global") {
          expect(applyConfigEdit(dir, key, raw).ok, key).toBe(false);
          expect(applyConfigEdit(dir, key, raw, "global"), key).toMatchObject({ ok: true, scope: "global", file: join(paths.globalRoot, "config.json") });
        } else {
          expect(applyConfigEdit(dir, key, raw), key).toMatchObject({ ok: true, scope: "local", file: join(dir, ".spider", "config.json") });
        }
      }
    } finally { paths.globalRoot = previous; }
  });
  it("rejects an unknown key", () => {
    const dir = fixture();
    expect(applyConfigEdit(dir, "nope.nope", "x").ok).toBe(false);
  });
});
