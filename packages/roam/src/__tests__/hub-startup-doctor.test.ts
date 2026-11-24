import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runLocalDoctor } from "../local-diagnostics";
import { inspectHubService } from "../hub-service-diagnostics";
import { main } from "../cli";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(enabled = true, role = "hub") {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "hubd-")); roots.push(root);
  mkdirSync(join(root, "roam/logs"), { recursive: true, mode: 0o700 });
  const machineId = "00000000-0000-4000-8000-000000000001";
  writeFileSync(join(root, "roam/config.json"), JSON.stringify({ enabled, role, machineId, hubMachineId: machineId, peers: [], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  writeFileSync(join(root, "roam/logs/hub.err.log"), "private fixture log contents", { mode: 0o600 });
  writeFileSync(join(root, "roam/machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  return root;
}

it.each([
  { running: false, socketAvailable: false, lastExitCode: 1 },
  { running: false, socketAvailable: true, lastExitCode: 23 },
  { running: true, socketAvailable: false, lastExitCode: 0 },
])("doctor blocks an enabled hub when service readiness is missing: %j", async state => {
  const root = fixture(), before = readFileSync(join(root, "roam/config.json"), "utf8");
  const report = await runLocalDoctor({ root, hubService: async () => state });
  const issue = report.diagnostics.find(row => row.reason.startsWith("hub-startup-pending:"));
  expect(issue).toMatchObject({ severity: "block", repairCommand: "spider roam enable" });
  expect(issue?.reason).toContain(`Last exit code: ${state.lastExitCode}`);
  expect(issue?.reason).toContain(join(root, "roam/logs/hub.err.log"));
  expect(JSON.stringify(report)).not.toContain("private fixture log contents");
  expect(readFileSync(join(root, "roam/config.json"), "utf8")).toBe(before);
});

it("a healthy enabled hub has no startup diagnostic", async () => {
  const root = fixture();
  const report = await runLocalDoctor({ root, hubService: async () => ({ running: true, socketAvailable: true, lastExitCode: 0 }) });
  expect(report.diagnostics.filter(row => row.reason.startsWith("hub-startup"))).toEqual([]);
});

it("disabled roaming does not query or diagnose hub startup", async () => {
  const root = fixture(false), query = vi.fn(async () => { throw new Error("disabled hubs need no running service"); });
  const report = await runLocalDoctor({ root, hubService: query });
  expect(query).not.toHaveBeenCalled();
  expect(report.diagnostics.filter(row => row.reason.startsWith("hub-startup"))).toEqual([]);
});

it.each([
  { code: 0, stdout: "state = spawn scheduled\nlast exit code = 1\n", running: false, lastExitCode: 1 },
  { code: 0, stdout: "state = running\npid = 123\nlast exit code = 0\n", running: true, lastExitCode: 0 },
  { code: 113, stdout: "", running: false, lastExitCode: null },
  { code: null, stdout: "", running: null, lastExitCode: null },
  { code: 0, stdout: "", running: null, lastExitCode: null },
])("service metadata is distinguished from missing or unknown state: %j", async row => {
  const root = fixture();
  expect(await inspectHubService(root, async () => row)).toEqual({ running: row.running, lastExitCode: row.lastExitCode, socketAvailable: false });
});

it("doctor's default observer reports a failed service without opening the error log", async () => {
  const root = fixture(), binary = join(root, "service-manager");
  writeFileSync(binary, "#!/bin/sh\nprintf 'state = spawn scheduled\\nlast exit code = 1\\n'\n", { mode: 0o700 });
  vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", binary);
  const report = await runLocalDoctor({ root });
  expect(report.diagnostics).toContainEqual(expect.objectContaining({ severity: "block", reason: expect.stringContaining("Last exit code: 1"), repairCommand: "spider roam enable" }));
  expect(JSON.stringify(report)).not.toContain("private fixture log contents");
});

it("the public JSON doctor returns a blocked startup issue with exit metadata and repair", async () => {
  const root = fixture(), binary = join(root, "service-manager");
  writeFileSync(binary, "#!/bin/sh\nprintf 'state = spawn scheduled\\nlast exit code = 1\\n'\n", { mode: 0o700 });
  vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", binary);
  const out: string[] = [], err: string[] = [];
  expect(await main(["roam", "doctor", "--json"], { out: text => out.push(text), err: text => err.push(text) })).toBe(1);
  const report = JSON.parse(out.join(""));
  expect(report).toMatchObject({ code: 1, reason: "doctor-blocked", value: { enabled: true } });
  expect(report.value.diagnostics).toContainEqual(expect.objectContaining({ severity: "block", reason: expect.stringContaining("hub-startup-pending:"), repairCommand: "spider roam enable" }));
  expect(out.join("")).toContain("Last exit code: 1"); expect(out.join("")).toContain(join(root, "roam/logs/hub.err.log"));
  expect(out.join("") + err.join("")).not.toContain("private fixture log contents");
});
