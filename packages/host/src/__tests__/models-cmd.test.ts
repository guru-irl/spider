import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setModelDefault } from "../control/models-cmd.js";
import { controlConfig } from "../control.js";
import type { ModelEntry } from "@spider/models";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

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
  it("merges successive role defaults into models.defaults", () => {
    const dir = scratchDir();
    expect(setModelDefault(dir, "worker", "github-copilot/claude-sonnet-5", CATALOG)).toEqual({ ok: true });
    expect(setModelDefault(dir, "reviewer", "github-copilot/claude-opus-5", CATALOG)).toEqual({ ok: true });
    const cfg = controlConfig("get", dir, "models.defaults") as Record<string, string>;
    expect(cfg).toEqual({ worker: "github-copilot/claude-sonnet-5", reviewer: "github-copilot/claude-opus-5" });
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
    const dir = scratchDir();
    expect(setModelDefault(dir, "worker", "copilot/claude-sonnet-5", CATALOG)).toEqual({ ok: true });
    expect(controlConfig("get", dir, "models.defaults")).toEqual({ worker: "github-copilot/claude-sonnet-5" });
  });

  it("does not normalise a stale prefix whose corrected form is still absent from the catalog", () => {
    const dir = scratchDir();
    const r = setModelDefault(dir, "worker", "copilot/nonexistent-model", CATALOG);
    expect(r.ok).toBe(false);
  });

  it("accepts a bare model id (no provider) present in the catalog under any provider", () => {
    const dir = scratchDir();
    expect(setModelDefault(dir, "worker", "claude-sonnet-5", CATALOG)).toEqual({ ok: true });
  });
});
