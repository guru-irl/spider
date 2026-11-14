import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { posix } from "node:path";
import { createArgvClient } from "@spider/herdr/client/argv-client";
import * as liveness from "../../../herdr/src/client/liveness";
import * as coreClient from "../../../herdr/src/client/hc";
import * as argvClient from "../../../herdr/src/client/argv-client";
import { createClientFixture } from "../../../herdr/src/__tests__/testutil";
import { createTransport } from "../transport";
import { DEFAULT_LIMITS } from "../contracts";

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(spawn).mockReset(); });

const machine = { id: "remote-core", name: "box-1.invalid", host: "box-1.invalid", target: "box-1.invalid", session: "remote", via: false, state: "connected" };
const peer = { machineId: "00000000-0000-4000-8000-000000000002", alias: machine.name,
  node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: "/fixture/global" };

it("exact argv carries stdin and configured global root without message text", async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execReplyBase64: Buffer.from("reply").toString("base64") } });
    await fixture.writeRoamFile(peer.alias, posix.join(peer.globalRoot, "roam", "machine.json"), Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const handle = await transport.resolve(peer);
    const body = Buffer.from("synthetic-message-content");
    const options = { timeoutMs: 20_000, maxBytes: 512 * 1024, stdin: body, remoteTimeoutMs: 10_000, postReserveMs: 5_000 };
    expect(await transport.exec(handle, ["roam", "intercom", "exchange"], options)).toEqual(Buffer.from("reply"));
    const call = (await fixture.calls()).find(entry => entry.argv.includes("exchange"));
    expect(call?.argv).toEqual(["exec", "--on", peer.alias, "--timeout", "10", "--stdin", "--", peer.node, peer.cli,
      "--global-root", peer.globalRoot, "roam", "intercom", "exchange"]);
    expect(JSON.stringify(call?.argv)).not.toContain(body.toString());
  } finally { await fixture.close(); }
}, 5000);

it("timeout rounds down after reserves and the liveness probe", async () => {
  const fixture = await createClientFixture();
  try {
    vi.mocked(spawn).mockClear();
    vi.useFakeTimers();
    vi.spyOn(liveness, "requireCoreAvailable").mockImplementation(() => new Promise(resolve => setTimeout(resolve, 1500)));
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: 12345, kill: vi.fn((signal: string) => { queueMicrotask(() => child.emit("close", null, signal)); return true; }) });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const client = createArgvClient({ binary: fixture.hcBinary, env: fixture.localEnv });
    const options = { timeoutMs: 10_700, maxBytes: 16, remoteTimeoutMs: 10_000, postReserveMs: 2_000, stdin: Buffer.from("request") };
    const pending = client.exec(peer.alias, ["/fixture/node"], options);
    await vi.advanceTimersByTimeAsync(1500);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(["exec", "--on", peer.alias, "--timeout", "7", "--stdin", "--", "/fixture/node"]);
    child.stdout.write("ok"); child.emit("close", 0, null);
    expect(await pending).toEqual(Buffer.from("ok"));
  } finally { vi.useRealTimers(); await fixture.close(); }
}, 5000);

it("refuses remote spawn when the post-bracket reserve leaves less than a second", async () => {
  const fixture = await createClientFixture();
  try {
    vi.mocked(spawn).mockClear();
    vi.useFakeTimers();
    vi.spyOn(liveness, "requireCoreAvailable").mockImplementation(() => new Promise(resolve => setTimeout(resolve, 2000)));
    const client = createArgvClient({ binary: fixture.hcBinary, env: fixture.localEnv });
    const options = { timeoutMs: 4500, maxBytes: 16, remoteTimeoutMs: 5000, postReserveMs: 2000 };
    const pending = client.exec(peer.alias, ["/fixture/node"], options).catch(error => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ code: "cli-timeout" });
    expect(spawn).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); await fixture.close(); }
}, 5000);


it("adapts the poll hold to the actual timeout at spawn", async () => {
  const fixture = await createClientFixture();
  try {
    vi.mocked(spawn).mockClear();
    vi.useFakeTimers();
    vi.spyOn(liveness, "requireCoreAvailable").mockImplementation(() => new Promise(resolve => setTimeout(resolve, 1500)));
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: 12345, kill: vi.fn((signal: string) => { queueMicrotask(() => child.emit("close", null, signal)); return true; }) });
    let input = ""; child.stdin.on("data", bytes => { input += bytes.toString(); });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const client = createArgvClient({ binary: fixture.hcBinary, env: fixture.localEnv });
    const options = { timeoutMs: 10_700, maxBytes: 16, remoteTimeoutMs: 10_000, postReserveMs: 2_000,
      stdinForTimeout: (ms: number) => Buffer.from(`hold:${ms - 5000}`) };
    const pending = client.exec(peer.alias, ["/fixture/node"], options);
    await vi.advanceTimersByTimeAsync(1500);
    child.stdout.write("ok"); child.emit("close", 0, null);
    expect(await pending).toEqual(Buffer.from("ok"));
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(["exec", "--on", peer.alias, "--timeout", "7", "--stdin", "--", "/fixture/node"]);
    expect(input).toBe("hold:2000");
  } finally { vi.useRealTimers(); await fixture.close(); }
}, 5000);

it("abort stops both the exchange and its identity observation", async () => {
  const fixture = await createClientFixture();
  try {
    vi.spyOn(coreClient, "invokeCli").mockImplementation(async (_binary, argv) => argv[0] === "server"
      ? { core: { id: "local-core" }, version: "0.1.16" } : { machines: [machine] });
    let aborted = false;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const exec: import("../../../herdr/src/contracts").HcArgvClient["exec"] = async (_on, argv, options) => {
      if (argv[0] === "cat") return Buffer.from(JSON.stringify({ machineId: peer.machineId }));
      markStarted();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(Buffer.from("late")), 30);
        options.signal?.addEventListener("abort", () => { aborted = true; clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      });
    };
    vi.spyOn(argvClient, "createArgvClient").mockReturnValue({ exec, run: vi.fn() });
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const handle = await transport.resolve(peer), aborter = new AbortController();
    const pending = transport.exec(handle, ["roam", "intercom", "exchange"], { timeoutMs: 1000, maxBytes: 16, signal: aborter.signal } as
      import("../contracts").CallOptions & { signal: AbortSignal }).catch(error => error);
    await started;
    aborter.abort();
    expect(await pending).toMatchObject({ code: "cli-aborted" });
    expect(aborted).toBe(true);
  } finally { await fixture.close(); }
}, 5000);

it("connected-line evidence comes from the existing machine-list bracket", async () => {
  const fixture = await createClientFixture();
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execReplyBase64: Buffer.from("ok").toString("base64") } });
    await fixture.writeRoamFile(peer.alias, posix.join(peer.globalRoot, "roam", "machine.json"), Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const handle = await transport.resolve(peer);
    const before = (await fixture.calls()).length;
    const evidence: boolean[] = [];
    const options = { timeoutMs: 5000, maxBytes: 16, onConnected: (connected: boolean) => evidence.push(connected) };
    expect(await transport.exec(handle, ["roam", "intercom", "exchange"], options)).toEqual(Buffer.from("ok"));
    const calls = (await fixture.calls()).slice(before);
    expect(calls.filter(call => call.argv[0] === "machine")).toHaveLength(2);
    expect(evidence).toEqual([true]);
  } finally { await fixture.close(); }
}, 5000);


it("bounds and cancels peer resolution inside the original probe deadline", async () => {
  const fixture = await createClientFixture();
  try {
    vi.useFakeTimers(); let sawAbort = false;
    vi.spyOn(coreClient, "invokeCli").mockImplementation(async (_binary, _argv, _env, _cap, _allow, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => { sawAbort = true; reject(new Error("aborted")); }, { once: true });
    }));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] });
    const resolve = transport.resolve as unknown as (peer: import("../contracts").Peer, options: { timeoutMs: number }) => Promise<unknown>;
    const pending = resolve(peer, { timeoutMs: 1000 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(1000);
    const abortedWithinDeadline = sawAbort;
    await vi.advanceTimersByTimeAsync(60_000); // Also settle the old, longer resolution when this test is red.
    expect(await pending).toMatchObject({ code: "cli-timeout" });
    expect(abortedWithinDeadline).toBe(true);
  } finally { vi.useRealTimers(); await fixture.close(); }
}, 5000);


it("runs a 384 KiB transfer beside poll and push without monopolizing their shared route", async () => {
  const fixture = await createClientFixture(), aborters = [new AbortController(), new AbortController(), new AbortController()];
  const children: import("node:child_process").ChildProcess[] = [], roles = new Map<import("node:child_process").ChildProcess, string>(), work: Promise<unknown>[] = [];
  let allSpawned!: () => void;
  const started = new Promise<void>(resolveStarted => { allSpawned = resolveStarted; });
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawn).mockImplementation(((command: string, args: string[], options: any) => {
    const child = actual.spawn(command, args, options);
    if (args?.[0] === "exec" && (args.includes("receive") || args.includes("exchange"))) {
      children.push(child); roles.set(child, args.includes("receive") ? "transfer" : "exchange"); if (children.length === 3) allSpawned();
    }
    return child;
  }) as typeof spawn);
  try {
    await fixture.configure({ machines: [machine], roamFixture: { execHoldMs: 30_000 } });
    await fixture.writeRoamFile(peer.alias, posix.join(peer.globalRoot, "roam", "machine.json"), Buffer.from(JSON.stringify({ machineId: peer.machineId })));
    const transport = createTransport({ binary: fixture.hcBinary, env: fixture.localEnv, enrolled: [peer] }), handle = await transport.resolve(peer);
    expect(DEFAULT_LIMITS.chunkBytes).toBe(384 * 1024);
    work.push(transport.exec(handle, ["roam", "artifact", "receive"], { timeoutMs: 5000, maxBytes: 16,
      stdin: Buffer.alloc(DEFAULT_LIMITS.chunkBytes), signal: aborters[0].signal }).catch(error => error));
    for (let i = 1; i < 3; i++) work.push(transport.exec(handle, ["roam", "intercom", "exchange"], { timeoutMs: 5000, maxBytes: 16,
      stdin: Buffer.from(`fixture-channel-${i}`), signal: aborters[i].signal }).catch(error => error));
    let timer!: ReturnType<typeof setTimeout>;
    try { await Promise.race([started, new Promise<void>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("fixture concurrency timed out")), 3500); })]); }
    finally { clearTimeout(timer); }
    expect(children).toHaveLength(3); expect(children.every(child => child.exitCode === null && child.signalCode === null)).toBe(true);
    aborters[0].abort(); expect(await work[0]).toMatchObject({ code: "cli-aborted" });
    expect(children.filter(child => roles.get(child) === "exchange").every(child => child.exitCode === null && child.signalCode === null)).toBe(true);
    const begin = performance.now(); aborters[1].abort(); aborters[2].abort();
    expect(await Promise.all(work.slice(1))).toEqual([expect.objectContaining({ code: "cli-aborted" }), expect.objectContaining({ code: "cli-aborted" })]);
    expect(performance.now() - begin).toBeLessThan(3000);
    for (const child of children) { let gone = false; try { process.kill(child.pid!, 0); } catch (error) { gone = (error as NodeJS.ErrnoException).code === "ESRCH"; } expect(gone).toBe(true); }
  } finally { aborters.forEach(aborter => aborter.abort()); await Promise.allSettled(work); await fixture.close(); }
}, 5000);
