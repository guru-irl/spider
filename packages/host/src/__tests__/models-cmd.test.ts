import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "@spider/db-core";
import { execFileSync } from "node:child_process";
import { setModelDefault, clearLocalModelDefault } from "../control/models-cmd.js";
import { controlConfig, modelDefaultLayers } from "../control.js";
import type { ModelEntry } from "@spider/models";

const cleanups: (() => void)[] = [];
const originalGlobalRoot = paths.globalRoot;
afterEach(() => { paths.globalRoot = originalGlobalRoot; for (const c of cleanups.splice(0)) c(); });

function isolatedGlobal(): string {
  const root = join(scratchDir(), "global");
  paths.globalRoot = root;
  return root;
}

// paths.projectRoot() resolves via `git rev-parse --show-toplevel` from cwd, walking UP to
// the nearest enclosing repo. A bare mkdtemp'd dir nested inside THIS repo's worktree is
// therefore never its own project root — every controlConfig write lands in spider's own
// real `.spider/config.json` (verified: it happened, mutating this repo's actual dev config
// with test literals). git-init the temp dir so it is its own worktree root, same pattern as
// exec-enforce-protection.test.ts.
function scratchDir(): string {
  const scratch = join(process.cwd(), "packages/host/.spider/scratch");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "mdl-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  return dir;
}

// Shape of the live catalog `setModelDefault` validates against (control models set is a
// "can I actually run this?" question — same usable-only catalog `listCatalog` returns).
function entry(provider: string, id: string): ModelEntry {
  return { provider, id, tier: "standard", thinking: true, vision: true, ctx: 200_000, speed: 2, costHint: 0.5, available: true };
}
const CATALOG: ModelEntry[] = [
  entry("github-copilot", "claude-sonnet-5"),
  entry("github-copilot", "claude-opus-5"),
];

describe("setModelDefault", () => {
  for (const layer of ["global", "local"] as const) {
    it(`reports invalid models.defaults in the ${layer} layer on read`, () => {
      const root = isolatedGlobal();
      const dir = scratchDir();
      const file = join(layer === "global" ? root : join(dir, ".spider"), "config.json");
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, '{"models.defaults": ["not a map"]}');
      const result = modelDefaultLayers(dir);
      expect(result.defaults).toEqual({});
      expect(result.errors.join(" ")).toContain(`invalid models.defaults in ${file}: expected an object`);
    });
  }

  it("warns that a malformed local file may override a global model set", () => {
    isolatedGlobal();
    const dir = scratchDir();
    const file = join(dir, ".spider", "config.json");
    mkdirSync(join(dir, ".spider"), { recursive: true });
    const bad = '{"models.defaults": {"worker": "older/model"}, }';
    writeFileSync(file, bad);
    const result = setModelDefault(dir, "worker", "github-copilot/claude-sonnet-5", CATALOG);
    expect(result).toMatchObject({ ok: true });
    expect(result.errors?.join(" ")).toContain(file);
    expect(readFileSync(file, "utf8")).toBe(bad);
  });
  it("does not create a local file when clearing a role with no local override", () => {
    isolatedGlobal();
    const dir = scratchDir();
    const file = join(dir, ".spider", "config.json");
    expect(clearLocalModelDefault(dir, "worker")).toEqual({ ok: true, cleared: false });
    expect(existsSync(file)).toBe(false);
    controlConfig("set", dir, "models.defaults", { reviewer: "github-copilot/claude-opus-5" });
    const before = readFileSync(file, "utf8");
    expect(clearLocalModelDefault(dir, "worker")).toEqual({ ok: true, cleared: false });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("preserves non-string map entries while changing only the requested role", () => {
    const root = isolatedGlobal();
    const dir = scratchDir();
    controlConfig("set", dir, "models.defaults", { planner: { nested: 1 }, worker: "old/model" }, "global");
    expect(setModelDefault(dir, "worker", "github-copilot/claude-sonnet-5", CATALOG)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8"))["models.defaults"]).toEqual({ planner: { nested: 1 }, worker: "github-copilot/claude-sonnet-5" });
    controlConfig("set", dir, "models.defaults", { planner: { nested: 1 }, worker: "old/model" });
    expect(clearLocalModelDefault(dir, "worker")).toEqual({ ok: true, cleared: true });
    expect((controlConfig("get", dir) as Record<string, unknown>)["models.defaults"]).toEqual({ worker: "github-copilot/claude-sonnet-5" });
    expect(JSON.parse(readFileSync(join(dir, ".spider", "config.json"), "utf8"))["models.defaults"]).toEqual({ planner: { nested: 1 } });
  });
  it("merges successive role defaults into models.defaults", () => {
    const root = isolatedGlobal();
    const dir = scratchDir();
    expect(setModelDefault(dir, "worker", "github-copilot/claude-sonnet-5", CATALOG)).toEqual({ ok: true });
    expect(setModelDefault(dir, "reviewer", "github-copilot/claude-opus-5", CATALOG)).toEqual({ ok: true });
    const cfg = controlConfig("get", scratchDir(), "models.defaults") as Record<string, string>;
    expect(cfg).toEqual({ worker: "github-copilot/claude-sonnet-5", reviewer: "github-copilot/claude-opus-5" });
    expect(existsSync(join(root, "config.json"))).toBe(true);
    expect(existsSync(join(dir, ".spider", "config.json"))).toBe(false);
  });

  it("rejects an unknown role", () => {
    const dir = scratchDir();
    const r = setModelDefault(dir, "bogus", "github-copilot/claude-sonnet-5", CATALOG);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  // Root cause this guards: models.defaults was write-only — control models set wrote
  // config, control models read it back, and NOTHING else ever validated or consumed it,
  // so a typo'd ref just silently never resolved at spawn time. Reject it at write time.
  it("rejects a ref absent from the live catalog, listing the valid refs in the error", () => {
    const dir = scratchDir();
    const r = setModelDefault(dir, "worker", "github-copilot/does-not-exist", CATALOG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("github-copilot/claude-sonnet-5");
    expect(r.error).toContain("github-copilot/claude-opus-5");
  });

  // Root cause this guards: the persisted refs named provider `copilot`, which is not a
  // real pi provider id and not an alias anywhere in spider — the real id is `github-copilot`.
  it("normalises the stale 'copilot/' prefix to 'github-copilot/' when the corrected ref resolves in the catalog", () => {
    isolatedGlobal();
    const dir = scratchDir();
    expect(setModelDefault(dir, "worker", "copilot/claude-sonnet-5", CATALOG)).toEqual({ ok: true });
    expect(controlConfig("get", dir, "models.defaults")).toEqual({ worker: "github-copilot/claude-sonnet-5" });
  });

  it("does not normalise a stale prefix whose corrected form is still absent from the catalog", () => {
    const dir = scratchDir();
    const r = setModelDefault(dir, "worker", "copilot/nonexistent-model", CATALOG);
    expect(r.ok).toBe(false);
  });

  it("keeps a local role override while inheriting other roles from global defaults", () => {
    isolatedGlobal();
    const dir = scratchDir();
    expect(setModelDefault(dir, "worker", "github-copilot/claude-sonnet-5", CATALOG)).toEqual({ ok: true });
    expect(setModelDefault(dir, "reviewer", "github-copilot/claude-opus-5", CATALOG)).toEqual({ ok: true });
    controlConfig("set", dir, "models.defaults", { worker: "github-copilot/claude-opus-5" });
    expect(controlConfig("get", dir, "models.defaults")).toEqual({
      worker: "github-copilot/claude-opus-5", reviewer: "github-copilot/claude-opus-5",
    });
  });

  it("reports the local role and its file when a global set is shadowed", () => {
    isolatedGlobal();
    const dir = scratchDir();
    controlConfig("set", dir, "models.defaults", { worker: "github-copilot/claude-opus-5", reviewer: "github-copilot/claude-opus-5" });
    expect(setModelDefault(dir, "worker", "github-copilot/claude-sonnet-5", CATALOG)).toEqual({
      ok: true, shadowedBy: { ref: "github-copilot/claude-opus-5", file: join(dir, ".spider", "config.json") },
    });
    expect(clearLocalModelDefault(dir, "worker")).toEqual({ ok: true, cleared: true });
    expect(controlConfig("get", dir, "models.defaults")).toEqual({
      worker: "github-copilot/claude-sonnet-5", reviewer: "github-copilot/claude-opus-5",
    });
  });

  it("accepts a bare model id (no provider) present in the catalog under any provider", () => {
    isolatedGlobal();
    const dir = scratchDir();
    expect(setModelDefault(dir, "worker", "claude-sonnet-5", CATALOG)).toEqual({ ok: true });
  });
});
