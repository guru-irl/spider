import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
const entry = vi.hoisted(() => ({ main: true }));
const run = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../server-entry.js", () => ({ isUsageServerMain: () => entry.main, runUsageServerEntry: run }));
it("standalone entry supplies assets resolved from the running module, not cwd", async () => {
  entry.main = true; vi.resetModules(); run.mockClear();
  await import("../../extension.js");
  expect(run).toHaveBeenCalledOnce();
  const args = run.mock.calls[0] as unknown as [string, { dashboardDir: string; startParticipant: unknown }];
  expect(args[1].dashboardDir).toBe(new URL("./dashboard/", args[0]).pathname);
  expect(typeof args[1].startParticipant).toBe("function");
});
it("ordinary source import leaves a temporary cwd untouched and skips asset loading", async () => {
  vi.resetModules(); entry.main = false; run.mockClear();
  const scratch = resolve(".spider/scratch/usage-dashboard-assets/inert"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "entry-")); writeFileSync(join(root, "sentinel"), "unchanged");
  const previousCwd = process.cwd(), previousExit = process.exitCode;
  try {
    process.chdir(root); await import("../../extension.js"); await new Promise(resolve => setImmediate(resolve));
    expect(run).not.toHaveBeenCalled(); expect(process.exitCode).toBe(previousExit);
    expect(readdirSync(root)).toEqual(["sentinel"]); expect(readFileSync(join(root, "sentinel"), "utf8")).toBe("unchanged");
  } finally { process.chdir(previousCwd); process.exitCode = previousExit; entry.main = true; rmSync(root, { recursive: true, force: true }); }
});
