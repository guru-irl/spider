import { V0_INTERCOM_MS } from "@spider/intercom/roam-v0";

const SOAK_MS = 8 * 60 * 60 * 1000;
const CADENCE_MS = 5000;
const STATUS_GAP_MS = 10_000;
const RSS_GAP_MS = 60_000;
const CLOCK_GAP_MS = 10 * 60_000;

type SoakTopology = "laptop-to-box" | "box-to-box";
type SoakFaultKind = "relay-kill" | "herdr-restart-relay" | "herdr-restart-peer" | "route-cut" | "laptop-sleep" | "endpoint-kill";
type SoakOutcome = "socket_delivered" | "refused" | "unknown";
type SoakState = "up" | "connecting" | "down" | "unavailable";

interface BirthIdentity { pid: number; birthId: string; bootId: string }
interface ObservedProcess extends BirthIdentity { machineId: string; observedMs: number }
interface ClockSample { sentMs: number; remoteMs: number; receivedMs: number }
interface SoakClock {
  /** Bounds on relay clock minus submitting peer clock, valid for the whole run. */
  fromMs: number; toMs: number; minOffsetMs: number; maxOffsetMs: number;
  samples: readonly ClockSample[];
}
interface SoakRun { role: "dial" | "submit"; startMs: number; endMs: number; rssAllowanceBytes: number; machineId: string; process: BirthIdentity }
interface SoakSubmission { id: string; atMs: number; deadlineMs: number; kind: "cadence" | "burst"; scheduledMs?: number; burstId?: string }
interface SoakEvent { id: string; atMs: number }
interface SoakOutcomeEvent extends SoakEvent { kind: SoakOutcome }
interface SoakStateEvent { atMs: number; state: SoakState }
interface SoakCall { pollId: string; holdMs: 0 | 20000; startMs: number; endMs: number }
interface SoakRss { atMs: number; bytes: number; process: BirthIdentity }
interface Census { atMs: number; complete: boolean; identities: readonly BirthIdentity[] }
interface SoakProcessCensus { machineId: string; before: Census; after: Census }

export interface RelaySoakLinkEvidence {
  id: string; topology: SoakTopology; relayId: string; peerId: string;
  runs: readonly SoakRun[]; clock: SoakClock;
  submissions: readonly SoakSubmission[]; handoffs: readonly SoakEvent[];
  outcomes: readonly SoakOutcomeEvent[]; receipts: readonly SoakEvent[];
  states: readonly SoakStateEvent[]; calls: readonly SoakCall[]; rss: readonly SoakRss[];
}
export interface RelaySoakFault {
  kind: SoakFaultKind; linkIds: readonly string[]; startMs: number; clearMs: number;
  process?: ObservedProcess;
  endpoint?: ObservedProcess & { pollId: string };
}
export interface RelaySoakEvidence {
  startMs: number; endMs: number; rssAllowanceBytes: number;
  links: readonly RelaySoakLinkEvidence[]; faults: readonly RelaySoakFault[];
  processes: readonly SoakProcessCensus[];
}

const faultKinds: readonly SoakFaultKind[] = ["relay-kill", "herdr-restart-relay", "herdr-restart-peer", "route-cut", "laptop-sleep", "endpoint-kill"];
const states: readonly SoakState[] = ["up", "connecting", "down", "unavailable"];
const outcomes: readonly SoakOutcome[] = ["socket_delivered", "refused", "unknown"];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const time = (value: unknown): value is number => integer(value) && value >= 0;
const entries = (value: unknown, check: (entry: unknown) => boolean): boolean => Array.isArray(value) && value.every(check);
const identity = (value: unknown): boolean => object(value) && time(value.pid) && value.pid > 0 && text(value.birthId) && text(value.bootId);
const observed = (value: unknown): boolean => identity(value) && object(value) && text(value.machineId) && time(value.observedMs);
const event = (value: unknown): boolean => object(value) && text(value.id) && time(value.atMs);
const census = (value: unknown): boolean => object(value) && time(value.atMs) && typeof value.complete === "boolean" && entries(value.identities, identity);

/** Validate external evidence once before the checker uses its typed records. */
function isEvidence(value: unknown): value is RelaySoakEvidence {
  if (!object(value) || !time(value.startMs) || !time(value.endMs) || !time(value.rssAllowanceBytes)) return false;
  if (!entries(value.links, link => {
    if (!object(link) || !text(link.id) || !text(link.relayId) || !text(link.peerId) ||
        link.topology !== "laptop-to-box" && link.topology !== "box-to-box" || !object(link.clock)) return false;
    const clock = link.clock;
    return time(clock.fromMs) && time(clock.toMs) && integer(clock.minOffsetMs) && integer(clock.maxOffsetMs) &&
      entries(clock.samples, sample => object(sample) && time(sample.sentMs) && time(sample.remoteMs) && time(sample.receivedMs)) &&
      entries(link.runs, run => object(run) && (run.role === "dial" || run.role === "submit") && time(run.startMs) && time(run.endMs) && time(run.rssAllowanceBytes) && text(run.machineId) && identity(run.process)) &&
      entries(link.submissions, submit => event(submit) && object(submit) && time(submit.deadlineMs) &&
        (submit.kind === "cadence" && time(submit.scheduledMs) || submit.kind === "burst" && text(submit.burstId))) &&
      entries(link.handoffs, event) && entries(link.receipts, event) &&
      entries(link.outcomes, result => event(result) && object(result) && outcomes.includes(result.kind as SoakOutcome)) &&
      entries(link.states, state => object(state) && time(state.atMs) && states.includes(state.state as SoakState)) &&
      entries(link.calls, call => object(call) && text(call.pollId) && (call.holdMs === 0 || call.holdMs === 20_000) && time(call.startMs) && time(call.endMs)) &&
      entries(link.rss, sample => object(sample) && time(sample.atMs) && time(sample.bytes) && sample.bytes > 0 && identity(sample.process));
  })) return false;
  if (!entries(value.faults, fault => object(fault) && faultKinds.includes(fault.kind as SoakFaultKind) &&
      entries(fault.linkIds, text) && time(fault.startMs) && time(fault.clearMs) &&
      (fault.process === undefined || observed(fault.process)) &&
      (fault.endpoint === undefined || observed(fault.endpoint) && object(fault.endpoint) && text(fault.endpoint.pollId)))) return false;
  return entries(value.processes, item => object(item) && text(item.machineId) && census(item.before) && census(item.after));
}

function covers<T>(items: readonly T[], timestamp: (item: T) => number, startMs: number, endMs: number, gapMs: number): boolean {
  const times = items.map(timestamp).sort((a, b) => a - b);
  if (!times.length || times[0] > startMs || times[times.length - 1] < endMs) return false;
  const first = times.findLastIndex(value => value <= startMs);
  let previous = times[first];
  for (let i = first + 1; i < times.length && previous < endMs; i++) {
    if (times[i] - previous > gapMs) return false;
    previous = times[i];
  }
  return previous >= endMs;
}

function validClock(clock: SoakClock, startMs: number, endMs: number): boolean {
  if (clock.fromMs > startMs || clock.toMs < endMs + V0_INTERCOM_MS || clock.minOffsetMs > clock.maxOffsetMs ||
      !covers(clock.samples, sample => sample.sentMs, startMs, endMs, CLOCK_GAP_MS)) return false;
  return clock.samples.every(sample => sample.sentMs <= sample.receivedMs &&
    clock.minOffsetMs <= sample.remoteMs - sample.receivedMs && clock.maxOffsetMs >= sample.remoteMs - sample.sentMs);
}

function lastStateAt(sorted: readonly SoakStateEvent[], atMs: number): SoakState | undefined {
  let low = 0, high = sorted.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sorted[middle].atMs <= atMs) low = middle + 1;
    else high = middle;
  }
  return low ? sorted[low - 1].state : undefined;
}

function keyed<T extends { id: string }>(events: readonly T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of events) {
    const group = result.get(item.id);
    if (group) group.push(item);
    else result.set(item.id, [item]);
  }
  return result;
}

function birthKey(item: BirthIdentity): string { return JSON.stringify([item.pid, item.birthId, item.bootId]); }

/** Check the operator's complete evidence. No live machines are contacted. */
export function checkRelaySoak(evidence: RelaySoakEvidence): { ok: boolean; violations: readonly string[] } {
  if (!isEvidence(evidence)) return { ok: false, violations: ["evidence"] };
  const violations = new Set<string>();
  const fail = (code: string) => { violations.add(code); };
  const { startMs, endMs, links, faults, processes, rssAllowanceBytes } = evidence;
  const linkIds = new Set(links.map(link => link.id));
  const pairs = new Set(links.map(link => JSON.stringify([link.relayId, link.peerId])));
  if (endMs - startMs !== SOAK_MS || links.length !== 3 || linkIds.size !== links.length || pairs.size !== links.length ||
      links.filter(link => link.topology === "laptop-to-box").length !== 1 ||
      links.filter(link => link.topology === "box-to-box").length !== 2 || links.some(link => link.peerId === link.relayId)) fail("timeline");

  const allIds = new Set<string>();
  const burst: SoakSubmission[] = [];
  for (const fault of faults) {
    if (!fault.linkIds.length || new Set(fault.linkIds).size !== fault.linkIds.length || fault.linkIds.some(id => !linkIds.has(id)) ||
        fault.startMs < startMs || fault.clearMs > endMs || fault.clearMs < fault.startMs ||
        fault.kind === "route-cut" && fault.clearMs - fault.startMs < 60_000) fail("faults");
    if (fault.kind === "relay-kill" || fault.kind === "herdr-restart-relay" || fault.kind === "herdr-restart-peer") {
      const process = fault.process;
      if (!process || fault.startMs - process.observedMs < 0 || fault.startMs - process.observedMs > 5000 ||
          !fault.linkIds.every(id => {
            const link = links.find(item => item.id === id);
            return link && process.machineId === (fault.kind === "herdr-restart-peer" ? link.peerId : link.relayId);
          })) fail("faults");
    }
  }
  for (const kind of faultKinds) if (!faults.some(fault => fault.kind === kind)) fail("faults");

  for (const link of links) {
    const linkFaults = faults.filter(fault => fault.linkIds.includes(link.id));
    const clock = link.clock;
    if (!validClock(clock, startMs, endMs)) fail("clock");
    if (!link.runs.some(run => run.role === "dial") || !link.runs.some(run => run.role === "submit") ||
        link.runs.some(run => run.startMs !== startMs || run.endMs !== endMs || run.rssAllowanceBytes !== rssAllowanceBytes ||
          run.machineId !== (run.role === "dial" ? link.relayId : link.peerId))) fail("run-file");
    const samples = [...link.states].sort((a, b) => a.atMs - b.atMs);
    if (!covers(samples, sample => sample.atMs, startMs, endMs, STATUS_GAP_MS)) fail("timeline");
    for (const fault of linkFaults) {
      if (!samples.some(sample => sample.state !== "up" && sample.atMs >= fault.startMs && sample.atMs <= fault.startMs + 30_000)) fail("stall-detection");
      if (!samples.some(sample => sample.state === "up" && sample.atMs >= fault.clearMs && sample.atMs <= fault.clearMs + 60_000)) fail("recovery");
      if (fault.kind === "endpoint-kill") {
        const endpoint = fault.endpoint;
        if (fault.linkIds.length !== 1 || !endpoint || endpoint.machineId !== link.peerId || endpoint.observedMs > fault.startMs ||
            fault.startMs - endpoint.observedMs > 5000 || !link.calls.some(call => call.pollId === endpoint.pollId && call.holdMs === 20_000 &&
              call.startMs - clock.minOffsetMs <= endpoint.observedMs && call.endMs - clock.maxOffsetMs >= fault.startMs)) fail("endpoint");
      }
    }
    const rss = [...link.rss].sort((a, b) => a.atMs - b.atMs);
    const rssStart = startMs + clock.minOffsetMs, rssEnd = endMs + clock.maxOffsetMs;
    const dialBirths = new Set(link.runs.filter(run => run.role === "dial").map(run => birthKey(run.process)));
    if (!covers(rss, sample => sample.atMs, rssStart, rssEnd, RSS_GAP_MS) ||
        rss.some(sample => !dialBirths.has(birthKey(sample.process)))) fail("rss");
    const baseline = rss.findLast(sample => sample.atMs <= rssStart);
    if (!baseline || rss.some(sample => sample.atMs >= baseline.atMs && sample.atMs <= rssEnd && sample.bytes > baseline.bytes + rssAllowanceBytes)) fail("rss");

    const cadence = link.submissions.filter(submit => submit.kind === "cadence").sort((a, b) => a.scheduledMs! - b.scheduledMs!);
    if (cadence.length !== SOAK_MS / CADENCE_MS || cadence.some((submit, index) => submit.scheduledMs !== startMs + index * CADENCE_MS ||
        submit.atMs < submit.scheduledMs! || submit.atMs >= submit.scheduledMs! + CADENCE_MS)) fail("timeline");
    burst.push(...link.submissions.filter(submit => submit.kind === "burst"));
    const byId = keyed(link.submissions), handoffs = keyed(link.handoffs), receipts = keyed(link.receipts), results = keyed(link.outcomes);
    for (const submit of link.submissions) {
      if (allIds.has(submit.id) || (byId.get(submit.id)?.length ?? 0) !== 1 || submit.deadlineMs !== submit.atMs + V0_INTERCOM_MS) fail("timeline");
      allIds.add(submit.id);
    }
    for (const group of [handoffs, receipts, results]) for (const id of group.keys()) if (!byId.has(id)) fail("timeline");
    let healthy = 0, fast = 0;
    for (const submit of link.submissions) {
      const handed = handoffs.get(submit.id) ?? [], received = receipts.get(submit.id) ?? [], settled = results.get(submit.id) ?? [];
      if (received.length > 1) fail("duplicate-receipt");
      if (handed.length > 1) fail("handoff");
      if (settled.length !== 1 || settled.some(result => result.atMs < submit.atMs || result.atMs > submit.deadlineMs)) fail("outcome");
      const outcome = settled[0];
      if (outcome?.kind === "unknown" && !linkFaults.some(fault => fault.startMs >= submit.atMs && fault.startMs <= outcome.atMs)) fail("unknown-outside-fault");
      if (outcome?.kind === "socket_delivered" && (received.length !== 1 || handed.length !== 1) ||
          outcome?.kind === "refused" && received.length !== 0 || received.length > 0 && handed.length !== 1) fail("receipt");
      if (received.length && handed.length && (received[0].atMs < handed[0].atMs ||
          outcome?.kind === "socket_delivered" && outcome.atMs < received[0].atMs - clock.maxOffsetMs)) fail("receipt");
      if (handed.length === 1) {
        const earliest = handed[0].atMs - clock.maxOffsetMs, latest = handed[0].atMs - clock.minOffsetMs;
        if (latest < submit.atMs || earliest > submit.deadlineMs) fail("handoff");
        if (lastStateAt(samples, submit.atMs) === "up" &&
            !linkFaults.some(fault => fault.startMs <= latest && fault.clearMs >= submit.atMs)) {
          healthy++;
          if (latest - submit.atMs < 2000) fast++;
        }
      }
    }
    if (!healthy || fast * 100 < healthy * 99) fail("handoff");
  }
  if (burst.length !== 100 || new Set(burst.map(submit => submit.burstId)).size !== 1 ||
      new Set(links.filter(link => link.submissions.some(submit => submit.kind === "burst")).map(link => link.id)).size !== 1 ||
      burst.some(submit => submit.atMs < startMs || submit.atMs >= endMs) ||
      burst.length > 0 && Math.max(...burst.map(submit => submit.atMs)) - Math.min(...burst.map(submit => submit.atMs)) > 1000) fail("burst");

  const machines = new Set(links.flatMap(link => [link.relayId, link.peerId]));
  if (processes.length !== machines.size || new Set(processes.map(item => item.machineId)).size !== processes.length) fail("cleanup");
  for (const machineId of machines) {
    const process = processes.find(item => item.machineId === machineId);
    if (!process || !process.before.complete || !process.after.complete || process.before.atMs > startMs || process.after.atMs < endMs) {
      fail("cleanup");
      continue;
    }
    const before = new Set(process.before.identities.map(birthKey));
    const owned = new Set(links.flatMap(link => link.runs.filter(run => run.machineId === machineId).map(run => birthKey(run.process))));
    if (before.size !== process.before.identities.length || new Set(process.after.identities.map(birthKey)).size !== process.after.identities.length ||
        process.after.identities.some(item => !before.has(birthKey(item)) || owned.has(birthKey(item)))) fail("cleanup");
  }
  return { ok: violations.size === 0, violations: [...violations] };
}
