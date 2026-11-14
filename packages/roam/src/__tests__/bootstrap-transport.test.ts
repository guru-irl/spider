import { afterEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import * as bytesClient from "../../../herdr/src/client/bytes";
import * as coreClient from "../../../herdr/src/client/hc";
import * as liveness from "../../../herdr/src/client/liveness";
import { HerdrError } from "@spider/herdr/client/parse";
import { createTransport } from "../transport";
import type { Peer } from "../contracts";
import { bootstrapPeer, healthyInventory, inventoryEnvelope } from "./bootstrap-fixture";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture(peers: readonly Peer[] = [bootstrapPeer], enrolled: readonly Peer[] = peers) {
  const cores = new Map(peers.map((peer, index) => [peer.alias, `remote-core-${index + 1}`]));
  const calls: { argv: readonly string[]; maxBytes: number; stdin?: Buffer }[] = [], events: string[] = [];
  const state = { reply: Buffer.from(JSON.stringify(inventoryEnvelope())), changeIdentity: false, hang: false, failure: null as HerdrError | null, observationFailure: null as HerdrError | null,
    observationAfterFailure: null as HerdrError | null, identityMissing: false, identityOverride: null as string | null };
  vi.spyOn(liveness, "requireCoreAvailable").mockResolvedValue(undefined);
  vi.spyOn(coreClient, "invokeCli").mockImplementation(async (_binary, argv) => {
    events.push(argv[0]);
    if (state.observationFailure) throw state.observationFailure;
    if (state.observationAfterFailure && events.includes("probe")) throw state.observationAfterFailure;
    return argv[0] === "server" ? { core: { id: "local-core" }, version: "0.1.16" }
      : { machines: peers.map(peer => ({ name: peer.alias, id: cores.get(peer.alias) })) };
  });
  vi.spyOn(bytesClient, "invokeBytes").mockImplementation(async (_binary, argv, _env, options) => {
    calls.push({ argv, maxBytes: options.maxBytes, stdin: options.stdin });
    events.push(argv.includes("--stdin") ? "probe" : "identity");
    const on = argv.includes("--on") ? argv[argv.indexOf("--on") + 1] : argv.find(value => value.startsWith("--on="))?.slice(5);
    const command = argv.slice(argv.indexOf("--") + 1);
    if (command[0] === "cat") {
      const peer = peers.find(item => item.alias === on);
      if (!peer) throw new HerdrError("machine-not-found", "missing");
      if (state.identityMissing) throw new HerdrError("cli-exit", "identity file missing", { exitCode: 1 });
      return Buffer.from(JSON.stringify({ machineId: state.identityOverride ?? peer.machineId }));
    }
    if (state.hang) return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new HerdrError("cli-aborted", "aborted")), { once: true }));
    if (state.failure) throw state.failure;
    if (state.changeIdentity && on) cores.set(on, "replacement-core");
    if (state.reply.length > options.maxBytes) throw new HerdrError("reply-too-large", "reply exceeds cap");
    return Buffer.from(state.reply);
  });
  const fixtureRoot = process.env.SPIDER_GLOBAL_ROOT;
  if (!fixtureRoot) throw new Error("Fixture global root is required");
  const env = { HC_SOCKET: resolve(fixtureRoot, "bootstrap-fixture.sock"), HC_SESSION: "fixture" };
  const transport = createTransport({ binary: "/fixture/hc", env, enrolled });
  return { transport, state, calls, events };
}

it("inventories an unenrolled peer using only the before-and-after core fence", async () => {
  const test = fixture([bootstrapPeer], []);
  const { alias, node, pi, cli, globalRoot } = bootstrapPeer;
  const candidate = { alias, node, pi, cli, globalRoot };
  await expect(test.transport.bootstrapProbe(candidate, "inventory")).resolves.toEqual(healthyInventory());
  expect(test.events).toEqual(["server", "machine", "probe", "server", "machine"]);
  expect(test.calls).toHaveLength(1);
  await expect(test.transport.resolve(bootstrapPeer)).rejects.toMatchObject({ code: "machine-not-enrolled" });
  await expect(test.transport.exec(bootstrapPeer, ["status"], { timeoutMs: 1000, maxBytes: 1024 })).rejects.toMatchObject({ code: "unresolved-peer" });
}, 5000);

it("refuses an unavailable or ambiguous hc alias before probing", async () => {
  const missing = fixture([], []);
  await expect(missing.transport.bootstrapProbe(bootstrapPeer, "inventory")).rejects.toMatchObject({ code: "machine-not-found" });
  expect(missing.calls.filter(call => call.argv.includes("--stdin"))).toHaveLength(0);
  vi.restoreAllMocks();
  const duplicate = fixture([bootstrapPeer, { ...bootstrapPeer }], []);
  await expect(duplicate.transport.bootstrapProbe(bootstrapPeer, "inventory")).rejects.toMatchObject({ code: "machine-ambiguous" });
  expect(duplicate.calls.filter(call => call.argv.includes("--stdin"))).toHaveLength(0);
}, 5000);

it("keeps ordinary roaming calls dependent on the identity file", async () => {
  const test = fixture(); test.state.identityMissing = true;
  await expect(test.transport.resolve(bootstrapPeer)).rejects.toMatchObject({ code: "cli-exit" });
  await expect(test.transport.exec(bootstrapPeer, ["status"], { timeoutMs: 1000, maxBytes: 1024 })).rejects.toMatchObject({ code: "unresolved-peer" });
  const before = test.calls.length;
  await expect(test.transport.bootstrapProbe(bootstrapPeer, "inventory")).resolves.toEqual(healthyInventory());
  expect(test.calls.slice(before)).toHaveLength(1);
  expect(test.calls.at(-1)?.argv).toContain("--stdin");
}, 5000);

it("reports an existing machine ID without treating it as prior enrollment", async () => {
  const test = fixture(), existing = "00000000-0000-4000-8000-000000000002";
  test.state.identityOverride = existing;
  await expect(test.transport.resolve(bootstrapPeer)).rejects.toMatchObject({ code: "machine-mismatch" });
  const value = healthyInventory();
  value.roaming = { rootExists: true, rootSafe: true, identityExists: true, machineId: existing };
  test.state.reply = Buffer.from(JSON.stringify({ version: 1, kind: "inventory", value }));
  const { alias, node, pi, cli, globalRoot } = bootstrapPeer;
  await expect(test.transport.bootstrapProbe({ alias, node, pi, cli, globalRoot }, "inventory")).resolves.toEqual(value);
}, 5000);

it("runs one constant inventory script through hc without interpolating input", async () => {
  const second = { ...bootstrapPeer, machineId: "00000000-0000-4000-8000-000000000002", alias: "box-2.invalid", cli: "/home/fixture/not-in-script-';-input/cli.mjs" };
  const test = fixture([bootstrapPeer, second]);
  const firstHandle = bootstrapPeer;
  expect(await test.transport.bootstrapProbe(firstHandle, "inventory", { timeoutMs: 30_000, maxBytes: 65_536 })).toEqual(healthyInventory());
  const secondHandle = second;
  expect(await test.transport.bootstrapProbe(secondHandle, "inventory", { timeoutMs: 30_000, maxBytes: 65_536 })).toEqual(healthyInventory());
  const calls = test.calls.filter(call => call.argv.includes("--stdin"));
  expect(calls).toHaveLength(2);
  const scripts = calls.map((call, index) => {
    const args = call.argv;
    expect(args.slice(0, 3)).toEqual(["exec", "--on", index === 0 ? bootstrapPeer.alias : second.alias]);
    const timeout = args.indexOf("--timeout");
    expect(Number(args[timeout + 1])).toBeGreaterThanOrEqual(1);
    expect(Number(args[timeout + 1])).toBeLessThanOrEqual(30);
    const end = args.indexOf("--");
    expect(args.slice(end + 1, end + 3)).toEqual([bootstrapPeer.node, "-e"]);
    expect(args.slice(end + 4)).toEqual([]);
    const request = JSON.parse(call.stdin!.toString("utf8"));
    expect(request).toEqual({ pi: bootstrapPeer.pi, cli: index === 0 ? bootstrapPeer.cli : second.cli, globalRoot: bootstrapPeer.globalRoot, checks: [], coreUnit: null });
    expect(call.maxBytes).toBe(65_536);
    return args[end + 3];
  });
  expect(scripts[0]).toBe(scripts[1]);
  for (const value of [bootstrapPeer.alias, second.alias, bootstrapPeer.pi, bootstrapPeer.cli, second.cli, bootstrapPeer.globalRoot]) {
    expect(scripts[0]).not.toContain(value);
  }
}, 5000);

it("passes configured checks only as data and binds their boolean-only results", async () => {
  const test = fixture();
  const configured = [{ name: "tool", executable: "/home/fixture/.local/bin/tool'; echo --", authFile: "/home/fixture/.config/tool/auth.json" }];
  const value = healthyInventory();
  value.core.unit = "session-host.service";
  value.cli.configured = [{ executable: { present: true, readable: true, modeSafe: true, executable: true }, auth: { present: true, readable: true, modeSafe: true } }];
  test.state.reply = Buffer.from(JSON.stringify({ version: 1, kind: "inventory", value }));
  const handle = bootstrapPeer;
  expect(await test.transport.bootstrapProbe(handle, "inventory", { timeoutMs: 30_000, maxBytes: 1_000_000, configuredClis: configured, coreUnit: "session-host.service" })).toEqual(value);
  const call = test.calls.at(-1)!;
  expect(call.maxBytes).toBe(65_536);
  expect(JSON.parse(call.stdin!.toString())).toMatchObject({ coreUnit: "session-host.service", checks: [{ executable: configured[0].executable, authFile: configured[0].authFile }] });
  const script = call.argv[call.argv.indexOf("--") + 3];
  expect(script).not.toContain(configured[0].executable);
  expect(script).not.toContain(configured[0].authFile!);
  expect(script).not.toContain("session-host.service");
  expect(JSON.stringify(value)).not.toContain("/home/fixture/.config");
}, 5000);

it.each([
  ["relative executable", [{ name: "tool", executable: "bin/tool", authFile: null }]],
  ["unsafe name", [{ name: "tool;echo", executable: "/home/fixture/bin/tool", authFile: null }]],
  ["too many checks", Array.from({ length: 33 }, (_, i) => ({ name: `tool${i}`, executable: "/home/fixture/bin/tool", authFile: null }))],
  ["sparse checks", Array(1)],
])("rejects %s before invoking the fixed probe", async (_name, configuredClis) => {
  const test = fixture();
  const handle = bootstrapPeer;
  await expect(test.transport.bootstrapProbe(handle, "inventory", { timeoutMs: 30_000, maxBytes: 1024, configuredClis })).rejects.toMatchObject({ code: "invalid-bootstrap-request" });
  expect(test.calls.filter(call => call.argv.includes("--stdin"))).toHaveLength(0);
}, 5000);

it("rejects an oversized aggregate request before contacting hc", async () => {
  const test = fixture(), file = "/" + "\\".repeat(4095);
  const configuredClis = Array.from({ length: 32 }, (_, i) => ({ name: `tool${i}`, executable: file, authFile: file }));
  await expect(test.transport.bootstrapProbe(bootstrapPeer, "inventory", { timeoutMs: 30_000, maxBytes: 65_536, configuredClis })).rejects.toMatchObject({ code: "invalid-bootstrap-request" });
  expect(test.events).toEqual([]);
}, 5000);

it.each([
  ["relative node", { ...bootstrapPeer, node: "node" }],
  ["relative roaming root", { ...bootstrapPeer, globalRoot: "spider" }],
  ["control character in alias", { ...bootstrapPeer, alias: "box-1.invalid\n--other" }],
])("rejects a bootstrap target with %s before contacting hc", async (_name, target) => {
  const test = fixture();
  await expect(test.transport.bootstrapProbe(target, "inventory")).rejects.toMatchObject({ code: "invalid-bootstrap-request" });
  expect(test.events).toEqual([]);
}, 5000);

it("rejects a reply for a different configured core unit", async () => {
  const test = fixture();
  const handle = bootstrapPeer;
  await expect(test.transport.bootstrapProbe(handle, "inventory", { timeoutMs: 30_000, maxBytes: 65_536, coreUnit: "session-host.service" })).rejects.toMatchObject({ code: "invalid-bootstrap-reply" });
}, 5000);

it("names a fixed-probe failure without copying arbitrary details", async () => {
  const test = fixture();
  test.state.reply = Buffer.from(JSON.stringify({ version: 1, kind: "inventory", error: "bootstrap-probe-failed" }));
  const handle = bootstrapPeer;
  await expect(test.transport.bootstrapProbe(handle, "inventory")).rejects.toMatchObject({ code: "bootstrap-probe-failed" });
}, 5000);

it("rejects malformed or extra probe fields without exposing their values", async () => {
  const test = fixture();
  test.state.reply = Buffer.from(JSON.stringify({ ...inventoryEnvelope(), privateValue: "fixture-secret" }));
  const handle = bootstrapPeer;
  const error = await test.transport.bootstrapProbe(handle, "inventory").catch(value => value);
  expect(error).toMatchObject({ code: "invalid-bootstrap-reply" });
  expect(String(error)).not.toContain("fixture-secret");
}, 5000);

it.each([
  ["missing resource", (value: Record<string, unknown>) => { delete value.inotifyWatches; }],
  ["negative resource", (value: Record<string, unknown>) => { value.hardNofile = -1; }],
  ["foreign pi path", (value: Record<string, unknown>) => { value.pi = "/outside/private/pi"; }],
  ["unrecognised unit", (value: Record<string, unknown>) => { value.core = { ...healthyInventory().core, unit: "unit.service\nBefore=other.service" }; }],
  ["pi version without an executable", (value: Record<string, unknown>) => { value.pi = null; }],
  ["uninstalled spider marked ready", (value: Record<string, unknown>) => { value.spider = { installed: false, version: null, nativeModuleReady: true }; }],
  ["unexpected configured check", (value: Record<string, unknown>) => { value.cli = { ...healthyInventory().cli, configured: [{ executable: null, auth: null }] }; }],
  ["invalid machine identity", (value: Record<string, unknown>) => { value.roaming = { rootExists: true, rootSafe: true, identityExists: true, machineId: "fixture-secret" }; }],
  ["identity outside an absent root", (value: Record<string, unknown>) => { value.roaming = { rootExists: false, rootSafe: true, identityExists: true, machineId: bootstrapPeer.machineId }; }],
  ["identity from an unsafe root", (value: Record<string, unknown>) => { value.roaming = { rootExists: true, rootSafe: false, identityExists: true, machineId: bootstrapPeer.machineId }; }],
  ["unknown root declared safe", (value: Record<string, unknown>) => { value.roaming = { rootExists: null, rootSafe: true, identityExists: null, machineId: null }; }],
  ["unsafe root falsely declared absent", (value: Record<string, unknown>) => { value.roaming = { rootExists: false, rootSafe: false, identityExists: false, machineId: null }; }],
  ["extra identity content", (value: Record<string, unknown>) => { value.roaming = { ...healthyInventory().roaming, content: "fixture-secret" }; }],
])("rejects %s in an otherwise valid bootstrap reply", async (_name, mutate) => {
  const test = fixture();
  const value = healthyInventory() as unknown as Record<string, unknown>;
  mutate(value);
  test.state.reply = Buffer.from(JSON.stringify({ version: 1, kind: "inventory", value }));
  const handle = bootstrapPeer;
  await expect(test.transport.bootstrapProbe(handle, "inventory")).rejects.toMatchObject({ code: "invalid-bootstrap-reply" });
}, 5000);

it("refuses an unrecognised probe kind and keeps ordinary calls handle-fenced", async () => {
  const test = fixture();
  await expect(test.transport.exec(bootstrapPeer, ["status"], { timeoutMs: 1000, maxBytes: 1024 })).rejects.toMatchObject({ code: "unresolved-peer" });
  await expect(test.transport.bootstrapProbe(bootstrapPeer, "other" as "inventory")).rejects.toMatchObject({ code: "invalid-bootstrap-kind" });
  expect(test.calls.filter(call => call.argv.includes("--stdin"))).toHaveLength(0);
}, 5000);

it("discards a probe reply when the peer core identity changes during execution", async () => {
  const test = fixture();
  const handle = bootstrapPeer;
  test.state.changeIdentity = true;
  await expect(test.transport.bootstrapProbe(handle, "inventory")).rejects.toMatchObject({ code: "core-changed" });
}, 5000);

it("discards a reply when the core cannot be observed after the probe", async () => {
  const test = fixture();
  test.state.observationAfterFailure = new HerdrError("core-unavailable", "fixture-secret", { stderr: "fixture-secret" });
  const error = await test.transport.bootstrapProbe(bootstrapPeer, "inventory").catch(value => value);
  expect(error).toMatchObject({ code: "core-unavailable", retryable: true });
  expect(String(error)).not.toContain("fixture-secret");
  expect(JSON.stringify(error)).not.toContain("fixture-secret");
  expect(test.calls.filter(call => call.argv.includes("--stdin"))).toHaveLength(1);
}, 5000);

it("rejects output above the configured reply cap", async () => {
  const test = fixture();
  test.state.reply = Buffer.alloc(2048, 0x61);
  const handle = bootstrapPeer;
  await expect(test.transport.bootstrapProbe(handle, "inventory", { timeoutMs: 30_000, maxBytes: 1024 })).rejects.toMatchObject({ code: "reply-too-large" });
  expect(test.calls.at(-1)?.maxBytes).toBe(1024);
}, 5000);

it("names a remote execution failure without returning its stderr", async () => {
  const test = fixture();
  test.state.failure = new HerdrError("cli-exit", "private", { exitCode: 17, stderr: "fixture-secret" });
  const handle = bootstrapPeer;
  const error = await test.transport.bootstrapProbe(handle, "inventory").catch(value => value);
  expect(error).toMatchObject({ code: "cli-exit", details: { exitCode: 17 } });
  expect(JSON.stringify(error)).not.toContain("fixture-secret");
}, 5000);

it("sanitizes failures from the surrounding core-identity checks", async () => {
  const test = fixture();
  const handle = bootstrapPeer;
  test.state.observationFailure = new HerdrError("cli-exit", "fixture-secret", { exitCode: 23, stderr: "fixture-secret" });
  const error = await test.transport.bootstrapProbe(handle, "inventory").catch(value => value);
  expect(error).toMatchObject({ code: "cli-exit" });
  expect(String(error)).not.toContain("fixture-secret");
  expect(JSON.stringify(error)).not.toContain("fixture-secret");
}, 5000);

it("reports cli-timeout when the fixed probe exceeds its deadline", async () => {
  const test = fixture();
  const handle = bootstrapPeer;
  test.state.hang = true;
  vi.useFakeTimers();
  const result = test.transport.bootstrapProbe(handle, "inventory", { timeoutMs: 2000, maxBytes: 4096 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await result).toMatchObject({ code: "cli-timeout", retryable: true });
  expect(test.calls.at(-1)?.argv).toContain("--timeout");
  expect(vi.getTimerCount()).toBe(0);
}, 5000);
