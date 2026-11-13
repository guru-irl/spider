import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { main } from "../cli";
import { startHubControl, type HubControlRequest } from "../control-socket";

const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
const sockets: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(identity = HUB) {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "r26-")); roots.push(root);
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: identity }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB,
    hubMachineId: HUB, peers: [{ machineId: BOX, alias: "-box-1.invalid", node: "/fixture/node", pi: "/fixture/pi",
      cli: "/fixture/spider", core: "/fixture/core", globalRoot: "/fixture/global" }], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  const calls: HubControlRequest[] = [];
  const socket = await startHubControl(join(root, "roam", "hub.sock"), async request => {
    calls.push(request);
    return { code: 0, reason: "Synchronization complete", value: { outcomes: [] } };
  });
  sockets.push(socket);
  const out: string[] = [], err: string[] = [];
  return { calls, out, err, invoke: (args: string[]) => main(args, { out: text => out.push(text), err: text => err.push(text) }) };
}

it("sync accepts a leading-dash alias after the end-of-options marker", async () => {
  const f = await fixture();
  expect(await f.invoke(["roam", "sync", "--", "-box-1.invalid"])).toBe(0);
  expect(f.calls).toEqual([{ op: "sync", machine: BOX }]);
  expect(f.err).toEqual([]);
}, 5000);

it("sync accepts a leading-dash alias as the explicit machine value", async () => {
  const f = await fixture();
  expect(await f.invoke(["roam", "sync", "--machine", "-box-1.invalid"])).toBe(0);
  expect(f.calls).toEqual([{ op: "sync", machine: BOX }]);
  expect(f.err).toEqual([]);
}, 5000);

it("sync refuses a mismatched local identity before socket dispatch", async () => {
  const f = await fixture(BOX);
  expect(await f.invoke(["roam", "sync", "--", "-box-1.invalid"])).toBe(1);
  expect(f.calls).toEqual([]);
}, 5000);

it("unknown machines and malformed options cannot dispatch a sync", async () => {
  const f = await fixture();
  expect(await f.invoke(["roam", "sync", "--machine", "missing.invalid"])).toBe(2);
  expect(await f.invoke(["roam", "sync", "--machine"])).toBe(2);
  expect(await f.invoke(["roam", "sync", "--bogus"])).toBe(2);
  expect(await f.invoke(["roam", "sync", "--", "-box-1.invalid", "extra"])).toBe(2);
  expect(f.calls).toEqual([]);
}, 5000);
