import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeRelayPoll, encodeRelayPollReply, type RelayPoll, type RelaySubmit, type RelayResult } from "@spider/intercom/relay-protocol";
import type { Clock, Peer, RoamConfig } from "../contracts";
import type { V0Routes } from "../relocate/intercom-routes";
import { assembleRelaySoak, checkRelaySoak, relaySoakMain, runRelaySoakDial, runRelaySoakSubmit, runRelaySoakBurst,
  type RelaySoakEvidence, type RelaySoakFault, type RelaySoakLinkEvidence, type RelaySoakRecord } from "../relocate/relay-soak";

const START = 1_700_000_000_000;
const END = START + 8 * 60 * 60 * 1000;
const ALLOWANCE = 10_000_000;
const MINUTE = 60_000;
const machines = ["laptop.invalid", "box-a.invalid", "box-b.invalid", "box-c.invalid"];

type Mutable<T> = { -readonly [P in keyof T]: T[P] extends readonly (infer U)[] ? Mutable<U>[] : T[P] extends object ? Mutable<T[P]> : T[P] };
type Evidence = Mutable<RelaySoakEvidence>;
type Link = Mutable<RelaySoakLinkEvidence>;
type Fault = Mutable<RelaySoakFault>;

function completeEvidence(): Evidence {
  const links: Link[] = [
    ["laptop-box", "laptop-to-box", machines[0], machines[1]],
    ["box-a-box-b", "box-to-box", machines[1], machines[2]],
    ["box-b-box-c", "box-to-box", machines[2], machines[3]],
  ].map(([id, topology, relayId, peerId], index) => ({
    id, topology: topology as Link["topology"], relayId, peerId,
    runs: ["dial", "submit"].map((role, roleIndex) => ({ role: role as "dial" | "submit", startMs: START, endMs: END,
      rssAllowanceBytes: ALLOWANCE, machineId: role === "dial" ? relayId : peerId,
      process: { pid: 200 + index * 2 + roleIndex, birthId: `birth-${index}-${roleIndex}`, bootId: `boot-${role === "dial" ? relayId : peerId}` } })),
    clock: {
      fromMs: START, toMs: END + MINUTE, minOffsetMs: 0, maxOffsetMs: 0,
      samples: Array.from({ length: 49 }, (_, i) => ({ sentMs: START + i * 10 * MINUTE,
        remoteMs: START + i * 10 * MINUTE, receivedMs: START + i * 10 * MINUTE })),
    },
    submissions: [], handoffs: [], outcomes: [], receipts: [], states: [], calls: [], rss: [],
  }));
  const faults: Fault[] = [
    { kind: "relay-kill", clock: "relay", linkIds: [links[0].id], startMs: START + 60 * MINUTE, clearMs: START + 60 * MINUTE + 40_000,
      process: { machineId: machines[0], pid: 80, birthId: "800", bootId: "boot-a", observedMs: START + 60 * MINUTE } },
    { kind: "herdr-restart-relay", clock: "relay", linkIds: [links[0].id], startMs: START + 90 * MINUTE, clearMs: START + 90 * MINUTE + 40_000,
      process: { machineId: machines[0], pid: 81, birthId: "810", bootId: "boot-a", observedMs: START + 90 * MINUTE } },
    { kind: "herdr-restart-peer", clock: "peer", linkIds: [links[1].id], startMs: START + 120 * MINUTE, clearMs: START + 120 * MINUTE + 40_000,
      process: { machineId: machines[2], pid: 82, birthId: "820", bootId: "boot-b", observedMs: START + 120 * MINUTE } },
    { kind: "route-cut", clock: "relay", linkIds: [links[1].id], startMs: START + 180 * MINUTE, clearMs: START + 181 * MINUTE },
    { kind: "laptop-sleep", clock: "relay", linkIds: [links[0].id], startMs: START + 240 * MINUTE, clearMs: START + 240 * MINUTE + 40_000 },
    { kind: "endpoint-kill", clock: "peer", linkIds: [links[2].id], startMs: START + 300 * MINUTE, clearMs: START + 300 * MINUTE + 40_000,
      endpoint: { machineId: machines[3], pid: 87, birthId: "12345", bootId: "boot-c", pollId: "held-1", observedMs: START + 300 * MINUTE } },
  ];
  for (const link of links) {
    for (let atMs = START; atMs < END; atMs += 5000) {
      const id = `${link.id}-${atMs}`;
      link.submissions.push({ id, atMs, deadlineMs: atMs + 20_000, kind: "cadence", scheduledMs: atMs });
      link.handoffs.push({ id, atMs: atMs + 100 });
      link.receipts.push({ id, atMs: atMs + 101 });
      link.outcomes.push({ id, atMs: atMs + 200, kind: "socket_delivered" });
    }
    for (let atMs = START; atMs <= END; atMs += 5000) {
      const down = faults.some(fault => fault.linkIds.includes(link.id) && atMs >= fault.startMs + 1000 && atMs < fault.clearMs + 1000);
      link.states.push({ atMs, state: down ? "down" : "up" });
    }
    for (let atMs = START - 30_000; atMs <= END + 30_000; atMs += 30_000) link.rss.push({ atMs, bytes: 100_000_000, process: { ...link.runs[0].process } });
    link.calls.push({ pollId: `${link.id}-held`, holdMs: 20_000, startMs: START, endMs: START + 1000, process: { ...link.runs[0].process } });
    link.calls.push({ pollId: `${link.id}-result`, holdMs: 0, startMs: START + 100, endMs: START + 200, process: { ...link.runs[0].process } });
  }
  const burstAt = START + 30 * MINUTE;
  for (let i = 0; i < 100; i++) {
    const id = `burst-${i}`;
    links[0].submissions.push({ id, atMs: burstAt, deadlineMs: burstAt + 20_000, kind: "burst", burstId: "burst-1" });
    // The broker can refuse overflow. Those submissions still need outcomes.
    links[0].outcomes.push({ id, atMs: burstAt + 200, kind: "refused" });
  }
  const endpoint = faults.find(fault => fault.kind === "endpoint-kill")!;
  links[2].calls.push({ pollId: "held-1", holdMs: 20_000, startMs: endpoint.startMs - 1000, endMs: endpoint.startMs + 1000,
    process: { ...links[2].runs[0].process } });
  return {
    startMs: START, endMs: END, rssAllowanceBytes: ALLOWANCE, links, faults,
    processes: machines.map(machineId => ({ machineId,
      before: { atMs: START - 1000, complete: true, identities: [{ pid: 10, birthId: "100", bootId: `boot-${machineId}` }] },
      after: { atMs: END + 1000, complete: true, identities: [{ pid: 10, birthId: "100", bootId: `boot-${machineId}` }] },
    })),
  };
}

let baseline: Evidence;
beforeAll(() => { baseline = completeEvidence(); });
const copy = (): Evidence => structuredClone(baseline);
const faultOf = (evidence: Evidence, kind: Fault["kind"]): Fault => evidence.faults.find(fault => fault.kind === kind)!;
const markDownAt = (link: Link, fault: Fault, delay: number): void => {
  for (const state of link.states) {
    if (state.atMs >= fault.startMs && state.atMs < fault.startMs + delay) state.state = "up";
  }
  link.states.push({ atMs: fault.startMs + delay, state: "down" });
  link.states.sort((a, b) => a.atMs - b.atMs);
};
const markUpAt = (link: Link, fault: Fault, delay: number): void => {
  for (const state of link.states) {
    if (state.atMs >= fault.clearMs && state.atMs < fault.clearMs + delay) state.state = "down";
  }
  link.states.push({ atMs: fault.clearMs + delay, state: "up" });
  link.states.sort((a, b) => a.atMs - b.atMs);
};

describe("the live relay soak reliability gate", () => {
  it("accepts a complete eight-hour, three-link run with all faults and a 100-message burst", () => {
    expect(checkRelaySoak(baseline)).toEqual({ ok: true, violations: [] });
  });

  it("rejects a second independent sink receipt for one message", () => {
    const evidence = copy();
    evidence.links[0].receipts.push({ ...evidence.links[0].receipts[0] });
    expect(checkRelaySoak(evidence).violations).toContain("duplicate-receipt");
  });

  it("rejects missing, duplicate, or late final outcomes", () => {
    for (const change of ["missing", "duplicate", "late"] as const) {
      const evidence = copy(), link = evidence.links[0], first = link.outcomes[0];
      if (change === "missing") link.outcomes.shift();
      if (change === "duplicate") link.outcomes.push({ ...first });
      if (change === "late") first.atMs = link.submissions[0].deadlineMs + 1;
      expect(checkRelaySoak(evidence).violations, change).toContain("outcome");
    }
  });

  it("allows unknown only when that message was in flight at an affected fault", () => {
    const evidence = copy(), link = evidence.links[0], fault = faultOf(evidence, "relay-kill");
    const during = link.submissions.find(submit => submit.atMs === fault.startMs)!;
    const result = link.outcomes.find(outcome => outcome.id === during.id)!;
    result.kind = "unknown";
    expect(checkRelaySoak(evidence).violations).not.toContain("unknown-outside-fault");
    const outside = link.outcomes[0];
    outside.kind = "unknown";
    expect(checkRelaySoak(evidence).violations).toContain("unknown-outside-fault");
    outside.kind = "socket_delivered";
    fault.linkIds = [evidence.links[1].id];
    expect(checkRelaySoak(evidence).violations).toContain("unknown-outside-fault");
  });

  it("detects a stall at 30 seconds but not at 30,001 milliseconds", () => {
    const exact = copy(), fault = faultOf(exact, "relay-kill");
    markDownAt(exact.links[0], fault, 30_000);
    expect(checkRelaySoak(exact).violations).not.toContain("stall-detection");
    const late = copy(), laterFault = faultOf(late, "relay-kill");
    markDownAt(late.links[0], laterFault, 30_001);
    expect(checkRelaySoak(late).violations).toContain("stall-detection");
  });

  it("recovers at 60 seconds but not at 60,001 milliseconds", () => {
    const exact = copy(), fault = faultOf(exact, "relay-kill");
    markUpAt(exact.links[0], fault, 60_000);
    expect(checkRelaySoak(exact).violations).not.toContain("recovery");
    const late = copy(), laterFault = faultOf(late, "relay-kill");
    markUpAt(late.links[0], laterFault, 60_001);
    expect(checkRelaySoak(late).violations).toContain("recovery");
  });

  it("requires at least 99 percent of healthy handoffs to be strictly under two seconds", () => {
    const evidence = copy(), link = evidence.links[1];
    for (let i = 0; i < 58; i++) {
      link.handoffs[i].atMs = link.submissions[i].atMs + 2000;
      link.receipts[i].atMs = link.handoffs[i].atMs + 1;
      link.outcomes[i].atMs = link.receipts[i].atMs + 1;
    }
    expect(checkRelaySoak(evidence).violations).toContain("handoff");
  });

  it("counts clock-offset uncertainty against the handoff limit", () => {
    const evidence = copy(), link = evidence.links[1];
    link.clock.minOffsetMs = -101;
    for (let i = 0; i < 58; i++) {
      link.handoffs[i].atMs = link.submissions[i].atMs + 1900;
      link.receipts[i].atMs = link.handoffs[i].atMs + 1;
      link.outcomes[i].atMs = link.receipts[i].atMs + 1;
    }
    expect(checkRelaySoak(evidence).violations).toContain("handoff");
  });

  it("accepts clock bounds measured from the relay over its existing route to the peer", () => {
    const evidence = copy(), link = evidence.links[1];
    link.clock.minOffsetMs = 900;
    link.clock.maxOffsetMs = 1100;
    for (const sample of link.clock.samples) {
      sample.sentMs = sample.remoteMs + 900;
      sample.receivedMs = sample.remoteMs + 1100;
    }
    for (const sample of [...link.handoffs, ...link.receipts, ...link.rss]) sample.atMs += 1000;
    for (const call of link.calls) { call.startMs += 1000; if (call.endMs !== null) call.endMs += 1000; }
    const cut = faultOf(evidence, "route-cut");
    cut.startMs += 1000; cut.clearMs += 1000;
    expect(checkRelaySoak(evidence)).toEqual({ ok: true, violations: [] });
  });

  it("counts fault-clock uncertainty against stall detection, recovery, and unknown attribution", () => {
    const detection = copy(), link = detection.links[0], fault = faultOf(detection, "relay-kill");
    link.clock.minOffsetMs = -100; link.clock.maxOffsetMs = 100;
    markDownAt(link, fault, 30_000);
    expect(checkRelaySoak(detection).violations).toContain("stall-detection");

    const recovery = copy(), recovering = recovery.links[0], recoveringFault = faultOf(recovery, "relay-kill");
    recovering.clock.minOffsetMs = -100; recovering.clock.maxOffsetMs = 100;
    markUpAt(recovering, recoveringFault, 60_000);
    expect(checkRelaySoak(recovery).violations).toContain("recovery");

    const unknown = copy(), affected = unknown.links[0], injected = faultOf(unknown, "relay-kill");
    affected.clock.minOffsetMs = -100; affected.clock.maxOffsetMs = 100;
    const submit = affected.submissions.find(item => item.atMs === injected.startMs)!;
    affected.outcomes.find(item => item.id === submit.id)!.kind = "unknown";
    expect(checkRelaySoak(unknown).violations).toContain("unknown-outside-fault");
  });

  it("fails closed on missing, inconsistent, or gapped clock bounds", () => {
    const missing = copy();
    missing.links[0].clock.samples = [];
    expect(checkRelaySoak(missing).violations).toContain("clock");
    const inconsistent = copy();
    inconsistent.links[0].clock.samples[0].remoteMs += 20;
    expect(checkRelaySoak(inconsistent).violations).toContain("clock");
    const gap = copy();
    gap.links[0].clock.samples.splice(2, 1);
    expect(checkRelaySoak(gap).violations).toContain("clock");
  });

  it("requires one sink receipt for delivery and none for refusal", () => {
    const missing = copy();
    missing.links[0].receipts.shift();
    expect(checkRelaySoak(missing).violations).toContain("receipt");
    const refused = copy();
    refused.links[0].outcomes[0].kind = "refused";
    expect(checkRelaySoak(refused).violations).toContain("receipt");
  });

  it("counts broker refusals and rejects missing cadence or burst submissions", () => {
    const missingCadence = copy();
    missingCadence.links[0].submissions.shift();
    expect(checkRelaySoak(missingCadence).violations).toContain("timeline");
    const missingBurst = copy();
    missingBurst.links[0].submissions.pop();
    expect(checkRelaySoak(missingBurst).violations).toContain("burst");
    const missingRefusal = copy();
    missingRefusal.links[0].outcomes.pop();
    expect(checkRelaySoak(missingRefusal).violations).toContain("outcome");
  });

  it("requires the full link topology and all named faults, including a 60-second cut", () => {
    const shortRun = copy();
    shortRun.endMs--;
    expect(checkRelaySoak(shortRun).violations).toContain("timeline");
    const missingLink = copy();
    missingLink.links.pop();
    expect(checkRelaySoak(missingLink).violations).toContain("timeline");
    const missingFault = copy();
    missingFault.faults = missingFault.faults.filter(fault => fault.kind !== "laptop-sleep");
    expect(checkRelaySoak(missingFault).violations).toContain("faults");
    const shortCut = copy();
    faultOf(shortCut, "route-cut").clearMs--;
    expect(checkRelaySoak(shortCut).violations).toContain("faults");
  });

  it("requires birth identities for the relay and restarted Herdr processes", () => {
    const evidence = copy();
    delete faultOf(evidence, "relay-kill").process;
    expect(checkRelaySoak(evidence).violations).toContain("faults");
  });

  it("requires the killed endpoint's birth identity and a matching active held call", () => {
    const missing = copy();
    delete faultOf(missing, "endpoint-kill").endpoint;
    expect(checkRelaySoak(missing).violations).toContain("endpoint");
    const wrongCall = copy();
    wrongCall.links[2].calls.find(call => call.pollId === "held-1")!.endMs = faultOf(wrongCall, "endpoint-kill").startMs - 1;
    expect(checkRelaySoak(wrongCall).violations).toContain("endpoint");
  });

  it("requires evidence of both held calls and separate result calls on every link", () => {
    const evidence = copy();
    evidence.links[0].calls = evidence.links[0].calls.filter(call => call.holdMs !== 0);
    expect(checkRelaySoak(evidence).violations).toContain("timeline");
  });

  it("accepts a missing call end only when that dial process was killed during the call", () => {
    const evidence = copy(), link = evidence.links[0], fault = faultOf(evidence, "relay-kill");
    fault.process = { ...link.runs[0].process, machineId: link.relayId, observedMs: fault.startMs };
    link.calls.push({ pollId: "interrupted", holdMs: 20_000, startMs: fault.startMs - 1000, endMs: null, process: { ...link.runs[0].process } });
    expect(checkRelaySoak(evidence).violations).not.toContain("timeline");
    fault.process.birthId = "different-process";
    expect(checkRelaySoak(evidence).violations).toContain("timeline");
  });

  it("requires complete before and after birth-identity censuses with no new helpers", () => {
    const absent = copy();
    absent.processes.pop();
    expect(checkRelaySoak(absent).violations).toContain("cleanup");
    const incomplete = copy();
    incomplete.processes[0].after.complete = false;
    expect(checkRelaySoak(incomplete).violations).toContain("cleanup");
    const survivor = copy();
    survivor.processes[0].after.identities.push({ pid: 21, birthId: "new", bootId: "boot-laptop" });
    expect(checkRelaySoak(survivor).violations).toContain("cleanup");
    const reusedPid = copy();
    reusedPid.processes[0].after.identities[0].birthId = "different-birth";
    expect(checkRelaySoak(reusedPid).violations).toContain("cleanup");
  });

  it("rejects a surviving run helper even if it appeared in the before census", () => {
    const evidence = copy(), run = evidence.links[0].runs[0], census = evidence.processes.find(item => item.machineId === run.machineId)!;
    census.before.identities.push({ ...run.process });
    census.after.identities.push({ ...run.process });
    expect(checkRelaySoak(evidence).violations).toContain("cleanup");
  });

  it("rejects RSS samples attributed to a different process birth", () => {
    const evidence = copy();
    evidence.links[0].rss[1].process.birthId = "other";
    expect(checkRelaySoak(evidence).violations).toContain("rss");
  });

  it("rejects RSS growth beyond the run allowance and missing samples", () => {
    const growth = copy();
    growth.links[0].rss[10].bytes += ALLOWANCE + 1;
    expect(checkRelaySoak(growth).violations).toContain("rss");
    const gap = copy();
    gap.links[0].rss.splice(10, 2);
    expect(checkRelaySoak(gap).violations).toContain("rss");
  });

  it("rejects missing status samples and changed run-file allowances", () => {
    const gap = copy();
    gap.links[0].states.splice(10, 2);
    expect(checkRelaySoak(gap).violations).toContain("timeline");
    const changed = copy();
    changed.links[0].runs[1].rssAllowanceBytes++;
    expect(checkRelaySoak(changed).violations).toContain("run-file");
  });

  it("fails closed on malformed evidence instead of reporting a pass", () => {
    expect(checkRelaySoak({} as RelaySoakEvidence).ok).toBe(false);
    expect(checkRelaySoak(null as unknown as RelaySoakEvidence).ok).toBe(false);
  });
});

function recordManifest(evidence: Evidence) {
  const files = new Map<string, string>();
  const links = evidence.links.map(link => {
    const linkId = link.id;
    const records = [
      ...link.runs.map(run => ({ type: "run", linkId, ...run })),
      ...link.submissions.map(item => ({ type: "submission", linkId, ...item })),
      ...link.handoffs.map(item => ({ type: "handoff", linkId, ...item })),
      ...link.receipts.map(item => ({ type: "receipt", linkId, ...item })),
      ...link.outcomes.map(item => ({ type: "outcome", linkId, ...item })),
      ...link.states.map(item => ({ type: "state", linkId, ...item })),
      { type: "relay-state", linkId, atMs: START, state: "connecting" },
      ...link.rss.map(item => ({ type: "rss", linkId, ...item })),
      ...link.calls.flatMap(call => [
        { type: "poll-start", linkId, atMs: call.startMs, holdMs: call.holdMs, pollId: call.pollId, wireLinkId: "wire", process: call.process },
        ...(call.endMs === null ? [] : [{ type: "poll-end", linkId, atMs: call.endMs, holdMs: call.holdMs, pollId: call.pollId, wireLinkId: "wire", process: call.process }]),
      ]),
    ];
    files.set(`${linkId}.ndjson`, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    return { id: link.id, topology: link.topology, relayId: link.relayId, peerId: link.peerId, clock: link.clock, recordFiles: [`${linkId}.ndjson`] };
  });
  return { manifest: { startMs: evidence.startMs, endMs: evidence.endMs, rssAllowanceBytes: evidence.rssAllowanceBytes,
    links, faults: evidence.faults, processes: evidence.processes }, files };
}

describe("the packaged soak entry", () => {
  it("builds an opt-in relay-soak.mjs without emptying the other roam outputs", async () => {
    const configModule = await import(pathToFileURL(resolve("vite.roam.config.mjs")).href);
    const config = configModule.default({ command: "build", mode: "relay-soak" });
    expect(config.build).toMatchObject({ ssr: "packages/roam/src/relocate/relay-soak.ts", outDir: "dist/roam", emptyOutDir: false,
      rollupOptions: { output: { entryFileNames: "relay-soak.mjs" } } });
  });
});

describe("offline evidence assembly", () => {
  it("assembles the emitted records into a complete passing evidence file", () => {
    const { manifest, files } = recordManifest(baseline);
    const evidence = assembleRelaySoak(manifest, name => files.get(name)!);
    expect(checkRelaySoak(evidence)).toEqual({ ok: true, violations: [] });
  });

  it("rejects truncated or unrecognized records instead of treating them as evidence", () => {
    const { manifest, files } = recordManifest(baseline);
    const first = manifest.links[0].recordFiles[0];
    files.set(first, files.get(first)!.slice(0, -1));
    expect(() => assembleRelaySoak(manifest, name => files.get(name)!)).toThrow();
    const good = recordManifest(baseline);
    good.files.set(first, good.files.get(first)! + JSON.stringify({ type: "unknown", linkId: manifest.links[0].id }) + "\n");
    expect(() => assembleRelaySoak(good.manifest, name => good.files.get(name)!)).toThrow();
  });

  it("returns zero only for a complete passing check and never contacts a machine", async () => {
    const output: string[] = [], errors: string[] = [];
    const files = new Map([["/complete.json", JSON.stringify(baseline)], ["/incomplete.json", "{}"]]);
    const io = { out: (value: string) => output.push(value), err: (value: string) => errors.push(value) };
    const deps = { readText: (path: string) => { const data = files.get(path); if (!data) throw new Error("missing"); return data; } };
    expect(await relaySoakMain(["check", "/complete.json"], io, deps)).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toEqual({ ok: true, violations: [] });
    expect(await relaySoakMain(["check", "/incomplete.json"], io, deps)).not.toBe(0);
    expect(JSON.parse(output.at(-1)!).ok).toBe(false);
    expect(errors).toEqual([]);
  });
});

const RELAY = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const fixturePeer: Peer = { machineId: PEER, alias: "peer.invalid", node: "/node", pi: "/pi", cli: "/spider", core: "/core", globalRoot: "/root", agentDir: "/agent" };
const fixtureLink = { id: "test-link", topology: "laptop-to-box" as const, relayId: RELAY, peerId: PEER,
  from: { machineId: PEER, address: { sessionId: "sender", scopeId: "scope" }, name: "origin", homeEpoch: 1, endpointEpoch: "epoch" },
  target: { machineId: RELAY, selector: { by: "name" as const, value: "sink" }, homeEpoch: 1 } };
const fixtureProcess = { pid: 123, birthId: "start-123", bootId: "boot-123" };
const realClock: Clock = { now: () => Date.now(), later(ms, fn) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
const reply = (poll: RelayPoll, submissions: readonly RelaySubmit[] = []): Buffer => encodeRelayPollReply({
  ready: { type: "ready", version: 1, machineId: PEER, linkId: poll.hello.linkId, pollId: poll.hello.pollId, ok: true }, submissions,
});

describe("the opt-in soak drivers", () => {
  afterEach(() => vi.useRealTimers());

  it("uses the production held poll and hold-0 result path with a separate sink receipt", async () => {
    const controller = new AbortController(), records: RelaySoakRecord[] = [], polls: RelayPoll[] = [];
    const submit: RelaySubmit = { type: "submit", kind: "send", from: fixtureLink.from, target: fixtureLink.target,
      message: { id: "sink-message", timestamp: 1, text: "relay-soak" } };
    let reportResult!: () => void;
    const resultSeen = new Promise<void>(resolve => { reportResult = resolve; });
    let held = 0;
    const transport = {
      async resolve(peer: Peer) { return peer; },
      async exec(_peer: Peer, argv: readonly string[], options: { stdin?: Buffer; signal?: AbortSignal }) {
        const poll = decodeRelayPoll(options.stdin!, Number(argv.at(-1)) as 0 | 20000);
        polls.push(poll);
        if (poll.holdMs === 20_000 && held++ === 0) return reply(poll, [submit]);
        if (poll.holdMs === 0) { reportResult(); return reply(poll); }
        return new Promise<Buffer>((_resolve, reject) => {
          if (options.signal?.aborted) reject(new Error("aborted"));
          else options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const run = runRelaySoakDial({ link: fixtureLink, relay: { machineId: RELAY, alias: "relay.invalid" }, peer: fixturePeer,
      transport, clock: realClock, signal: controller.signal, startMs: START, endMs: END, rssAllowanceBytes: ALLOWANCE,
      process: fixtureProcess, emit: event => records.push(event), rssBytes: () => 100_000_000 });
    await resultSeen;
    controller.abort();
    await run;
    const resultPoll = polls.find(poll => poll.holdMs === 0)!;
    expect(resultPoll.results).toMatchObject([{ messageId: "sink-message", attempted: true, outcome: { kind: "socket_delivered", id: "sink-message" } }]);
    expect(records.filter(event => event.type === "handoff")).toMatchObject([{ id: "sink-message" }]);
    expect(records.filter(event => event.type === "receipt")).toMatchObject([{ id: "sink-message" }]);
    expect(records.filter(event => event.type === "poll-start").map(event => event.holdMs)).toEqual(expect.arrayContaining([0, 20_000]));
    expect(JSON.stringify(records)).not.toContain("relay-soak");
  });

  it("refuses a non-fixture message instead of recording a sink receipt", async () => {
    const controller = new AbortController(), records: RelaySoakRecord[] = [], polls: RelayPoll[] = [];
    const foreign: RelaySubmit = { type: "submit", kind: "send", from: fixtureLink.from, target: fixtureLink.target,
      message: { id: "foreign", timestamp: 1, text: "do-not-deliver-or-log" } };
    let completed!: () => void;
    const resultSeen = new Promise<void>(resolve => { completed = resolve; });
    let held = 0;
    const transport = {
      async resolve(peer: Peer) { return peer; },
      async exec(_peer: Peer, argv: readonly string[], options: { stdin?: Buffer; signal?: AbortSignal }) {
        const poll = decodeRelayPoll(options.stdin!, Number(argv.at(-1)) as 0 | 20000);
        polls.push(poll);
        if (poll.holdMs === 20_000 && held++ === 0) return reply(poll, [foreign]);
        if (poll.holdMs === 0) { completed(); return reply(poll); }
        return new Promise<Buffer>((_resolve, reject) => {
          if (options.signal?.aborted) reject(new Error("aborted"));
          else options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const run = runRelaySoakDial({ link: fixtureLink, relay: { machineId: RELAY, alias: "relay.invalid" }, peer: fixturePeer,
      transport, clock: realClock, signal: controller.signal, startMs: START, endMs: END, rssAllowanceBytes: ALLOWANCE,
      process: fixtureProcess, emit: event => records.push(event), rssBytes: () => 100_000_000 });
    await resultSeen;
    controller.abort();
    await run;
    expect(polls.find(poll => poll.holdMs === 0)!.results).toMatchObject([
      { messageId: "foreign", attempted: false, outcome: { kind: "refused", code: "unauthorized" } },
    ]);
    expect(records.filter(event => event.type === "receipt")).toEqual([]);
    expect(JSON.stringify(records)).not.toContain("do-not-deliver-or-log");
  });

  it("submits every five seconds and records refusals and failures without replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START - 1000);
    const controller = new AbortController(), records: RelaySoakRecord[] = [], sent: RelaySubmit[] = [];
    let next = 0;
    const run = runRelaySoakSubmit({ link: fixtureLink, clock: realClock, signal: controller.signal,
      startMs: START, endMs: END, rssAllowanceBytes: ALLOWANCE, process: fixtureProcess,
      emit: event => records.push(event), nextId: () => `cadence-${next++}`,
      submit: async (_relayId, message) => {
        sent.push(message);
        if (message.message.id === "cadence-2") throw new Error("do-not-log-this-error");
        return message.message.id === "cadence-1"
          ? { type: "result", messageId: message.message.id, attempted: false, outcome: { kind: "refused", code: "relay-busy" } }
          : { type: "result", messageId: message.message.id, attempted: true, outcome: { kind: "socket_delivered", id: message.message.id } };
      },
      list: async () => [{ relay: { machineId: RELAY, alias: "relay.invalid" }, reach: [], linkId: "wire", state: "up", sinceMs: START,
        lastCallMs: START, lastError: null, messagesCarried: 0 }],
    });
    await vi.advanceTimersByTimeAsync(12_000);
    controller.abort();
    await run;
    expect(sent.map(message => message.message.id)).toEqual(["cadence-0", "cadence-1", "cadence-2"]);
    expect(records.filter(event => event.type === "submission").map(event => event.scheduledMs)).toEqual([START, START + 5000, START + 10_000]);
    expect(records.filter(event => event.type === "outcome")).toMatchObject([
      { id: "cadence-0", kind: "socket_delivered" }, { id: "cadence-1", kind: "refused" },
    ]);
    expect(records.filter(event => event.type === "submission-error")).toMatchObject([{ id: "cadence-2" }]);
    expect(records.some(event => event.type === "state" && event.state === "up")).toBe(true);
    expect(JSON.stringify(records)).not.toContain("do-not-log-this-error");
  });

  it("dials only the configured sendTo peer through the production carrier", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START - 1000);
    const controller = new AbortController(), output: string[] = [], errors: string[] = [];
    const config = { machineId: RELAY, intercom: { machineAlias: "relay.invalid" } } as unknown as RoamConfig;
    const routes: V0Routes = { version: 2, agentDir: "/agent", sendTo: [fixturePeer], acceptFrom: [], relays: [RELAY], linkTo: [PEER] };
    const file = JSON.stringify({ root: "/fixture", startMs: START, rssAllowanceBytes: ALLOWANCE, links: [fixtureLink] });
    let opened!: (peer: Peer) => void;
    const connected = new Promise<Peer>(resolve => { opened = resolve; });
    const transport = {
      async resolve(peer: Peer) { opened(peer); return peer; },
      async exec(_peer: Peer, _argv: readonly string[], options: { signal?: AbortSignal }) {
        return new Promise<Buffer>((_resolve, reject) => {
          if (options.signal?.aborted) reject(new Error("aborted"));
          else options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const io = { out: (value: string) => output.push(value), err: (value: string) => errors.push(value) };
    const deps = { readText: () => file, readIdentity: () => config, readRoutes: () => routes,
      createTransport: () => transport, processIdentity: async () => fixtureProcess, clock: realClock,
      signal: controller.signal, rssBytes: () => 100_000_000 };
    const run = relaySoakMain(["dial", "/run.json", fixtureLink.id], io, deps);
    expect(await Promise.race([connected, run.then(code => { throw new Error(`dial exited ${code}`); })])).toEqual(fixturePeer);
    controller.abort();
    expect(await run).toBe(0);
    expect(output.map(line => JSON.parse(line)).some(record => record.type === "run" && record.machineId === RELAY)).toBe(true);
    expect(errors).toEqual([]);
    const missing = { ...deps, readRoutes: () => ({ ...routes, sendTo: [] }), signal: new AbortController().signal };
    expect(await relaySoakMain(["dial", "/run.json", fixtureLink.id], io, missing)).not.toBe(0);
  });

  it("submits the burst through the private-broker adapter with the configured live origin", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START + MINUTE);
    const output: string[] = [], sent: RelaySubmit[] = [];
    const config = { machineId: PEER, intercom: { machineAlias: "peer.invalid" } } as unknown as RoamConfig;
    const routes: V0Routes = { version: 2, agentDir: "/agent", sendTo: [], acceptFrom: [], relays: [RELAY], linkTo: [] };
    const deps = { readText: () => JSON.stringify({ root: "/fixture", startMs: START, rssAllowanceBytes: ALLOWANCE, links: [fixtureLink] }),
      readIdentity: () => config, readRoutes: () => routes, processIdentity: async () => fixtureProcess, clock: realClock,
      signal: new AbortController().signal,
      submitRelay: async (agentDir: string, relayId: string, submit: RelaySubmit) => {
        expect([agentDir, relayId]).toEqual(["/agent", RELAY]);
        sent.push(submit);
        return { type: "result" as const, messageId: submit.message.id, attempted: false as const,
          outcome: { kind: "refused" as const, code: "relay-busy" as const } };
      },
    };
    const io = { out: (value: string) => output.push(value), err: () => {} };
    expect(await relaySoakMain(["submit", "/run.json", fixtureLink.id, "--burst"], io, deps)).toBe(0);
    expect(sent).toHaveLength(100);
    expect(sent.every(item => item.from.machineId === PEER && item.target.machineId === RELAY)).toBe(true);
    expect(new Set(sent.map(item => item.message.id)).size).toBe(100);
    expect(output.map(line => JSON.parse(line)).filter(record => record.type === "outcome")).toHaveLength(100);
    expect(output.join("")).not.toContain("relay-soak");
  });

  it("starts exactly 100 distinct extra submissions before any burst result settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START + MINUTE);
    const controller = new AbortController(), records: RelaySoakRecord[] = [], releases: Array<() => void> = [];
    let next = 0;
    const run = runRelaySoakBurst({ link: fixtureLink, clock: realClock, signal: controller.signal,
      startMs: START, endMs: END, rssAllowanceBytes: ALLOWANCE, process: fixtureProcess,
      emit: event => records.push(event), nextId: () => `burst-id-${next++}`,
      submit: (_relayId, message) => new Promise<RelayResult>(resolve => releases.push(() => resolve({
        type: "result", messageId: message.message.id, attempted: false, outcome: { kind: "refused", code: "relay-busy" },
      }))),
    });
    expect(releases).toHaveLength(100);
    const submissions = records.filter(event => event.type === "submission");
    expect(submissions).toHaveLength(100);
    expect(new Set(submissions.map(event => event.id)).size).toBe(100);
    expect(records.filter(event => event.type === "outcome")).toHaveLength(0);
    for (const release of releases) release();
    await run;
    expect(records.filter(event => event.type === "outcome")).toHaveLength(100);
    expect(records.filter(event => event.type === "outcome").every(event => event.kind === "refused")).toBe(true);
  });
});
