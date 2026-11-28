import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testTmpDir } from "@spider/intercom/test-support";
import { V0_TEXT_BYTES } from "@spider/intercom/roam-v0";
import {
  decodeRelayPoll, decodeRelayPollReply, encodeRelayPoll, encodeRelayPollReply,
  type RelayLinkView, type RelayPoll, type RelayPollReply, type RelayReady, type RelayResult, type RelaySubmit,
} from "@spider/intercom/relay-protocol";
import { main } from "../cli";
import type { CallOptions, Clock, Peer, Transport } from "../contracts";
import { readLocalIdentity } from "../runtime";
import { readV0Routes } from "../relocate/intercom-routes";
import { runRelayPollLoop, runV0LinkOnce } from "../relocate/relay-poll";

const RELAY = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const relay = { machineId: RELAY, alias: "hub.invalid" };
const peer: Peer = { machineId: ORIGIN, alias: "origin.invalid", node: "/node", pi: "/pi", cli: "/spider", core: "/core",
  globalRoot: "/fixture/root", agentDir: "/fixture/agent" };
const hello = { type: "hello", version: 1, relay, toMachineId: ORIGIN, linkId: "link-1", pollId: "poll-1" } as const;
const reach = { type: "reach", peers: [relay] } as const;
const ready = { type: "ready", version: 1, machineId: ORIGIN, linkId: "link-1", pollId: "poll-1", ok: true } as const;
const origin = { machineId: ORIGIN, address: { sessionId: "sender", scopeId: "scope" }, name: "origin",
  homeEpoch: 1, endpointEpoch: "origin-epoch" };
const submit = (id: string, text = "test message"): RelaySubmit => ({ type: "submit", kind: "send", from: origin,
  target: { machineId: RELAY, selector: { by: "name", value: "recipient" }, homeEpoch: 2 }, message: { id, timestamp: 1, text } });
const delivered = (id: string): RelayResult => ({ type: "result", messageId: id, attempted: true,
  outcome: { kind: "socket_delivered", id } });
const lines = (...values: unknown[]): Buffer => Buffer.from(values.map(value => `${JSON.stringify(value)}\n`).join(""));
const roots: string[] = [];

function localConfig(machineId = ORIGIN) {
  const root = mkdtempSync(join(testTmpDir(), "links-"));
  roots.push(root);
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  for (const dir of ["roam", "herdr", "agent"]) mkdirSync(join(root, dir), { mode: 0o700 });
  const write = (file: string, data: unknown) => writeFileSync(join(root, file), JSON.stringify(data), { mode: 0o600 });
  write("roam/config.json", { enabled: true, role: machineId === RELAY ? "hub" : "box", machineId, hubMachineId: RELAY,
    peers: [], discoveryRoots: [], coreUnit: "fixture.service" });
  write("roam/machine.json", { machineId });
  const agentDir = join(root, "agent");
  write("herdr/config.json", { mode: "core-only", core: { binary: "/usr/bin/env", config: join(root, "core.toml") }, globalRoot: root,
    agentDirectory: agentDir, shellRc: join(root, "shell.rc"), machines: [] });
  return { root, agentDir, config: readLocalIdentity(root), writeRoutes: (data: unknown) => write("roam/intercom-v0.json", data) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("private relay configuration and batches", () => {
  it("keeps version 1 exact and defaults the optional version 2 fields", () => {
    const { root, config, agentDir, writeRoutes } = localConfig();
    const base = { sendTo: [], acceptFrom: [relay] };
    writeRoutes({ version: 1, ...base });
    expect(readV0Routes(root, config)).toEqual({ version: 1, ...base, agentDir, relays: [], linkTo: [] });
    writeRoutes({ version: 1, ...base, relays: [] });
    expect(() => readV0Routes(root, config)).toThrow();
    writeRoutes({ version: 2, ...base });
    expect(readV0Routes(root, config)).toEqual({ version: 2, ...base, agentDir, relays: [], linkTo: [] });
    writeRoutes({ version: 2, ...base, receiveFrom: [] });
    expect(() => readV0Routes(root, config)).toThrow();
    writeRoutes({ version: 2, ...base });
    chmodSync(join(root, "roam", "intercom-v0.json"), 0o644);
    expect(() => readV0Routes(root, config)).toThrow();
  });

  it("keeps the configured order and links only from a listed relay to pinned sendTo peers", () => {
    const { root, config, writeRoutes } = localConfig(RELAY);
    const otherPeer = { ...peer, machineId: OTHER, alias: "other.invalid" };
    const routes = { version: 2, sendTo: [peer, otherPeer], acceptFrom: [], relays: [OTHER, RELAY], linkTo: [OTHER, ORIGIN] };
    writeRoutes(routes);
    expect(readV0Routes(root, config)).toMatchObject({ relays: [OTHER, RELAY], linkTo: [OTHER, ORIGIN], acceptFrom: [] });
    for (const invalid of [{ ...routes, sendTo: [peer] }, { ...routes, relays: [OTHER] },
      { ...routes, relays: [RELAY, RELAY] }, { ...routes, linkTo: [ORIGIN, ORIGIN] }, { ...routes, linkTo: ["other.invalid"] }]) {
      writeRoutes(invalid);
      expect(() => readV0Routes(root, config)).toThrow();
    }
  });

  it("accepts a full batch of independently bounded submissions", () => {
    const submissions = Array.from({ length: 16 }, (_, i) => submit(`m-${i}`, "x".repeat(V0_TEXT_BYTES)));
    const fullBatch = lines(ready, ...submissions);
    expect(fullBatch.byteLength).toBeGreaterThan(1024 * 1024);
    expect(decodeRelayPollReply(fullBatch).submissions).toEqual(submissions);
    expect(decodeRelayPollReply(encodeRelayPollReply({ ready, submissions }))).toEqual({ ready, submissions });
    expect(() => decodeRelayPollReply(lines(ready, ...submissions, submit("m-17")))).toThrow();
  });

  it("counts the LF in the frame limit and rejects invalid UTF-8", () => {
    const header = JSON.stringify(ready);
    const fits = Buffer.from(header.padEnd(262_143, " ") + "\n");
    const tooBig = Buffer.from(header.padEnd(262_144, " ") + "\n");
    expect(decodeRelayPollReply(fits).ready).toEqual(ready);
    expect(() => decodeRelayPollReply(tooBig)).toThrow("Invalid relay poll protocol");
    const malformed = lines(ready, submit("m-1"));
    malformed[malformed.indexOf("test message")] = 0xff;
    expect(() => decodeRelayPollReply(malformed)).toThrow("Invalid relay poll protocol");
    expect(() => decodeRelayPollReply(lines(ready, submit("m-1", "\\".repeat(V0_TEXT_BYTES / 2 + 1))))).toThrow();
  });

  it("rejects extra fields, incomplete batches, reordered headers, and result IDs that do not match", () => {
    const poll: RelayPoll = { holdMs: 0, hello, reach, results: [delivered("sent")] };
    expect(decodeRelayPoll(encodeRelayPoll(poll), 0)).toEqual(poll);
    const malformedPolls = [lines(hello), lines(hello, hello, reach), lines(reach, hello), lines({ ...hello, holdMs: 0 }, reach),
      lines(hello, reach, { ...delivered("sent"), outcome: { kind: "socket_delivered", id: "another" } }),
      lines(hello, reach, { ...delivered("sent"), attempted: false }),
      lines(hello, reach, ...Array.from({ length: 17 }, (_, i) => delivered(`result-${i}`)))];
    for (const bytes of malformedPolls) expect(() => decodeRelayPoll(bytes, 0)).toThrow("Invalid relay poll protocol");
    expect(() => decodeRelayPoll(lines(hello, reach, delivered("sent")), 20_000)).toThrow();
    for (const bytes of [lines(ready, ready), lines(ready).subarray(0, -1), lines({ ...ready, ok: false, code: "unauthorized" }, submit("bad")),
      lines(ready, { ...submit("bad"), from: { ...origin, pid: 123 } }),
      lines(ready, { ...submit("bad"), kind: "ask", timeoutMs: 540_001 }),
      lines(ready, { ...submit("bad"), target: { machineId: RELAY, selector: { by: "id", value: "recipient" }, homeEpoch: 0 } })]) {
      expect(() => decodeRelayPollReply(bytes)).toThrow("Invalid relay poll protocol");
    }
  });

  it("refuses an authorized version mismatch before touching the missing broker", async () => {
    const { root, writeRoutes } = localConfig();
    writeRoutes({ version: 2, sendTo: [], acceptFrom: [], relays: [RELAY] });
    const input = lines({ ...hello, version: 2 }, reach);
    const expected = { ready: { ...ready, ok: false, code: "version-mismatch" }, submissions: [] };
    expect(decodeRelayPollReply(await runV0LinkOnce(root, input, 20_000))).toEqual(expected);
    const out: string[] = [], err: string[] = [];
    const base = ["--global-root", root, "roam", "agent", "--v0", "link"];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
    expect(await main([...base, "--hold-ms", "20000"], io, { stdin: input })).toBe(0);
    expect(decodeRelayPollReply(Buffer.from(out.join("")))).toEqual(expected);
    expect(err).toEqual([]);
    expect(await main([...base, "--hold-ms", "2000"], io, { stdin: input })).toBe(2);
    expect(out).toHaveLength(1);
  });

  it("does not extend relay authorization to acceptFrom or accept a poll for another machine", async () => {
    const { root, writeRoutes } = localConfig();
    writeRoutes({ version: 2, sendTo: [], acceptFrom: [relay] });
    expect(decodeRelayPollReply(await runV0LinkOnce(root, lines(hello, reach), 0)))
      .toEqual({ ready: { ...ready, ok: false, code: "unauthorized" }, submissions: [] });
    writeRoutes({ version: 2, sendTo: [], acceptFrom: [], relays: [RELAY] });
    expect(decodeRelayPollReply(await runV0LinkOnce(root, lines({ ...hello, toMachineId: OTHER }, reach), 0)))
      .toEqual({ ready: { ...ready, machineId: OTHER, ok: false, code: "unauthorized" }, submissions: [] });
  });
});

const clock: Clock = { now: () => Date.now(), later(ms, fn) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
const tick = () => vi.advanceTimersByTimeAsync(0);

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function carrier(forward: (s: RelaySubmit, signal: AbortSignal) => Promise<RelayResult>) {
  vi.useFakeTimers({ now: 0 });
  const stop = new AbortController();
  const views: RelayLinkView[] = [];
  const calls: { poll: RelayPoll; argv: readonly string[]; options: CallOptions;
    reply(submissions?: readonly RelaySubmit[], header?: Partial<Pick<RelayReady, "pollId" | "linkId" | "machineId">>): void; reject(): void }[] = [];
  const resolves: Peer[] = [];
  const pinned = { ...peer };
  const transport: Pick<Transport, "resolve" | "exec"> = {
    async resolve(value) { resolves.push(value); return pinned; },
    async exec(value, argv, options) {
      expect(value).toBe(pinned);
      const poll = decodeRelayPoll(options.stdin!, Number(argv.at(-1)) as RelayPoll["holdMs"]);
      const d = deferred<Buffer>();
      const abort = () => d.reject(new Error("exec aborted"));
      options.signal!.addEventListener("abort", abort, { once: true });
      calls.push({ poll, argv, options, reply(submissions = [], header) {
        const reply: RelayPollReply = { ready: { ...ready, linkId: poll.hello.linkId, pollId: poll.hello.pollId, ...header }, submissions };
        d.resolve(lines(reply.ready, ...reply.submissions));
      }, reject() { d.reject(new Error("transport lost")); } });
      try { return await d.promise; } finally { options.signal!.removeEventListener("abort", abort); }
    },
  };
  const loop = runRelayPollLoop({ relay, peer, transport, clock, signal: stop.signal, reach: () => [relay], forward, observe: view => views.push(view) });
  return { calls, resolves, views, async close() { stop.abort(); await loop; } };
}

describe("the relay's paired calls", () => {
  it("reports unauthorized when the endpoint's machine differs from the intended peer", async () => {
    const { root, writeRoutes } = localConfig(OTHER);
    writeRoutes({ version: 2, sendTo: [], acceptFrom: [], relays: [RELAY] });
    vi.useFakeTimers();
    const stop = new AbortController(), views: RelayLinkView[] = [];
    const forwarded: string[] = [];
    const loop = runRelayPollLoop({ relay, peer, clock, signal: stop.signal, reach: () => [relay],
      transport: {
        async resolve(value) { return value; },
        async exec(_value, argv, options) {
          return runV0LinkOnce(root, options.stdin!, Number(argv.at(-1)) as RelayPoll["holdMs"], options.signal);
        },
      },
      async forward(submission) { forwarded.push(submission.message.id); return delivered(submission.message.id); },
      observe: view => views.push(view),
    });
    try {
      await tick();
      expect(views.at(-1)).toMatchObject({ state: "down", lastError: "unauthorized" });
      expect(forwarded).toEqual([]);
    } finally { stop.abort(); await loop; }
  });

  it("sends results without waiting for a held poll and serializes only the hold-0 replies", async () => {
    const deliveries = new Map<string, ReturnType<typeof deferred<RelayResult>>>();
    const driver = carrier(async (submission, signal) => {
      const id = submission.message.id, d = deferred<RelayResult>();
      deliveries.set(id, d);
      signal.addEventListener("abort", () => d.resolve({ type: "result", messageId: id, attempted: true,
        outcome: { kind: "unknown", id } }), { once: true });
      return d.promise;
    });
    try {
      await tick();
      const [first] = driver.calls;
      expect(first.poll.holdMs).toBe(20_000);
      first.reply([submit("earlier"), submit("another")]);
      await tick();
      const held = driver.calls[1];
      expect(held.poll).toMatchObject({ holdMs: 20_000, results: [] });
      deliveries.get("earlier")!.resolve(delivered("earlier"));
      await tick();
      const withResult = driver.calls[2];
      // Neither test reply has been released. Seeing the result exec now
      // proves it did not wait for held.reply().
      expect(withResult.poll).toMatchObject({ holdMs: 0, results: [{ messageId: "earlier" }] });
      expect(new Set(driver.calls.map(call => call.poll.hello.pollId)).size).toBe(3);
      for (const call of [held, withResult]) {
        expect(call.argv).toEqual(["roam", "agent", "--v0", "link", "--hold-ms", String(call.poll.holdMs)]);
        expect(call.options).toMatchObject({ remoteTimeoutMs: 25_000, timeoutMs: 30_000, postReserveMs: 2000, maxBytes: 18 * 262_144 });
      }
      deliveries.get("another")!.resolve(delivered("another"));
      await tick();
      expect(driver.calls).toHaveLength(3);
      withResult.reply([submit("from-quick")]);
      await tick();
      expect(deliveries.has("from-quick")).toBe(true);
      const next = driver.calls[3];
      expect(next.poll.holdMs).toBe(0);
      expect(next.poll.results.map(r => r.messageId)).toEqual(["another"]);
      expect(next.poll.hello.linkId).toBe(held.poll.hello.linkId);
      await driver.close();
      expect([held.options.signal?.aborted, next.options.signal?.aborted]).toEqual([true, true]);
    } finally { await driver.close(); }
  });

  it.each(["pollId", "linkId", "machineId"] as const)("does not accept a changed %s in a ready reply", async field => {
    const forwarded: string[] = [];
    const driver = carrier(async submission => { forwarded.push(submission.message.id); return delivered(submission.message.id); });
    try {
      await tick();
      driver.calls[0].reply([submit("not-for-this-poll")], { [field]: "different.invalid" });
      await tick();
      expect(forwarded).toEqual([]);
      expect(driver.views.at(-1)?.state).toBe("down");
    } finally { await driver.close(); }
  });

  it("refuses a forged origin without invoking delivery", async () => {
    const forwarded: string[] = [];
    const driver = carrier(async submission => { forwarded.push(submission.message.id); return delivered(submission.message.id); });
    try {
      await tick();
      driver.calls[0].reply([{ ...submit("forged"), from: { ...origin, machineId: OTHER } }]);
      await tick();
      expect(forwarded).toEqual([]);
      const result = driver.calls.find(call => call.poll.holdMs === 0)!.poll.results;
      expect(result).toEqual([{ type: "result", messageId: "forged", attempted: false, outcome: { kind: "refused", code: "unauthorized" } }]);
    } finally { await driver.close(); }
  });

  it("aborts the held call and drains deliveries when a result call fails, without replay on reconnect", async () => {
    let drained = false;
    const driver = carrier(async (submission, signal) => {
      const id = submission.message.id;
      if (id === "active") {
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        drained = true;
      }
      return delivered(id);
    });
    try {
      await tick();
      driver.calls[0].reply([submit("settled"), submit("active")]);
      await tick();
      const held = driver.calls.find((call, i) => i > 0 && call.poll.holdMs > 0)!;
      const result = driver.calls.find(call => call.poll.holdMs === 0)!;
      result.reject();
      await tick();
      expect(held.options.signal?.aborted).toBe(true);
      expect(drained).toBe(true);
      expect(driver.views.at(-1)?.state).toBe("down");
      expect(driver.calls).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1000);
      const restarted = driver.calls[3].poll;
      expect(restarted.hello.linkId).not.toBe(held.poll.hello.linkId);
      expect(restarted).toMatchObject({ holdMs: 20_000, results: [] });
      expect(driver.resolves).toEqual([peer, peer]);
    } finally { await driver.close(); }
  });

  it("backs off exponentially and stays capped at 30 seconds", async () => {
    const driver = carrier(async s => delivered(s.message.id));
    const starts = [0], delays = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000];
    try {
      await tick();
      for (const [i, expected] of delays.entries()) {
        driver.calls[i].reject();
        await tick();
        await vi.advanceTimersByTimeAsync(expected - 1);
        expect(driver.calls).toHaveLength(i + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(driver.calls).toHaveLength(i + 2);
        starts.push(Date.now());
      }
      expect(starts.slice(1).map((start, i) => start - starts[i])).toEqual(delays);
    } finally { await driver.close(); }
  });
});
