import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runLocalDoctor } from "../local-diagnostics";
import { inspectHubService, hubStartupDiagnostics } from "../hub-service-diagnostics";
import * as controlSocket from "../control-socket";
import { main } from "../cli";
import { hubServiceFile } from "../launchd";
import { serveV0Control } from "../relocate/service";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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
  expect(issue).toMatchObject({ severity: "block" });
  expect(issue?.repairCommand).toBe('spider roam enable');
  expect(issue?.reason).toContain("Check the hub service and its error log");
  expect(issue?.reason).not.toMatch(/spider roam (enable|doctor)/);
  expect(issue?.reason).toContain(`Last exit code: ${state.lastExitCode}`);
  expect(issue?.reason).toContain(join(root, "roam/logs/hub.err.log"));
  expect(JSON.stringify(report)).not.toContain("private fixture log contents");
  expect(readFileSync(join(root, "roam/config.json"), "utf8")).toBe(before);
});

it("doctor inspects the v0 control socket and points to the v0 service log", async () => {
  const root=fixture(), directory=join(root,"Library","LaunchAgents");
  mkdirSync(directory,{recursive:true});writeFileSync(hubServiceFile(root,directory,"v0"),"fixture definition");
  const unexpected=async()=>{throw new Error("doctor must not send a mutation request");};
  const endpoint=await serveV0Control(root,{relocate:unexpected,setHome:unexpected});
  try {
    const state=await inspectHubService(root,async()=>({code:0,stdout:"state = running\npid = 123\n"}));
    expect(state).toMatchObject({running:true,socketAvailable:true});
    expect(hubStartupDiagnostics(root,state)).toEqual([]);
  } finally {await endpoint.close();}
  const stopped=await inspectHubService(root,async()=>({code:113,stdout:""}));
  expect(hubStartupDiagnostics(root,stopped)[0]?.reason).toContain(join(root,"roam/logs/hub-v0.err.log"));
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

it("a missing socket with unknown service state is reported without waiting", async () => {
  const root = fixture(); vi.useFakeTimers(); vi.setSystemTime(0);
  let state: Awaited<ReturnType<typeof inspectHubService>> | undefined;
  void inspectHubService(root, async () => ({ code: null, stdout: "" })).then(value => { state = value; });
  await vi.advanceTimersByTimeAsync(0);
  expect(state).toEqual({ running: null, socketAvailable: false, lastExitCode: null });
});

it("doctor reports an unanswered hub within its two-second deadline including metadata", async () => {
  const root = fixture(); vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(controlSocket, "requestHubControl").mockImplementation((_file, _request, options) =>
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Hub control timed out")), options!.timeoutMs)));
  let observed: Awaited<ReturnType<typeof inspectHubService>> | undefined;
  const pending = runLocalDoctor({ root, hubService: () => inspectHubService(root, () => new Promise(resolve =>
    setTimeout(() => resolve({ code: 0, stdout: "state = running\npid = 123\nlast exit code = 0\n" }), 1200)))
    .then(value => { observed = value; return value; }) });
  await vi.advanceTimersByTimeAsync(2000);
  expect(observed).toEqual({ running: true, socketAvailable: false, lastExitCode: 0 });
  const report = await pending;
  expect(report.diagnostics).toContainEqual(expect.objectContaining({ severity: "block", reason: expect.stringContaining("hub-startup-pending:") }));
});

it("reports unavailable service metadata within the same two-second deadline", async () => {
  const root = fixture(); vi.useFakeTimers(); vi.setSystemTime(0);
  let state: Awaited<ReturnType<typeof inspectHubService>> | undefined;
  void inspectHubService(root, () => new Promise(() => {})).then(value => { state = value; });
  await vi.advanceTimersByTimeAsync(2000);
  expect(state).toEqual({ running: null, socketAvailable: false, lastExitCode: null });
});

it.each([
  { code: 0, stdout: "state = spawn scheduled\nlast exit code = 1\n", running: false, lastExitCode: 1 },
  { code: 0, stdout: "state = running\npid = 123\nlast exit code = 0\n", running: true, lastExitCode: 0 },
  { code: 113, stdout: "", running: false, lastExitCode: null },
  { code: null, stdout: "", running: null, lastExitCode: null },
  { code: 0, stdout: "", running: null, lastExitCode: null },
])("service metadata is distinguished from missing or unknown state: %j", async row => {
  const root = fixture(); vi.useFakeTimers();
  vi.spyOn(controlSocket, "requestHubControl").mockRejectedValue(new Error("No answering hub"));
  const pending = inspectHubService(root, async () => row);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toEqual({ running: row.running, lastExitCode: row.lastExitCode, socketAvailable: false });
});

it("a starting service becomes healthy when its status probe answers within the bound", async () => {
  vi.useFakeTimers();
  const root = fixture();
  const probe = vi.spyOn(controlSocket, "requestHubControl").mockImplementation(async (file, request, options) => {
    expect(file).toBe(join(root, "roam/hub.sock"));
    expect(request).toEqual({ op: "status" });
    expect(options?.timeoutMs).toBeLessThanOrEqual(500);
    if (Date.now() < 100) throw new Error("Socket not created yet");
    return { code: 0, reason: "ready", value: { enabled: true } };
  });
  vi.setSystemTime(0);
  const pending = inspectHubService(root, async () => ({ code: 0, stdout: "state = running\npid = 123\n" }));
  await vi.advanceTimersByTimeAsync(100);
  const state = await pending;
  expect(state).toMatchObject({ running: true, socketAvailable: true });
  expect(hubStartupDiagnostics(root, state)).toEqual([]);
  expect(probe).toHaveBeenCalled();
});

it("a real ready control socket is healthy and receives only a status request", async () => {
  const root = fixture(), before = readFileSync(join(root, "roam/config.json"), "utf8");
  const requests: controlSocket.HubControlRequest[] = [];
  const socket = await controlSocket.startHubControl(join(root, "roam/hub.sock"), async request => {
    requests.push(request); return { code: 0, reason: "ready", value: { enabled: true } };
  });
  try {
    const state = await inspectHubService(root, async () => ({ code: 0, stdout: "state = running\npid = 123\n" }));
    expect(hubStartupDiagnostics(root, state)).toEqual([]);
    expect(requests).toEqual([{ op: "status" }]);
    expect(readFileSync(join(root, "roam/config.json"), "utf8")).toBe(before);
  } finally { await socket.close(); }
});

it.each([
  null,
  { code: 0, reason: "disabled", value: { enabled: false } },
  { code: 1, reason: "unavailable", value: null },
])("an existing socket without a ready hub is blocked after bounded status probes: %j", async reply => {
  const root = fixture(), socket = await controlSocket.startHubControl(join(root, "roam/hub.sock"), async () => reply as controlSocket.HubControlReply ?? { code: 1, reason: "unavailable", value: null });
  vi.useFakeTimers(); vi.setSystemTime(0);
  const probe = vi.spyOn(controlSocket, "requestHubControl");
  if (reply) probe.mockResolvedValue(reply as controlSocket.HubControlReply);
  else probe.mockRejectedValue(Object.assign(new Error("Stale socket"), { code: "ECONNREFUSED" }));
  try {
    const pending = inspectHubService(root, async () => ({ code: 0, stdout: "state = running\npid = 123\n" }));
    await vi.advanceTimersByTimeAsync(2000);
    const state = await pending;
    expect(state).toMatchObject({ running: true, socketAvailable: false });
    expect(hubStartupDiagnostics(root, state)).toContainEqual(expect.objectContaining({ severity: "block" }));
    expect(Date.now()).toBe(2000);
    expect(probe.mock.calls.length).toBeLessThanOrEqual(40);
  } finally { await socket.close(); }
});

it("unknown service metadata and a missing status reply warn instead of blocking", async () => {
  const root = fixture(); vi.useFakeTimers();
  vi.spyOn(controlSocket, "requestHubControl").mockRejectedValue(new Error("No answering hub"));
  const pending = inspectHubService(root, async () => ({ code: null, stdout: "" }));
  await vi.advanceTimersByTimeAsync(2000);
  const state = await pending;
  expect(hubStartupDiagnostics(root, state)).toContainEqual(expect.objectContaining({ severity: "warning", reason: expect.stringContaining("hub-startup-unverified:") }));
});

it("doctor's default observer reports a failed service without opening the error log", async () => {
  const root = fixture(), binary = join(root, "service-manager");
  writeFileSync(binary, "#!/bin/sh\nprintf 'state = spawn scheduled\\nlast exit code = 1\\n'\n", { mode: 0o700 });
  vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", binary);
  const report = await runLocalDoctor({ root });
  expect(report.diagnostics).toContainEqual(expect.objectContaining({ severity: "block", reason: expect.stringContaining("Last exit code: 1") }));
  expect(report.diagnostics.find(row => row.reason.startsWith("hub-startup"))?.repairCommand).toBe('spider roam enable');
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
  expect(report.value.diagnostics).toContainEqual(expect.objectContaining({ severity: "block", reason: expect.stringContaining("hub-startup-pending:") }));
  expect(report.value.diagnostics.find((row: { reason: string }) => row.reason.startsWith("hub-startup"))?.repairCommand).toBe('spider roam enable');
  expect(out.join("")).toContain("Last exit code: 1"); expect(out.join("")).toContain(join(root, "roam/logs/hub.err.log"));
  expect(out.join("") + err.join("")).not.toContain("private fixture log contents");
});
