import { afterEach, expect, it, vi } from "vitest";
import * as runtime from "../runtime";
import * as hub from "../hub";
import * as hc from "@spider/herdr/client/hc";
import * as diagnostics from "../local-diagnostics";
import * as hostConfig from "../host-config";
import { startProductionHub } from "../production-hub";
import { network, BOX } from "./sync-fixture";
import type { StandaloneHubPorts } from "../hub";

const fixtures: ReturnType<typeof network>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.close(); });

async function observationFixture() {
  const f = network(); fixtures.push(f);
  let state: unknown = "connected", identity = "core-1";
  vi.spyOn(runtime, "openLocalCore").mockReturnValue({ config: f.config, db: f.global.db, close() {} } as never);
  vi.spyOn(hostConfig, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/hc" } } as never);
  vi.spyOn(diagnostics, "createLocalDiagnosticPorts").mockReturnValue({ async probeProcess() { return { kind: "live", startIdentity: "process-1" }; } } as never);
  vi.spyOn(hc, "createHcClient").mockReturnValue({ async identity() { return { coreId: identity }; }, async dispose() {} } as never);
  const cli = vi.spyOn(hc, "invokeCli").mockImplementation(async () => ({ machines: [{ name: f.config.peers[0].alias, state }] }) as never);
  let ports: StandaloneHubPorts | undefined;
  vi.spyOn(hub, "runStandaloneHub").mockImplementation(async input => { ports = input; return { async stop() {}, agentPorts: {} as never }; });
  await startProductionHub(f.global.root);
  if (!ports) throw new Error("Hub was not composed");
  const observe = ports.observe;
  return { f, cli, observe, setState(value: unknown) { state = value; }, replaceIdentity() { identity = "core-2"; } };
}

it("a connected native state clears an outage even when sync refuses content", async () => {
  const h = await observationFixture();
  const { loadPeerState, savePeerState } = await import("../peer-state");
  const saved = loadPeerState(h.f.global.db, BOX, h.f.config.limits.targetBatchBytes);
  saved.observation = { machineId: BOX, observedAt: 1, connected: true, lastSyncAt: 1, cursors: [], failure: null };
  saved.pulled = true;
  savePeerState(h.f.global.db, BOX, saved);
  expect(await h.observe(h.f.config.peers[0], [{ code: 1, reason: "Invalid peer value", operationId: "op-1", home: null, epoch: null, repairCommand: null, value: null }])).toMatchObject({ reachability: "reachable", syncVerified: false });
});

it.each([false, true])("a connected no-change sync verifies moves only after a complete store pull (pulled: %s)", async pulled => {
  const h = await observationFixture();
  const { loadPeerState, savePeerState } = await import("../peer-state");
  const saved = loadPeerState(h.f.global.db, BOX, h.f.config.limits.targetBatchBytes);
  saved.pulled = pulled;
  saved.observation = { machineId: BOX, observedAt: 2, connected: true, lastSyncAt: pulled ? 2 : 1, cursors: [], failure: null };
  savePeerState(h.f.global.db, BOX, saved);
  expect(await h.observe(h.f.config.peers[0], [])).toMatchObject({ reachability: "reachable", syncVerified: pulled });
});

it("a core identity change during machine inventory remains unknown", async () => {
  const h = await observationFixture();
  h.setState("unreachable");
  h.cli.mockImplementationOnce(async () => { h.replaceIdentity(); return { machines: [{ name: h.f.config.peers[0].alias, state: "unreachable" }] }; });
  expect(await h.observe(h.f.config.peers[0], [])).toEqual({ reachability: "unknown", readiness: null, suspensions: null });
});
