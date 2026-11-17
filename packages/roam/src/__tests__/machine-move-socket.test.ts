import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { startMachineMoveSocket, requestMachineMove, machineMoveProxy } from "../machine-move-socket";
import type { MachineMovePort } from "../intercom-runtime";
import { IntercomFenceError } from "../intercom-move";
const roots: string[] = [], servers: Array<{ close(): Promise<void> }> = [];
async function failingMachine(error: Error): Promise<ReturnType<typeof machineMoveProxy>> {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "mm-")); roots.push(root);
  const fail = async (): Promise<never> => { throw error; };
  servers.push(await startMachineMoveSocket(root, () => true, { broker: fail, bridge: fail, endpoint: fail, settlement: fail, releaseRollbackFence: fail,
    intake: { close: fail, drain: fail, inspect: fail, checkGeneration: fail, abort: fail, ready: fail } }));
  return machineMoveProxy(root);
}
it("unknown machine-control failures keep their sanitized cause without changing the public refusal", async () => {
  const machine = await failingMachine(Object.assign(new Error("fixture failed, token=private-value"), { name: "FixtureFailure", code: "EIO", secret: "private-value", path: "/private/fixture" }));
  const failure = await machine.broker({ sessionId: "session-a", scopeId: null }).catch(error => error);
  expect(failure).toMatchObject({ message: "intercom-move-unavailable", code: "intercom-move-unavailable",
    diagnostic: { name: "FixtureFailure", code: "EIO", message: "fixture failed, token=[redacted]" } });
  expect(JSON.stringify(failure)).not.toMatch(/private-value|\/private\/fixture|stack|secret/);
}, 5000);
it.each([null, "intercom-owner-unknown"])("fence errors keep their blockers and optional code %s across the socket", async code => {
  const blockers = [{ kind: "intercom-owner-unknown", id: "session-a", detail: "Cannot verify the intercom move fence." }];
  const error = new IntercomFenceError(blockers);
  if (code) Object.assign(error, { code });
  const machine = await failingMachine(error);
  const failure = await machine.broker({ sessionId: "session-a", scopeId: null }).catch(error => error);
  expect(failure).toBeInstanceOf(IntercomFenceError);
  expect(failure).toMatchObject({ blockers, ...(code ? { code } : {}), diagnostic: { name: "IntercomFenceError", code, blockers } });
}, 5000);
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("machine socket exposes named operations and refuses malformed and disabled requests without effects", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "mm-")); roots.push(root);
  const effects: unknown[] = [], address = { sessionId: "session-a", scopeId: "scope-a" };
  const unavailable = async (...args: unknown[]): Promise<never> => { effects.push(args); throw new Error("move-rollback-proof-missing"); };
  const port: MachineMovePort = { bridge: async input => { effects.push(input); return { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }; },
    broker: unavailable, endpoint: unavailable, settlement: unavailable, releaseRollbackFence: unavailable,
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
  await expect(machineMoveProxy(root).broker(address)).rejects.toThrow("roaming-disabled");
  expect(effects).toEqual([]);
}, 5000);


it.each([
  ["connect ENOENT /home/alice/.pi/agent/intercom/broker.sock", "/home/alice"],
  ["EACCES lstat '/fixture/alice/agent/intercom/broker.pid'", "/fixture/alice"],
  [String.raw`connect EACCES C:\Users\alice\agent\broker.sock`, "alice"],
  ["authentication github_pat_" + "a".repeat(32), "github_pat_"],
  ["secret=private-value", "private-value"],
  ["client_secret='private value'", "private value"],
  ["aws AKIA" + "A".repeat(16), "AKIA"],
  ["chat xoxb-123456789-abcdefgh", "xoxb-"],
])("machine failures redact sensitive detail from %s", async (message, forbidden) => {
  const machine = await failingMachine(Object.assign(new Error(message), { code: "ENOENT" }));
  const failure = await machine.bridge({ sessionId: "session-a", scopeId: null }).catch(error => error);
  expect(failure.diagnostic.code).toBe("ENOENT");
  expect(failure.diagnostic.message).not.toContain(forbidden);
  expect(failure.diagnostic.message).toMatch(/\[path\]|\[redacted/);
}, 5000);
