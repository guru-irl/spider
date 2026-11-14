import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
const mocked = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("../intercom-route", async importOriginal => ({ ...(await importOriginal<typeof import("../intercom-route")>()), acquireHelperRoute: mocked.acquire }));
import { createMachineIntercom } from "../intercom-runtime";
import { parseConfig } from "../config";

const A = "00000000-0000-4000-8000-000000000001", roots: string[] = [], replicas: Array<{ close(): void }> = [];
afterEach(() => { mocked.acquire.mockReset(); for (const replica of replicas.splice(0)) replica.close(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
it("stop joins a retry that acquires its lease after cancellation", async () => {
  const global = createReplica("global", A); replicas.push(global);
  const agentDir = mkdtempSync(join(resolve(".spider/scratch"), "retry-agent-")); roots.push(agentDir);
  const firstLease = { close: vi.fn(async () => {}), publish: vi.fn(async () => {}) };
  const retryLease = { close: vi.fn(async () => {}), publish: vi.fn(async () => {}) };
  let release!: (value: typeof retryLease) => void; const acquiring = new Promise<typeof retryLease>(done => { release = done; });
  mocked.acquire.mockResolvedValueOnce(firstLease).mockReturnValueOnce(acquiring);
  const timers: Array<{ fn(): void; cancelled: boolean }> = [];
  const clock = { now: () => 1000, later(_ms: number, fn: () => void) { const timer = { fn, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; } };
  class Broker extends EventEmitter { async connect() {} async enableHelpers() {} publishPresence() {} async deliver() { return {} as never; } deliverReceipt() {} deliverControl() {} async close() {} async inspectBlockers() { return { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }; } }
  const config = parseConfig({ role: "hub", machineId: A, hubMachineId: A, coreUnit: "fixture", intercom: { enabled: true, machineAlias: "local.invalid" } });
  const service = createMachineIntercom({ root: global.root, globalDb: global.db, config, agentDir, clock, broker: new Broker() as never,
    env: { ...process.env, PI_SUBAGENT_CHILD: "0" }, transport: {} as never, ensureBroker: async () => { throw new Error("unsupported-broker"); } });
  try {
    await service.start(); expect(service.readiness().reason).toBe("unsupported-broker"); expect(firstLease.close).toHaveBeenCalled();
    expect(timers).toHaveLength(1); timers[0].fn(); expect(mocked.acquire).toHaveBeenCalledTimes(2);
    let stopped = false; const stopping = service.stop().then(() => { stopped = true; });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(stopped).toBe(false); release(retryLease); await stopping;
    expect(retryLease.close).toHaveBeenCalledTimes(1);
  } finally { release(retryLease); await service.stop(); }
}, 5000);
