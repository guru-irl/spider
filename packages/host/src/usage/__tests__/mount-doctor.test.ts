import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { paths, setGlobalDbPathForTests } from "@spider/db-core";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { controlDoctor } from "../../control.js";
import { registerUsage } from "../mount.js";

let root: string, previous: string;
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "mount-doctor-"));
  previous = paths.globalRoot; paths.globalRoot = root;
});
afterEach(() => { paths.globalRoot = previous; setGlobalDbPathForTests(null); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const mount = () => registerUsage({ on() {} } as unknown as ExtensionAPI, "file:///synthetic/extension.js");

it("doctor explains failed startup without secret", async () => {
  const server = join(root, "usage-server"), failures = join(root, "usage-server-failures");
  mkdirSync(server, { mode: 0o700 }); mkdirSync(failures, { mode: 0o700 });
  writeFileSync(join(server, "startup.json"), "corrupt startup synthetic-secret /private/startup-path", { mode: 0o600 });
  writeFileSync(join(server, "lock.json"), "corrupt lock synthetic-secret /private/lock-path", { mode: 0o600 });
  // The old code falls outside the bounded 8192-byte tail. Arbitrary rows never become output.
  writeFileSync(join(server, "crash.log"), "usage-server-build-invalid\n" + "x".repeat(9000) + "\nusage-server-startup-invalid\nsynthetic-secret /private/crash-path\nusage-server-startup-invalid\n", { mode: 0o600 });
  writeFileSync(join(failures, "crash.log"), "usage-server-spawn-failed\nsynthetic-secret /private/failure-path\n", { mode: 0o600 });
  vi.spyOn(Date, "now").mockReturnValue(2000000000);
  utimesSync(join(server, "crash.log"), 2000000, 2000000);
  utimesSync(join(failures, "crash.log"), 2000000, 2000000);
  const result = mount().doctor();
  expect(result).toBeInstanceOf(Promise);
  const report = await result;
  const rows = report.lines.filter(line => line.includes("dashboard server failure"));
  expect(rows).toEqual(["- Last dashboard server failure: usage-server-spawn-failed, 0 seconds ago", "- Last dashboard server failure: usage-server-startup-invalid, 0 seconds ago"]);
  expect(report.ok).toBe(true);
  expect(report.lines.join("\n")).not.toMatch(/synthetic-secret|private|corrupt|usage-server-build-invalid/);
  expect(report.lines.join("\n")).toContain("usage calibration:");
});

it("doctor reads fallback failure codes without following unsafe server links", async () => {
  const unsafe = join(root, "unsafe-target"), failures = join(root, "usage-server-failures");
  mkdirSync(unsafe, { mode: 0o700 }); mkdirSync(failures, { mode: 0o700 });
  writeFileSync(join(unsafe, "crash.log"), "usage-server-crashed\n", { mode: 0o600 });
  symlinkSync(unsafe, join(root, "usage-server"));
  writeFileSync(join(failures, "crash.log"), "usage-server-startup-invalid\n", { mode: 0o600 });
  const report = await mount().doctor();
  expect(report.lines.filter(line => line.includes("dashboard server failure"))).toEqual([expect.stringMatching(/^- Last dashboard server failure: usage-server-startup-invalid, \d+ seconds ago$/)]);
  chmodSync(join(failures, "crash.log"), 0o644);
  expect((await mount().doctor()).lines.join("\n")).not.toContain("usage-server-startup-invalid");
});

it("missing crash records do not create directories and child doctor is inert", async () => {
  expect((await mount().doctor()).ok).toBe(true);
  expect(readdirSync(root)).toEqual([]);
  mkdirSync(join(root, "usage-server"), { mode: 0o700 });
  writeFileSync(join(root, "usage-server", "crash.log"), "usage-server-crashed\n", { mode: 0o600 });
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  expect(await mount().doctor()).toEqual({ ok: true, lines: ["- usage worker: not started (child session)"] });
});

it("doctor uses crash log mtime and hides expired logs", async () => {
  const server = join(root, "usage-server"); mkdirSync(server, { mode: 0o700 });
  const log = join(server, "crash.log"); writeFileSync(log, "usage-server-crashed\n", { mode: 0o600 });
  const now = 2000000000; vi.spyOn(Date, "now").mockReturnValue(now);
  utimesSync(log, (now - 3600000) / 1000, (now - 3600000) / 1000);
  expect((await mount().doctor()).lines).toContain("- Last dashboard server failure: usage-server-crashed, 1 hour ago");
  utimesSync(log, (now - 7 * 86400000 - 1000) / 1000, (now - 7 * 86400000 - 1000) / 1000);
  const report = await mount().doctor(); expect(report.ok).toBe(true);
  expect(report.lines.join("\n")).not.toContain("dashboard server failure");
});

it.each(["usage-server-busy", "usage-server-not-ready", "usage-server-build-invalid", "usage-server-crashed"])("%s leaves healthy spider doctor healthy", async code => {
  const server = join(root, "usage-server"); mkdirSync(server, { mode: 0o700 });
  writeFileSync(join(server, "crash.log"), code + "\n", { mode: 0o600 });
  const usage = await mount().doctor();
  expect(usage.ok).toBe(true);
  execFileSync("git", ["init", "-q", root]);
  setGlobalDbPathForTests(join(root, "spider.db"));
  const report = controlDoctor(root, undefined, undefined, usage);
  expect(report.ok, JSON.stringify(report.lines)).toBe(true);
  expect(report.lines.join("\n")).toContain(`Last dashboard server failure: ${code},`);
});
