import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { startMachineMoveSocket, requestMachineMove, machineMoveProxy } from "../machine-move-socket";
import type { MachineMovePort } from "../intercom-runtime";
const roots: string[] = [], servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("machine socket exposes named operations and refuses malformed and disabled requests without effects", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "mm-")); roots.push(root);
  const effects: unknown[] = [], address = { sessionId: "session-a", scopeId: "scope-a" };
  const unavailable = async (...args: unknown[]): Promise<never> => { effects.push(args); throw new Error("move-rollback-proof-missing"); };
  const port: MachineMovePort = { bridge: async input => { effects.push(input); return { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }; },
    endpoint: unavailable, settlement: unavailable, releaseRollbackFence: unavailable,
    intake: { close: unavailable, drain: unavailable, inspect: unavailable, checkGeneration: unavailable, abort: unavailable, ready: unavailable } };
  let enabled = true;
  servers.push(await startMachineMoveSocket(root, () => enabled, port));
  expect(await machineMoveProxy(root).bridge(address)).toEqual({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] });
  expect(effects).toEqual([address]);
  effects.length = 0;
  await expect(requestMachineMove(root, { action: "bridge", address, secret: "SECRET-SENTINEL" })).rejects.toThrow("invalid-machine-move-control");
  expect(effects).toEqual([]);
  await expect(machineMoveProxy(root).endpoint(address)).rejects.toThrow("move-rollback-proof-missing");
  expect(effects).toHaveLength(1);
  effects.length = 0; enabled = false;
  await expect(machineMoveProxy(root).bridge(address)).rejects.toThrow("roaming-disabled");
  expect(effects).toEqual([]);
}, 5000);
