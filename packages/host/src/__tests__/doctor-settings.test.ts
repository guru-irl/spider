import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setGlobalDbPathForTests } from "@spider/db-core";
import spiderExtension from "../extension";

const root = join(process.cwd(), ".spider", "scratch", `doctor-settings-${process.pid}`);
afterEach(() => { setGlobalDbPathForTests(null); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function doctor(getSettings: () => unknown, model?: { provider: string; id: string }) {
  mkdirSync(root, { recursive: true }); execFileSync("git", ["init", "-q", root]);
  setGlobalDbPathForTests(join(root, "global.db")); vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  const tools = new Map<string, any>(); const shutdown: Function[] = [];
  spiderExtension({ registerTool: (t: any) => tools.set(t.name, t), registerCommand() {}, getSettings, on(name: string, fn: Function) { if (name === "session_shutdown") shutdown.push(fn); } } as never);
  try { return await tools.get("spider").execute("doctor", { action: "control", command: "doctor" }, undefined, undefined, { cwd: root, model }); }
  finally { for (const fn of shutdown) await fn({ reason: "exit" }); }
}

it("reports effective settings including active-model compaction overrides and never prints the whole settings object", async () => {
  const secret = "ghp_" + "d".repeat(36);
  const snapshot = Object.freeze({
    compaction: Object.freeze({ enabled: false, reserveTokens: 1234, keepRecentTokens: 4567, modelOverrides: { "fixture/model": { reserveTokens: 4321 } }, privateField: secret }),
    cacheWarming: "idle", codemode: Object.freeze({ mode: "only", inlineBudget: 0, privateField: secret }),
    tuiMode: "regular", enableInstallTelemetry: false, httpProxy: secret, trackingId: secret,
  });
  const before = JSON.stringify(snapshot);
  const result = await doctor(() => snapshot, { provider: "fixture", id: "model" });
  const lines = result.details.lines.join("\n");
  expect(lines).toContain("pi compaction: enabled=false reserveTokens=4321 keepRecentTokens=4567");
  expect(lines).toContain("pi cache warming: idle");
  expect(lines).toContain("pi codemode: mode=only inlineBudget=0");
  expect(lines).toContain("pi TUI mode: regular");
  expect(lines).toContain("pi install telemetry: false");
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain("httpProxy");
  expect(JSON.stringify(snapshot)).toBe(before);
});

it("reports pi defaults when effective settings omit optional values", async () => {
  const lines = (await doctor(() => ({}))).details.lines.join("\n");
  expect(lines).toContain("pi compaction: enabled=true reserveTokens=16384 keepRecentTokens=20000");
  expect(lines).toContain("pi cache warming: streaming");
  expect(lines).toContain("pi codemode: mode=on inlineBudget=3000");
  expect(lines).toContain("pi TUI mode: fullscreen");
  expect(lines).toContain("pi install telemetry: true");
});

it("reports a fractional codemode inline budget accepted by pi", async () => {
  const lines = (await doctor(() => ({ codemode: { inlineBudget: 12.5 } }))).details.lines.join("\n");
  expect(lines).toContain("pi codemode: mode=on inlineBudget=12.5");
});

it("withholds malformed values even inside allowlisted fields", async () => {
  const secret = "ghp_" + "d".repeat(36);
  const result = await doctor(() => ({ compaction: { reserveTokens: secret }, cacheWarming: secret, codemode: { mode: secret, inlineBudget: secret }, tuiMode: secret, enableInstallTelemetry: secret }));
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.details.lines.join("\n")).toContain("invalid");
});

it("keeps settings-reader errors bounded and secret-safe", async () => {
  const secret = "ghp_" + "d".repeat(36);
  const result = await doctor(() => { throw new Error(secret + "x".repeat(10000)); });
  const line = result.details.lines.find((line: string) => line.includes("pi settings unavailable"));
  expect(line).toBeDefined(); expect(line.length).toBeLessThan(600);
  expect(JSON.stringify(result)).not.toContain(secret);
});
