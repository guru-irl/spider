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
  try { expect((await h.calls()).map(call => call.argv)).toEqual([["server", "start", "--json"]]); }
  finally { await service.stop(); }
});

it("prints core-changed and fails the service for a mismatching enrollment", async () => {
  const { h, pin } = await fixture(); await enroll(h); installSupervisorCorePin(h.root, { ...pin, coreId: "foreign-core" });
  vi.stubEnv("SPIDER_GLOBAL_ROOT", h.root);
  let err = "";
  expect(await main([], { out() {}, err(text) { err += text; } })).toBe(1);
  expect(err).toContain("core-changed");
});

it("starts a stopped core through its pinned binary and socket without using PATH", async () => {
  const { h, pin } = await fixture();
  await h.stopCore();
  const core = await supervisor.ensureSupervisorCore(pin, { ...h.localEnv, PATH: "/missing", HC_SOCKET: h.foreignSocket, HC_SESSION: "foreign", XDG_STATE_HOME: join(h.root, "wrong-state") });
  expect(core.identity).toMatchObject({ coreId: "local-core", socket: h.localSocket, sessionNamespace: h.namespace });
  expect(await h.calls()).toEqual([expect.objectContaining({ argv: ["server", "start", "--json"], env: expect.objectContaining({
    HC_SOCKET: h.localSocket, HC_SESSION: h.namespace, XDG_STATE_HOME: pin.stateHome, XDG_CONFIG_HOME: pin.configHome,
  }) })]);
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
  expect((await h.calls()).map(call => call.argv)).toEqual([["server", "start", "--json"], ["server", "start", "--json"]]);
});

it("refuses a core with a different pinned identity", async () => {
  const { h, pin } = await fixture();
  await expect(supervisor.ensureSupervisorCore({ ...pin, coreId: "different-core" }, h.localEnv)).rejects.toMatchObject({ code: "core-changed" });
});

it("detects a lost core without issuing an hc command that could auto-start it", async () => {
  const { h, pin } = await fixture();
  const core = await supervisor.ensureSupervisorCore(pin, h.localEnv);
  await h.stopCore();
  await expect(supervisor.assertSupervisorCoreCurrent(core)).rejects.toMatchObject({ code: "core-lost" });
  expect((await h.calls()).map(call => call.argv)).toEqual([["server", "start", "--json"]]);
});

it("detects replacement even when the restarted core retains its identity", async () => {
  const { h, pin } = await fixture();
  const core = await supervisor.ensureSupervisorCore(pin, h.localEnv);
  await h.configure({ fixtureCorePid: 5678 });
  await expect(supervisor.assertSupervisorCoreCurrent(core)).rejects.toMatchObject({ code: "core-lost" });
});

it("stops hosting and reports core loss so the service can restart", async () => {
  const { h, pin } = await fixture();
  let tick: (() => void) | undefined, stops = 0;
  const clock: Clock = { now: () => 0, later(_ms, fn) { tick = fn; return () => { tick = undefined; }; } };
  const service = await supervisor.startCoreBoundSupervisor(pin, h.localEnv, async () => ({ async stop() { stops++; } }), clock);
  await h.stopCore();
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
  })).rejects.toMatchObject({ code: "core-changed" });
  expect(starts).toBe(0);
});

it("detects an identity change while hosting", async () => {
  const { h, pin } = await fixture();
  const core = await supervisor.ensureSupervisorCore(pin, h.localEnv);
  await h.configure({ coreId: "replacement-core" });
  await expect(supervisor.assertSupervisorCoreCurrent(core)).rejects.toMatchObject({ code: "core-changed" });
});
