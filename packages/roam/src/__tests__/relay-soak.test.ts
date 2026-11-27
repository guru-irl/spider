import { beforeAll, describe, expect, it } from "vitest";
import { checkRelaySoak, type RelaySoakEvidence, type RelaySoakFault, type RelaySoakLinkEvidence } from "../relocate/relay-soak";

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
    { kind: "relay-kill", linkIds: [links[0].id], startMs: START + 60 * MINUTE, clearMs: START + 60 * MINUTE + 40_000,
      process: { machineId: machines[0], pid: 80, birthId: "800", bootId: "boot-a", observedMs: START + 60 * MINUTE } },
    { kind: "herdr-restart-relay", linkIds: [links[0].id], startMs: START + 90 * MINUTE, clearMs: START + 90 * MINUTE + 40_000,
      process: { machineId: machines[0], pid: 81, birthId: "810", bootId: "boot-a", observedMs: START + 90 * MINUTE } },
    { kind: "herdr-restart-peer", linkIds: [links[1].id], startMs: START + 120 * MINUTE, clearMs: START + 120 * MINUTE + 40_000,
      process: { machineId: machines[2], pid: 82, birthId: "820", bootId: "boot-b", observedMs: START + 120 * MINUTE } },
    { kind: "route-cut", linkIds: [links[1].id], startMs: START + 180 * MINUTE, clearMs: START + 181 * MINUTE },
    { kind: "laptop-sleep", linkIds: [links[0].id], startMs: START + 240 * MINUTE, clearMs: START + 240 * MINUTE + 40_000 },
    { kind: "endpoint-kill", linkIds: [links[2].id], startMs: START + 300 * MINUTE, clearMs: START + 300 * MINUTE + 40_000,
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
    for (let atMs = START; atMs <= END; atMs += 30_000) link.rss.push({ atMs, bytes: 100_000_000, process: { ...link.runs[0].process } });
  }
  const burstAt = START + 30 * MINUTE;
  for (let i = 0; i < 100; i++) {
    const id = `burst-${i}`;
    links[0].submissions.push({ id, atMs: burstAt, deadlineMs: burstAt + 20_000, kind: "burst", burstId: "burst-1" });
    // The broker can refuse overflow. Those submissions still need outcomes.
    links[0].outcomes.push({ id, atMs: burstAt + 200, kind: "refused" });
  }
  const endpoint = faults.find(fault => fault.kind === "endpoint-kill")!;
  links[2].calls.push({ pollId: "held-1", holdMs: 20_000, startMs: endpoint.startMs - 1000, endMs: endpoint.startMs + 1000 });
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
    wrongCall.links[2].calls[0].endMs = faultOf(wrongCall, "endpoint-kill").startMs - 1;
    expect(checkRelaySoak(wrongCall).violations).toContain("endpoint");
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
