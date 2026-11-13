import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { main } from "../cli";
import { startHubControl, type HubControlReply, type HubControlRequest } from "../control-socket";
import * as productionHub from "../production-hub";
import { createClientFixture } from "../../../herdr/src/__tests__/testutil";

const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
const sockets: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close();
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(identity = HUB, reply?: HubControlReply) {
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
    return reply ?? { code: 0, reason: "Synchronization complete", value: { outcomes: [] } };
  });
  sockets.push(socket);
  const out: string[] = [], err: string[] = [];
  return { calls, out, err, invoke: (args: string[]) => main(args, { out: text => out.push(text), err: text => err.push(text) }) };
}

it("sync prints a named peer process failure from the hub outcome", async () => {
  const f = await fixture(HUB, { code: 1, reason: "Synchronization needs attention", value: {
    outcomes: [{ code: 1, reason: "Peer command failed (spawn_failed)" }],
  } });
  expect(await f.invoke(["roam", "sync", "--", "-box-1.invalid"])).toBe(1);
  expect(f.err.join("")).toContain("spawn_failed");
}, 5000);

it("remote doctor reports a failed peer process rather than a generic unavailable message", async () => {
  const f = await fixture(), hc = await createClientFixture();
  try {
    for (const key of ["HC_SESSION", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SOCKET", "HERDR_FAKE_ROOT"] as const)
      vi.stubEnv(key, hc.localEnv[key]!);
    vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: hc.hcBinary } } as never);
    const alias = "-box-1.invalid";
    await hc.configure({ machines: [{ id: "remote-core", name: alias, host: "box-1.invalid", target: "box-1.invalid", via: false }],
      roamFixture: { execReplyBase64: Buffer.from('{"version":1}').toString("base64"), execExitCode: 1 } });
    await hc.writeRoamFile(alias, "/fixture/global/roam/machine.json", Buffer.from(JSON.stringify({ machineId: BOX })));
    expect(await f.invoke(["roam", "doctor", "--", alias])).toBe(1);
    expect(f.err.join("")).toContain("Peer command failed (exit 1)");
  } finally { await hc.close(); }
}, 5000);

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
