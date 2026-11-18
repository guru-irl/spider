import { afterEach, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { installSupervisorCorePin } from "../enrollment";
import { main } from "../supervisor-main";
import { join } from "node:path";
import { createClientFixture, type ClientFixture } from "../../../herdr/src/__tests__/testutil";
import * as supervisor from "../production-supervisor";
import type { Clock } from "../contracts";

const fixtures: ClientFixture[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture() {
  const h = await createClientFixture(); fixtures.push(h);
  await h.configure({ roamFixture: {}, fixtureCorePid: 4321 });
  const pin = { binary: h.hcBinary, coreId: "local-core", socket: h.localSocket, sessionNamespace: h.namespace,
    stateHome: h.localEnv.XDG_STATE_HOME!, configHome: h.localEnv.XDG_CONFIG_HOME! };
  return { h, pin };
}

async function enroll(h: ClientFixture) {
  const machineId = "00000000-0000-4000-8000-000000000001", hubMachineId = "00000000-0000-4000-8000-000000000002";
  await mkdir(join(h.root, "roam"), { mode: 0o700 });
  await writeFile(join(h.root, "roam/machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  await writeFile(join(h.root, "roam/config.json"), JSON.stringify({ enabled: true, role: "box", machineId, hubMachineId, peers: [], coreUnit: "fixture.service" }), { mode: 0o600 });
  vi.stubEnv("HERDR_FAKE_ROOT", h.root);
}

it("ensures the enrolled core at production startup even while capture is pending", async () => {
  const { h, pin } = await fixture(); await enroll(h); installSupervisorCorePin(h.root, pin);
  const service = await supervisor.startProductionSupervisor(h.root);
  try { expect((await h.calls()).map(call => call.argv)).toEqual([["server", "start", "--json"], ["server", "status", "--json"]]); }
  finally { await service.stop(); }
});

it("prints core-pin-changed and fails the service for a mismatching enrollment", async () => {
  const { h, pin } = await fixture(); await enroll(h); installSupervisorCorePin(h.root, { ...pin, coreId: "foreign-core" });
  vi.stubEnv("SPIDER_GLOBAL_ROOT", h.root);
  let err = "";
  expect(await main([], { out() {}, err(text) { err += text; } })).toBe(1);
  expect(err).toContain("core-pin-changed");
});

it("names a missing pinned executable instead of reporting an intent failure", async () => {
  const { h, pin } = await fixture(); await enroll(h); installSupervisorCorePin(h.root, { ...pin, binary: join(h.root, "missing-hc") });
  vi.stubEnv("SPIDER_GLOBAL_ROOT", h.root); let err = "";
  expect(await main([], { out() {}, err(text) { err += text; } })).toBe(1);
  expect(err).toContain("missing-hc");
});

it("starts a stopped core through its pinned binary and socket without using PATH", async () => {
  const { h, pin } = await fixture();
  await h.stopCore();
  const core = await supervisor.ensureSupervisorCore(pin, { ...h.localEnv, PATH: "/missing", HC_SOCKET: h.foreignSocket, HC_SESSION: "foreign", XDG_STATE_HOME: join(h.root, "wrong-state") });
  expect(core.identity).toMatchObject({ coreId: "local-core", socket: h.localSocket, sessionNamespace: h.namespace });
  expect(await h.calls()).toEqual([expect.objectContaining({ argv: ["server", "start", "--json"], env: expect.objectContaining({
    HC_SOCKET: h.localSocket, HC_SESSION: h.namespace, XDG_STATE_HOME: pin.stateHome, XDG_CONFIG_HOME: pin.configHome,
  }) }), expect.objectContaining({ argv: ["server", "status", "--json"] })]);
});

it("uses the first status PID rather than a different start-reply PID", async () => {
  const { h, pin } = await fixture(); await h.configure({ fixtureStartPid: 5678 });
  const core = await supervisor.ensureSupervisorCore(pin, h.localEnv);
  expect(core.pid).toBe(4321);
  await expect(supervisor.assertSupervisorCoreCurrent(core)).resolves.toBeUndefined();
});

it("does not inherit terminal context or other per-terminal hc settings", async () => {
  const { h, pin } = await fixture();
  const core = await supervisor.ensureSupervisorCore(pin, { ...h.localEnv, HC_TERMINAL_ID: "foreign", HC_TERMINAL_SOCKET: h.foreignSocket, HC_TERMINAL_EXTRA: "foreign", HC_SCOPE: "foreign", HC_OTHER: "foreign" });
  expect(Object.keys(core.env).filter(key => key.startsWith("HC_")).sort()).toEqual(["HC_SESSION", "HC_SOCKET"]);
  await expect(supervisor.assertSupervisorCoreCurrent(core)).resolves.toBeUndefined();
});

it.each(["socket", "stateHome", "configHome"] as const)("refuses an unfenced test %s before starting a core", async field => {
  const { h, pin } = await fixture();
  await expect(supervisor.ensureSupervisorCore({ ...pin, [field]: "/outside-fixture/core" }, h.localEnv)).rejects.toThrow(/fixture/i);
  expect(await h.calls()).toEqual([]);
});

it("attaches without replacing an already running core", async () => {
  const { h, pin } = await fixture();
  const first = await supervisor.ensureSupervisorCore(pin, h.localEnv);
  const second = await supervisor.ensureSupervisorCore(pin, h.localEnv);
  expect(second.identity).toEqual(first.identity);
  expect(second.pid).toBe(4321);
  expect((await h.calls()).map(call => call.argv)).toEqual([["server", "start", "--json"], ["server", "status", "--json"], ["server", "start", "--json"], ["server", "status", "--json"]]);
});

it("refuses a core with a different pinned identity", async () => {
  const { h, pin } = await fixture();
  await expect(supervisor.ensureSupervisorCore({ ...pin, coreId: "different-core" }, h.localEnv)).rejects.toMatchObject({ code: "core-pin-changed" });
});

it("detects a lost core without issuing an hc command that could auto-start it", async () => {
  const { h, pin } = await fixture();
  const core = await supervisor.ensureSupervisorCore(pin, h.localEnv);
  await h.stopCore();
  await expect(supervisor.assertSupervisorCoreCurrent(core)).rejects.toMatchObject({ code: "core-lost" });
  expect((await h.calls()).map(call => call.argv)).toEqual([["server", "start", "--json"], ["server", "status", "--json"]]);
});

it("detects replacement even when the restarted core retains its identity", async () => {
  const { h, pin } = await fixture();
  const core = await supervisor.ensureSupervisorCore(pin, h.localEnv);
  await h.configure({ fixtureCorePid: 5678 });
  await expect(supervisor.assertSupervisorCoreCurrent(core)).rejects.toMatchObject({ code: "core-lost" });
});

it("stops hosting after three consecutive failed checks so the service can restart", async () => {
  const { h, pin } = await fixture();
  let tick: (() => void) | undefined, stops = 0;
  const clock: Clock = { now: () => 0, later(_ms, fn) { tick = fn; return () => { tick = undefined; }; } };
  const service = await supervisor.startCoreBoundSupervisor(pin, h.localEnv, async () => ({ async stop() { stops++; } }), clock);
  await h.stopCore();
  for (let failure = 0; failure < 2; failure++) {
    const check = tick!; tick = undefined; check();
    await vi.waitFor(() => expect(tick).toBeTypeOf("function"));
    expect(stops).toBe(0);
  }
  tick!();
  expect(await service.failed).toBe("core-lost");
  expect(stops).toBe(1);
  expect(tick).toBeUndefined();
  await service.stop();
  expect(stops).toBe(1);
});

it("never starts hosting if the core identity does not match enrollment", async () => {
  const { h, pin } = await fixture();
  let starts = 0;
  await expect(supervisor.startCoreBoundSupervisor({ ...pin, coreId: "foreign-core" }, h.localEnv, async () => {
    starts++; return { async stop() {} };
  })).rejects.toMatchObject({ code: "core-pin-changed" });
  expect(starts).toBe(0);
});

it.each(["identity", "pid"])("stops hosting immediately for a confirmed %s replacement", async kind => {
  const { h, pin } = await fixture(); let tick: (() => void) | undefined, stops = 0;
  const clock: Clock = { now: () => 0, later(_ms, fn) { tick = fn; return () => { tick = undefined; }; } };
  const service = await supervisor.startCoreBoundSupervisor(pin, h.localEnv, async () => ({ async stop() { stops++; } }), clock);
  await h.configure(kind === "identity" ? { coreId: "replacement-core" } : { fixtureCorePid: 5678 }); tick!();
  expect(await service.failed).toBe(kind === "identity" ? "core-pin-changed" : "core-lost");
  expect(stops).toBe(1); await service.stop();
});

it("resets consecutive failure detection after a successful check", async () => {
  const { h, pin } = await fixture(); let tick: (() => void) | undefined, stops = 0;
  const clock: Clock = { now: () => 0, later(_ms, fn) { tick = fn; return () => { tick = undefined; }; } };
  const service = await supervisor.startCoreBoundSupervisor(pin, h.localEnv, async () => ({ async stop() { stops++; } }), clock);
  const check = async () => { const next = tick!; tick = undefined; next(); await vi.waitFor(() => expect(tick).toBeTypeOf("function")); };
  try {
    await h.stopCore(); await check(); await check();
    await h.listenCore(); await check();
    await h.stopCore(); await check(); await check();
    expect(stops).toBe(0);
    tick!(); expect(await service.failed).toBe("core-lost"); expect(stops).toBe(1);
  } finally { await service.stop(); }
});

it("detects an identity change while hosting", async () => {
  const { h, pin } = await fixture();
  const core = await supervisor.ensureSupervisorCore(pin, h.localEnv);
  await h.configure({ coreId: "replacement-core" });
  await expect(supervisor.assertSupervisorCoreCurrent(core)).rejects.toMatchObject({ code: "core-pin-changed" });
});
