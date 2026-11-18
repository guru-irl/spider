import { afterEach, expect, it } from "vitest";
import { join } from "node:path";
import { createClientFixture, type ClientFixture } from "../../../herdr/src/__tests__/testutil";
import * as supervisor from "../production-supervisor";

const fixtures: ClientFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture() {
  const h = await createClientFixture(); fixtures.push(h);
  await h.configure({ roamFixture: {}, fixtureCorePid: 4321 });
  const pin = { binary: h.hcBinary, coreId: "local-core", socket: h.localSocket, sessionNamespace: h.namespace,
    stateHome: h.localEnv.XDG_STATE_HOME!, configHome: h.localEnv.XDG_CONFIG_HOME! };
  return { h, pin };
}

it("starts a stopped core through its pinned binary and socket without using PATH", async () => {
  const { h, pin } = await fixture();
  await h.stopCore();
  const core = await supervisor.ensureSupervisorCore(pin, { ...h.localEnv, PATH: "/missing", HC_SOCKET: h.foreignSocket, HC_SESSION: "foreign", XDG_STATE_HOME: join(h.root, "wrong-state") });
  expect(core.identity).toMatchObject({ coreId: "local-core", socket: h.localSocket, sessionNamespace: h.namespace });
  expect(await h.calls()).toEqual([expect.objectContaining({ argv: ["server", "start", "--json"], env: expect.objectContaining({
    HC_SOCKET: h.localSocket, HC_SESSION: h.namespace, XDG_STATE_HOME: pin.stateHome, XDG_CONFIG_HOME: pin.configHome,
  }) })]);
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

it("detects an identity change while hosting", async () => {
  const { h, pin } = await fixture();
  const core = await supervisor.ensureSupervisorCore(pin, h.localEnv);
  await h.configure({ coreId: "replacement-core" });
  await expect(supervisor.assertSupervisorCoreCurrent(core)).rejects.toMatchObject({ code: "core-changed" });
});
