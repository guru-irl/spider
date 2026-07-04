import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { setModelDefault } from "../control/models-cmd.js";
import { controlConfig } from "../control.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function scratchDir(): string {
  const scratch = join(process.cwd(), "packages/host/.spider/scratch");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "mdl-"));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  return dir;
}

describe("setModelDefault", () => {
  it("merges successive role defaults into models.defaults", () => {
    const dir = scratchDir();
    expect(setModelDefault(dir, "worker", "copilot/claude-sonnet-5")).toEqual({ ok: true });
    expect(setModelDefault(dir, "reviewer", "copilot/claude-opus-4.8")).toEqual({ ok: true });
    const cfg = controlConfig("get", dir, "models.defaults") as Record<string, string>;
    expect(cfg).toEqual({ worker: "copilot/claude-sonnet-5", reviewer: "copilot/claude-opus-4.8" });
  });

  it("rejects an unknown role", () => {
    const dir = scratchDir();
    const r = setModelDefault(dir, "bogus", "copilot/x");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
