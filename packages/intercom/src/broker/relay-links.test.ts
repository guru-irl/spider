import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { startTestBroker, stopTestBroker, testBrokerEnv } from "../test-support.js";
import type { RelayPoll, RelayResult, RelaySubmit } from "../relay-protocol.js";
import { IntercomClient } from "./client.js";
import { createRelayLinks } from "./relay-links.js";
import { listV0RelayLinks, pollV0RelayBroker, submitV0Relay } from "./roam-relay-client.js";
import { requestV0Broker } from "./roam-v0-client.js";

const relay = { machineId: "relay.invalid", alias: "relay.invalid" };
const origin = { machineId: "origin.invalid", address: { sessionId: "sender", scopeId: null },
  name: "origin", homeEpoch: 1, endpointEpoch: "origin-epoch" };
const submission = (id: string): RelaySubmit => ({ type: "submit", kind: "send", from: origin,
  target: { machineId: relay.machineId, selector: { by: "id", value: "recipient" } },
  message: { id, timestamp: 1, text: "test message" } });
const delivered = (id: string): RelayResult => ({ type: "result", messageId: id, attempted: true,
  outcome: { kind: "socket_delivered", id } });
const poll = (pollId: string, holdMs: RelayPoll["holdMs"] = 20_000, results: readonly RelayResult[] = [], linkId = "link-1"): RelayPoll => ({
  holdMs, hello: { type: "hello", version: 1, relay, toMachineId: origin.machineId, linkId, pollId },
  reach: { type: "reach", peers: [relay] }, results,
});

function fixture() {
  vi.useFakeTimers({ now: 0 });
  return createRelayLinks({ now: Date.now, wallNow: Date.now, later(ms, fn) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } });
}

afterEach(() => vi.useRealTimers());

describe("held relay polls", () => {
  it("holds an empty poll and wakes early for a live submission", async () => {
    const links = fixture();
    let settled = false;
    const empty = links.poll(poll("empty")).then(reply => { settled = true; return reply; });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await empty).toMatchObject({ ready: { ok: true, pollId: "empty" }, submissions: [] });

    const pending = links.poll(poll("held"));
    const send = links.submit(relay.machineId, submission("early"));
    const early = await pending;
    expect(early.submissions.map(value => value.message.id)).toEqual(["early"]);
    expect(Date.now()).toBe(20_000);
    await links.poll(poll("result", 0, [delivered("early")]));
    expect(await send).toEqual(delivered("early"));
    links.close();
  });

  it("hands a submission to exactly one of two competing calls", async () => {
    const links = fixture();
    await links.poll(poll("announce", 0));
    const send = links.submit(relay.machineId, submission("once"));
    const held = links.poll(poll("held"));
    const quick = links.poll(poll("quick", 0));
    const [heldReply, resultCallReply] = await Promise.all([held, quick]);
    expect(heldReply.ready).toMatchObject({ ok: true, pollId: "held" });
    expect(resultCallReply.ready).toMatchObject({ ok: true, pollId: "quick" });
    expect([...heldReply.submissions, ...resultCallReply.submissions].map(s => s.message.id)).toEqual(["once"]);
    await links.poll(poll("result", 0, [delivered("once")]));
    expect(await send).toEqual(delivered("once"));
    links.close();
  });

  it("returns empty when a submission arrives at the hold deadline before the timer runs", async () => {
    const links = fixture();
    const held = links.poll(poll("hold"));
    vi.setSystemTime(20_000);
    const send = links.submit(relay.machineId, submission("after-hold"));
    expect((await held).submissions).toEqual([]);
    expect((await links.poll(poll("next", 0))).submissions.map(s => s.message.id)).toEqual(["after-hold"]);
    await links.poll(poll("result", 0, [delivered("after-hold")]));
    expect(await send).toEqual(delivered("after-hold"));
    links.close();
  });

  it("takes a waiting submission in a hold-0 call with no held call", async () => {
    const links = fixture();
    await links.poll(poll("announce", 0));
    const send = links.submit(relay.machineId, submission("waiting"));
    const reply = await links.poll(poll("take", 0));
    expect(reply.submissions.map(s => s.message.id)).toEqual(["waiting"]);
    expect(Date.now()).toBe(0);
    await links.poll(poll("result", 0, [delivered("waiting")]));
    expect(await send).toEqual(delivered("waiting"));
    links.close();
  });

  it("refuses overflow across handed-off and waiting submissions", async () => {
    const links = fixture();
    const held = links.poll(poll("held"));
    const first = links.submit(relay.machineId, submission("first"));
    expect((await held).submissions.map(s => s.message.id)).toEqual(["first"]);
    const waiting = Array.from({ length: 15 }, (_, i) => links.submit(relay.machineId, submission(`waiting-${i}`)));
    const seventeenth = links.submit(relay.machineId, submission("seventeenth"));
    // Advancing just the hand-off deadline also makes this test terminate if
    // overflow is wrongly accepted, without mistaking expiry for relay-busy.
    await vi.advanceTimersByTimeAsync(2000);
    expect(await seventeenth).toMatchObject({ attempted: false, outcome: { code: "relay-busy" } });
    links.close();
    await Promise.all([first, ...waiting]);
  });

  it.each(["abort", "deadline"])("keeps handed slots occupied after the sender's %s", async endedBy => {
    const links = fixture();
    const oldIds = Array.from({ length: 16 }, (_, i) => `old-${i}`);
    const newIds = Array.from({ length: 16 }, (_, i) => `new-${i}`);
    const aborts = oldIds.map(() => new AbortController());
    try {
      await links.poll(poll("announce", 0));
      const old = oldIds.map((id, i) => links.submit(relay.machineId, submission(id), aborts[i].signal, 5000));
      expect((await links.poll(poll("take-old", 0))).submissions.map(s => s.message.id)).toEqual(oldIds);
      if (endedBy === "abort") aborts.forEach(abort => abort.abort());
      else await vi.advanceTimersByTimeAsync(5000);
      expect((await Promise.all(old)).map(result => result.outcome)).toEqual(oldIds.map(id => ({ kind: "unknown", id })));

      const blocked = newIds.map(id => links.submit(relay.machineId, submission(id)));
      await vi.advanceTimersByTimeAsync(2000);
      expect((await Promise.all(blocked)).map(result => [result.attempted, result.outcome])).toEqual(
        newIds.map(() => [false, { kind: "refused", code: "relay-busy" }]),
      );
      expect((await links.poll(poll("still-full", 0))).submissions).toEqual([]);
      expect(links.list()[0]).toMatchObject({ state: "up", linkId: "link-1" });

      const settled = await links.poll(poll("finish-old", 0, oldIds.map(delivered)));
      expect(settled.ready.ok).toBe(true);
      const resumed = newIds.map(id => links.submit(relay.machineId, submission(id)));
      expect((await links.poll(poll("take-new", 0))).submissions.map(s => s.message.id)).toEqual(newIds);
      await links.poll(poll("finish-new", 0, newIds.map(delivered)));
      expect(await Promise.all(resumed)).toEqual(newIds.map(delivered));
    } finally { links.close(); }
  });

  it("does not hand off an expired submission", async () => {
    const links = fixture();
    await links.poll(poll("announce", 0));
    const expired = links.submit(relay.machineId, submission("expired"));
    // The poll can become runnable after the deadline but before the timer callback.
    vi.setSystemTime(2000);
    const next = await links.poll(poll("next", 0));
    expect(next.submissions).toEqual([]);
    expect(await expired).toEqual({ type: "result", messageId: "expired", attempted: false,
      outcome: { kind: "refused", code: "unreachable" } });
    links.close();
  });

  it("expires the result wait after hand-off as unknown", async () => {
    const links = fixture();
    await links.poll(poll("announce", 0));
    const send = links.submit(relay.machineId, submission("late"));
    expect((await links.poll(poll("take", 0))).submissions).toHaveLength(1);
    const next = links.poll(poll("next"));
    // A tardy result isn't authoritative just because its event runs first.
    vi.setSystemTime(20_000);
    await links.poll(poll("result", 0, [delivered("late")]));
    expect(await send).toMatchObject({ attempted: true, outcome: { kind: "unknown", id: "late" } });
    expect(links.list()[0].messagesCarried).toBe(0);
    links.close();
    await next;
  });

  it("keeps an active call up and expires 10 seconds after the last normal call ends", async () => {
    const links = fixture();
    const held = links.poll(poll("held"));
    await vi.advanceTimersByTimeAsync(5000);
    const quick = await links.poll(poll("quick", 0));
    expect(quick.ready.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(links.list()[0]).toMatchObject({ state: "up", sinceMs: 0, lastCallMs: 5000 });
    await vi.advanceTimersByTimeAsync(1);
    expect((await held).submissions).toEqual([]);
    await vi.advanceTimersByTimeAsync(9999);
    expect(links.list()[0].state).toBe("up");
    await vi.advanceTimersByTimeAsync(1);
    expect(links.list()[0]).toMatchObject({ state: "down", sinceMs: 30_000, lastCallMs: 5000 });
    links.close();
  });

  it("keeps hand-off, hold, and grace on elapsed time across wall-clock steps", async () => {
    const epoch = 1_700_000_000_000;
    vi.useFakeTimers({ now: epoch, toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const clock = { now: () => performance.now(), wallNow: Date.now,
      later(ms: number, fn: () => void) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
    const links = createRelayLinks(clock);
    try {
      await links.poll(poll("announce", 0));
      const waiting = links.submit(relay.machineId, submission("waiting"));
      vi.setSystemTime(epoch + 60_000);
      expect((await links.poll(poll("take", 0))).submissions.map(s => s.message.id)).toEqual(["waiting"]);
      await links.poll(poll("result", 0, [delivered("waiting")]));
      expect(await waiting).toEqual(delivered("waiting"));
      expect(links.list()[0]).toMatchObject({ sinceMs: epoch, lastCallMs: epoch + 60_000 });

      const held = links.poll(poll("hold"));
      await vi.advanceTimersByTimeAsync(19_999);
      vi.setSystemTime(epoch + 120_000);
      const send = links.submit(relay.machineId, submission("wake"));
      expect((await held).submissions.map(s => s.message.id)).toEqual(["wake"]);
      await links.poll(poll("finish", 0, [delivered("wake")]));
      expect(await send).toEqual(delivered("wake"));

      await vi.advanceTimersByTimeAsync(9999);
      vi.setSystemTime(epoch + 180_000);
      expect(links.list()[0].state).toBe("up");
      await vi.advanceTimersByTimeAsync(1);
      expect(links.list()[0]).toMatchObject({ state: "down", sinceMs: epoch + 180_001, lastCallMs: epoch + 120_000 });
    } finally { links.close(); }
  });

  it.each([20_000, 0] as const)("drops immediately when the %i ms call closes without its reply", async holdMs => {
    const links = fixture();
    const heldAbort = new AbortController(), quickAbort = new AbortController();
    const held = links.poll(poll("held"), heldAbort.signal);
    const quick = links.poll(poll("quick", 0), quickAbort.signal, async () => {
      await new Promise<void>(resolve => quickAbort.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    expect(links.list()[0].state).toBe("up");
    (holdMs === 20_000 ? heldAbort : quickAbort).abort();
    expect(links.list()[0].state).toBe("down");
    expect(Date.now()).toBe(0);
    heldAbort.abort(); quickAbort.abort();
    await Promise.all([held, quick]);
    expect(vi.getTimerCount()).toBe(0);
    links.close();
  });

  it("refuses a second active call of the same kind", async () => {
    const links = fixture();
    const held = links.poll(poll("held"));
    expect(await links.poll(poll("another-held"))).toMatchObject({ ready: { ok: false, code: "relay-busy" }, submissions: [] });
    let endQuick!: () => void;
    const quick = links.poll(poll("quick", 0), undefined, () => new Promise<void>(resolve => { endQuick = resolve; }));
    expect(await links.poll(poll("another-quick", 0))).toMatchObject({ ready: { ok: false, code: "relay-busy" }, submissions: [] });
    endQuick();
    await quick;
    expect(links.list()[0].state).toBe("up");
    links.close();
    await held;
  });

  it("ignores duplicate and old-generation results", async () => {
    const links = fixture();
    const old = links.poll(poll("take-old"));
    const lost = links.submit(relay.machineId, submission("lost"));
    expect((await old).submissions).toHaveLength(1);
    const abort = new AbortController();
    const waiting = links.poll(poll("wait-old"), abort.signal);
    abort.abort();
    await waiting;

    await links.poll(poll("announce-new", 0, [], "link-2"));
    let settled = false;
    const current = links.submit(relay.machineId, submission("lost")).then(result => { settled = true; return result; });
    expect((await links.poll(poll("take-new", 0, [], "link-2"))).submissions).toHaveLength(1);
    const late = await links.poll(poll("late-result", 0, [delivered("lost")]));
    expect(late).toMatchObject({ ready: { ok: false }, submissions: [] });
    expect(settled).toBe(false);
    expect((await lost).outcome).toEqual({ kind: "unknown", id: "lost" });
    await links.poll(poll("new-result", 0, [delivered("lost"), delivered("lost")], "link-2"));
    expect(await current).toEqual(delivered("lost"));
    expect(links.list()[0]).toMatchObject({ linkId: "link-2", messagesCarried: 1 });
    links.close();
  });

  it("removes a cancelled local wait without re-offering an already handed-off message", async () => {
    const links = fixture();
    await links.poll(poll("announce", 0));
    const abortWaiting = new AbortController();
    const waiting = links.submit(relay.machineId, submission("cancelled"), abortWaiting.signal);
    abortWaiting.abort();
    expect(await waiting).toMatchObject({ attempted: false });
    expect((await links.poll(poll("empty", 0))).submissions).toEqual([]);
    const abortHanded = new AbortController();
    const handed = links.submit(relay.machineId, submission("handed"), abortHanded.signal);
    expect((await links.poll(poll("take", 0))).submissions).toHaveLength(1);
    abortHanded.abort();
    expect(await handed).toMatchObject({ attempted: true, outcome: { kind: "unknown", id: "handed" } });
    expect((await links.poll(poll("empty-again", 0))).submissions).toEqual([]);
    links.close();
  });
});

describe.runIf(process.platform === "linux" && process.env.GITHUB_ACTIONS === "true")("packed private relay broker", () => {
  it("hands off a live origin's submission and reports an aborted overlapping call", async () => {
    const env = testBrokerEnv(), agentDir = env.PI_CODING_AGENT_DIR!;
    const broker = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const client = new IntercomClient();
    const abort = new AbortController();
    let inFlight: Promise<unknown> | undefined;
    try {
      const [startup] = await once(broker.stdout, "data");
      expect(String(startup)).toContain("Intercom broker started");
      await client.connect({ address: origin.address, name: origin.name, cwd: "/fixture", model: "fixture",
        startedAt: 1, lastActivity: 1, pid: process.pid, v0HomeEpoch: origin.homeEpoch }, "fixture-origin");
      const local = await requestV0Broker(agentDir, { kind: "lookup", scopeId: null, selector: { by: "id", value: origin.address.sessionId } });
      if (local.kind !== "matches" || local.targets.length !== 1) throw new Error("fixture origin was not registered");
      await pollV0RelayBroker(agentDir, poll("announce", 0));
      const held = pollV0RelayBroker(agentDir, poll("take"));
      inFlight = held;
      const sent = { ...submission("packed"), from: { machineId: origin.machineId, ...local.targets[0] } };
      const result = submitV0Relay(agentDir, relay.machineId, sent);
      expect((await held).submissions).toEqual([sent]);
      const beforeOverlap = (await listV0RelayLinks(agentDir))[0].lastCallMs!;
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(beforeOverlap));
      const overlap = pollV0RelayBroker(agentDir, poll("overlap"), abort.signal);
      inFlight = overlap;
      await vi.waitFor(async () => expect((await listV0RelayLinks(agentDir))[0].lastCallMs).toBeGreaterThan(beforeOverlap));
      expect(await pollV0RelayBroker(agentDir, poll("result", 0, [delivered("packed")]))).toMatchObject({ ready: { ok: true, pollId: "result" } });
      expect(await result).toEqual(delivered("packed"));
      await vi.waitFor(async () => expect((await listV0RelayLinks(agentDir))[0]).toMatchObject({ state: "up", messagesCarried: 1 }));
      abort.abort();
      await overlap;
      await vi.waitFor(async () => expect((await listV0RelayLinks(agentDir))[0].state).toBe("down"));
    } finally {
      abort.abort();
      await client.disconnect();
      await stopTestBroker(broker);
      await inFlight;
    }
  });
});
