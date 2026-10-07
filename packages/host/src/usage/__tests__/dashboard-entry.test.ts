import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
const entry = vi.hoisted(() => ({ main: true, evaluations: 0 }));
const crash = vi.hoisted(() => vi.fn(async (_dir: string, _code: string) => {}));
vi.mock("../server-entry.js", () => ({ isUsageServerMain: () => entry.main, runUsageServerEntry: vi.fn() }));
vi.mock("../server-runtime.js", async original => ({ ...await original<typeof import("../server-runtime.js")>(), writeUsageServerCrashCode: crash }));
vi.mock("virtual:spider-usage-dashboard", () => { entry.evaluations++; throw new Error("private lazy-import details"); });

it("failed lazy page import records a fixed crash code before exiting", async () => {
  entry.main = true; vi.resetModules();
  const previous = process.exitCode; process.exitCode = undefined;
  let release: (() => void) | undefined;
  crash.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  try {
    await import("../../extension.js");
    await vi.waitFor(() => expect(crash).toHaveBeenCalledWith(process.cwd(), "usage-server-startup-invalid"));
    expect(process.exitCode).not.toBe(1);
    release!();
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(JSON.stringify(crash.mock.calls)).not.toContain("private");
  } finally { release?.(); await new Promise(resolve => setImmediate(resolve)); process.exitCode = previous; }
});

it("ordinary source import leaves a temporary cwd untouched and skips the dashboard factory", async () => {
  vi.resetModules(); entry.main = false;
  const scratch = resolve(".spider/scratch/usage-ui/final-round"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "inert-entry-"));
  writeFileSync(join(root, "sentinel"), "unchanged");
  const previousCwd = process.cwd(), previousExit = process.exitCode, previousEvaluations = entry.evaluations;
  crash.mockClear();
  const real = await vi.importActual<typeof import("../server-runtime.js")>("../server-runtime.js");
  crash.mockImplementation(real.writeUsageServerCrashCode);
  try {
    process.chdir(root);
    await import("../../extension.js");
    // Flush the lazy-import promise chain, including a potential filesystem write.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(crash).not.toHaveBeenCalled();
    expect(entry.evaluations).toBe(previousEvaluations);
    expect(process.exitCode).toBe(previousExit);
    expect(readdirSync(root)).toEqual(["sentinel"]);
    expect(readFileSync(join(root, "sentinel"), "utf8")).toBe("unchanged");
  } finally { process.chdir(previousCwd); process.exitCode = previousExit; entry.main = true; crash.mockImplementation(async () => {}); rmSync(root, { recursive: true, force: true }); }
});
