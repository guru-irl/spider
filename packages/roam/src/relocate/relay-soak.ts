import { randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processStartIdentity } from "@spider/herdr/jobs/handoff";
import { localBootId } from "@spider/herdr/sessions/id-lock";
import { listV0RelayLinks, submitV0Relay } from "@spider/intercom/broker/roam-relay-client";
import { requestV0Broker } from "@spider/intercom/broker/roam-v0-client";
import { V0_INTERCOM_MS, type V0BrokerOp, type V0Reply } from "@spider/intercom/roam-v0";
import { decodeRelayPoll, isRelayResult, isRelaySubmit, type RelayLinkView, type RelayPeer, type RelayResult, type RelaySubmit } from "@spider/intercom/relay-protocol";
import type { Clock, Peer, RoamConfig, Transport } from "../contracts";
import { readLocalIdentity } from "../runtime";
import { createTransport as createRoamTransport } from "../transport";
import { isV0Alias, readV0Routes, type V0Routes } from "./intercom-routes";
import { localHerdrConnection } from "./local";
import { runRelayPollLoop } from "./relay-poll";

const SOAK_MS = 8 * 60 * 60 * 1000;
const CADENCE_MS = 5000;
const STATUS_GAP_MS = 10_000;
const RSS_GAP_MS = 60_000;
const CLOCK_GAP_MS = 10 * 60_000;
// The uninstrumented driver timestamps after the client's budget timer has settled.
const OUTCOME_RECORDING_TOLERANCE_MS = 25;

type SoakTopology = "laptop-to-box" | "box-to-box";
type SoakFaultKind = "relay-kill" | "herdr-restart-relay" | "herdr-restart-peer" | "route-cut" | "laptop-sleep" | "endpoint-kill";
type SoakOutcome = "socket_delivered" | "refused" | "unknown";
type SoakState = "up" | "connecting" | "down" | "unavailable";

interface BirthIdentity { pid: number; birthId: string; bootId: string }
interface ObservedProcess extends BirthIdentity { machineId: string; observedMs: number }
/** sentMs and receivedMs are on the relay; remoteMs is the linked peer's clock. */
interface ClockSample { sentMs: number; remoteMs: number; receivedMs: number }
interface SoakClock {
  /** Bounds on relay clock minus submitting peer clock, valid for the whole run. */
  fromMs: number; toMs: number; minOffsetMs: number; maxOffsetMs: number; maxDriftMs: number;
  samples: readonly ClockSample[];
}
interface SoakRun { role: "dial" | "submit"; startMs: number; endMs: number; rssAllowanceBytes: number; machineId: string; process: BirthIdentity }
interface SoakSubmission { id: string; atMs: number; deadlineMs: number; kind: "cadence" | "burst"; scheduledMs?: number; burstId?: string }
interface SoakEvent { id: string; atMs: number }
interface SoakOutcomeEvent extends SoakEvent { kind: SoakOutcome; clientDeadlineMs?: number }
interface SoakStateEvent { atMs: number; sinceMs: number; state: SoakState }
interface SoakCall { pollId: string; holdMs: 0 | 20000; startMs: number; endMs: number | null; process: BirthIdentity }
interface SoakRss { atMs: number; bytes: number; process: BirthIdentity }
interface Census { atMs: number; complete: boolean; identities: readonly BirthIdentity[] }
interface SoakProcessCensus { machineId: string; before: Census; after: Census }

export interface RelaySoakLinkEvidence {
  id: string; topology: SoakTopology; relayId: string; peerId: string;
  runs: readonly SoakRun[]; clock: SoakClock;
  submissions: readonly SoakSubmission[]; handoffs: readonly SoakEvent[];
  outcomes: readonly SoakOutcomeEvent[]; receipts: readonly SoakEvent[];
  /** Timestamps are on the peer for states and the relay for relayStates. */
  states: readonly SoakStateEvent[]; relayStates: readonly SoakStateEvent[];
  calls: readonly SoakCall[]; rss: readonly SoakRss[];
}
export interface RelaySoakFault {
  kind: SoakFaultKind; clock: "relay" | "peer"; linkIds: readonly string[]; startMs: number; clearMs: number;
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
const stateSample = (value: unknown): boolean => object(value) && time(value.atMs) && time(value.sinceMs) &&
  value.sinceMs <= value.atMs && states.includes(value.state as SoakState);
const census = (value: unknown): boolean => object(value) && time(value.atMs) && typeof value.complete === "boolean" && entries(value.identities, identity);

/** Validate external evidence once before the checker uses its typed records. */
function isEvidence(value: unknown): value is RelaySoakEvidence {
  if (!object(value) || !time(value.startMs) || !time(value.endMs) || !time(value.rssAllowanceBytes)) return false;
  if (!entries(value.links, link => {
    if (!object(link) || !text(link.id) || !text(link.relayId) || !text(link.peerId) ||
        link.topology !== "laptop-to-box" && link.topology !== "box-to-box" || !object(link.clock)) return false;
    const clock = link.clock;
    return time(clock.fromMs) && time(clock.toMs) && integer(clock.minOffsetMs) && integer(clock.maxOffsetMs) && time(clock.maxDriftMs) &&
      entries(clock.samples, sample => object(sample) && time(sample.sentMs) && time(sample.remoteMs) && time(sample.receivedMs)) &&
      entries(link.runs, run => object(run) && (run.role === "dial" || run.role === "submit") && time(run.startMs) && time(run.endMs) && time(run.rssAllowanceBytes) && text(run.machineId) && identity(run.process)) &&
      entries(link.submissions, submit => event(submit) && object(submit) && time(submit.deadlineMs) &&
        (submit.kind === "cadence" && time(submit.scheduledMs) || submit.kind === "burst" && text(submit.burstId))) &&
      entries(link.handoffs, event) && entries(link.receipts, event) &&
      entries(link.outcomes, result => event(result) && object(result) && outcomes.includes(result.kind as SoakOutcome) &&
        (result.clientDeadlineMs === undefined || time(result.clientDeadlineMs))) &&
      entries(link.states, stateSample) && entries(link.relayStates, stateSample) &&
      entries(link.calls, call => object(call) && text(call.pollId) && (call.holdMs === 0 || call.holdMs === 20_000) && time(call.startMs) &&
        (call.endMs === null || time(call.endMs)) && identity(call.process)) &&
      entries(link.rss, sample => object(sample) && time(sample.atMs) && time(sample.bytes) && sample.bytes > 0 && identity(sample.process));
  })) return false;
  if (!entries(value.faults, fault => object(fault) && faultKinds.includes(fault.kind as SoakFaultKind) &&
      (fault.clock === "relay" || fault.clock === "peer") && entries(fault.linkIds, text) && time(fault.startMs) && time(fault.clearMs) &&
      (fault.process === undefined || observed(fault.process)) &&
      (fault.endpoint === undefined || observed(fault.endpoint) && object(fault.endpoint) && text(fault.endpoint.pollId)))) return false;
  return entries(value.processes, item => object(item) && text(item.machineId) && census(item.before) && census(item.after));
}

interface TimeSpan { startMs: number; endMs: number }

function covers<T>(items: readonly T[], timestamp: (item: T) => number, startMs: number, endMs: number, gapMs: number,
  pauses: readonly TimeSpan[] = []): boolean {
  const times = items.map(timestamp).sort((a, b) => a - b);
  if (!times.length || times[0] > startMs || times[times.length - 1] < endMs) return false;
  const first = times.findLastIndex(value => value <= startMs);
  let previous = times[first];
  for (let i = first + 1; i < times.length && previous < endMs; i++) {
    let elapsed = times[i] - previous, cursor = previous;
    // Pauses are sorted by start. The cursor avoids subtracting overlaps twice.
    for (const pause of pauses) {
      const from = Math.max(cursor, pause.startMs), through = Math.min(times[i], pause.endMs);
      if (from >= through) continue;
      elapsed -= through - from;
      cursor = through;
    }
    if (elapsed > gapMs) return false;
    previous = times[i];
  }
  return previous >= endMs;
}

function validClock(clock: SoakClock, startMs: number, endMs: number): boolean {
  if (clock.fromMs > startMs || clock.toMs < endMs + V0_INTERCOM_MS || clock.minOffsetMs > clock.maxOffsetMs ||
      !covers(clock.samples, sample => sample.remoteMs, startMs, endMs, CLOCK_GAP_MS)) return false;
  return clock.samples.every(sample => sample.sentMs <= sample.receivedMs &&
    clock.minOffsetMs <= sample.sentMs - sample.remoteMs - clock.maxDriftMs &&
    clock.maxOffsetMs >= sample.receivedMs - sample.remoteMs + clock.maxDriftMs);
}

function lastStateAt(sorted: readonly SoakStateEvent[], atMs: number): SoakState | undefined {
  let low = 0, high = sorted.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sorted[middle].atMs <= atMs) low = middle + 1;
    else high = middle;
  }
  // A later peer sample can date an already-observed transition before the
  // submission. Unavailable only tells us when the observation itself failed.
  const next = sorted[low];
  if (next && next.state !== "unavailable" && next.sinceMs <= atMs) return next.state;
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
type SoakSide = RelaySoakFault["clock"];
function timeInClock(atMs: number, from: SoakSide, to: SoakSide, clock: SoakClock): { earliest: number; latest: number } {
  if (from === to) return { earliest: atMs, latest: atMs };
  return from === "relay" ? { earliest: atMs - clock.maxOffsetMs, latest: atMs - clock.minOffsetMs }
    : { earliest: atMs + clock.minOffsetMs, latest: atMs + clock.maxOffsetMs };
}
function faultTime(fault: RelaySoakFault, clock: SoakClock, atMs: number): { earliest: number; latest: number } {
  return timeInClock(atMs, fault.clock, "peer", clock);
}

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
    const affected = links.filter(link => fault.linkIds.includes(link.id));
    const clockMachines = new Set(affected.map(link => fault.clock === "relay" ? link.relayId : link.peerId));
    if (!fault.linkIds.length || new Set(fault.linkIds).size !== fault.linkIds.length || fault.linkIds.some(id => !linkIds.has(id)) ||
        clockMachines.size !== 1 || fault.clearMs < fault.startMs ||
        fault.kind === "route-cut" && fault.clearMs - fault.startMs < 60_000 ||
        (fault.kind === "relay-kill" || fault.kind === "herdr-restart-relay") && fault.clock !== "relay" ||
        (fault.kind === "herdr-restart-peer" || fault.kind === "endpoint-kill") && fault.clock !== "peer") fail("faults");
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
    if (!covers(samples, sample => sample.atMs, startMs, endMs, STATUS_GAP_MS) ||
        !link.calls.some(call => call.holdMs === 20_000 && call.endMs !== null) ||
        !link.calls.some(call => call.holdMs === 0 && call.endMs !== null) ||
        new Set(link.calls.map(call => call.pollId)).size !== link.calls.length) fail("timeline");
    const dialBirths = new Set(link.runs.filter(run => run.role === "dial").map(run => birthKey(run.process)));
    for (const call of link.calls) {
      if (!dialBirths.has(birthKey(call.process)) || call.endMs !== null && call.endMs < call.startMs ||
          call.endMs === null && !linkFaults.some(fault => fault.kind === "relay-kill" && fault.clock === "relay" && fault.process &&
            birthKey(fault.process) === birthKey(call.process) && call.startMs <= fault.startMs)) fail("timeline");
    }
    const transitions = [
      ...samples.map(sample => ({ ...sample, side: "peer" as const })),
      ...link.relayStates.map(sample => ({ ...sample, side: "relay" as const })),
    ];
    for (const fault of linkFaults) {
      const start = faultTime(fault, clock, fault.startMs), clear = faultTime(fault, clock, fault.clearMs);
      if (start.earliest < startMs || clear.latest > endMs || lastStateAt(samples, start.earliest - 1) !== "up") fail("faults");
      // Compare on the fault's clock so same-machine events don't pay for
      // cross-machine clock uncertainty.
      const timed = transitions.map(sample => ({ state: sample.state, ...timeInClock(sample.sinceMs, sample.side, fault.clock, clock) }));
      let droppedBy = Infinity;
      for (const transition of timed) {
        if (transition.state !== "up" && transition.earliest >= fault.startMs && transition.latest <= fault.startMs + 30_000)
          droppedBy = Math.min(droppedBy, transition.latest);
      }
      if (droppedBy === Infinity) fail("stall-detection");
      if (!timed.some(transition => transition.state === "up" && transition.earliest > droppedBy &&
          transition.earliest >= fault.clearMs && transition.latest <= fault.clearMs + 60_000)) fail("recovery");
      if (fault.kind === "endpoint-kill") {
        const endpoint = fault.endpoint;
        if (fault.linkIds.length !== 1 || !endpoint || endpoint.machineId !== link.peerId || endpoint.observedMs > fault.startMs ||
            fault.startMs - endpoint.observedMs > 5000 || !link.calls.some(call => call.pollId === endpoint.pollId && call.holdMs === 20_000 &&
              call.endMs !== null && call.startMs - clock.minOffsetMs <= endpoint.observedMs && call.endMs - clock.maxOffsetMs >= fault.startMs)) fail("endpoint");
      }
    }
    const rss = [...link.rss].sort((a, b) => a.atMs - b.atMs);
    const rssStart = startMs + clock.minOffsetMs, rssEnd = endMs + clock.maxOffsetMs;
    const pauses: TimeSpan[] = [];
    for (const fault of linkFaults) {
      if (fault.clock !== "relay") continue;
      let resumed: SoakRss | undefined;
      if (fault.kind === "relay-kill") {
        if (!fault.process) continue;
        const killed = birthKey(fault.process);
        if (!dialBirths.has(killed)) continue;
        resumed = rss.find(sample => sample.atMs >= fault.startMs && birthKey(sample.process) !== killed);
      } else {
        // A sleeping dial can resume with the same birth when the fault clears.
        resumed = rss.find(sample => sample.atMs >= fault.clearMs);
      }
      if (resumed) pauses.push({ startMs: fault.startMs, endMs: resumed.atMs });
    }
    pauses.sort((a, b) => a.startMs - b.startMs);
    if (!covers(rss, sample => sample.atMs, rssStart, rssEnd, RSS_GAP_MS, pauses) ||
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
      const latestObserved = submit.deadlineMs + OUTCOME_RECORDING_TOLERANCE_MS;
      if (settled.length !== 1 || settled.some(result => {
        const deadline = result.clientDeadlineMs ?? latestObserved;
        return deadline > latestObserved || result.atMs < submit.atMs || result.atMs > deadline;
      })) fail("outcome");
      const outcome = settled[0];
      if (outcome?.kind === "unknown" && !linkFaults.some(fault => {
        const start = faultTime(fault, clock, fault.startMs);
        return submit.atMs <= start.earliest && outcome.atMs >= start.latest;
      })) fail("unknown-outside-fault");
      if (outcome?.kind === "socket_delivered" && (received.length !== 1 || handed.length !== 1) ||
          outcome?.kind === "refused" && received.length !== 0 || received.length > 0 && handed.length !== 1) fail("receipt");
      if (received.length && handed.length && (received[0].atMs < handed[0].atMs ||
          outcome?.kind === "socket_delivered" && outcome.atMs < received[0].atMs - clock.maxOffsetMs)) fail("receipt");
      const healthyCadence = submit.kind === "cadence" && lastStateAt(samples, submit.atMs) === "up" && !linkFaults.some(fault =>
        faultTime(fault, clock, fault.startMs).earliest <= submit.atMs && faultTime(fault, clock, fault.clearMs).latest >= submit.atMs);
      if (healthyCadence) healthy++;
      if (handed.length === 1) {
        const earliest = handed[0].atMs - clock.maxOffsetMs, latest = handed[0].atMs - clock.minOffsetMs;
        if (latest < submit.atMs || earliest > submit.deadlineMs) fail("handoff");
        if (healthyCadence && outcome?.kind !== "refused" && latest - submit.atMs < 2000) fast++;
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
    if (!process || !process.before.complete || !process.after.complete) {
      fail("cleanup");
      continue;
    }
    if (links.some(link => link.relayId === machineId &&
          (process.before.atMs - link.clock.minOffsetMs > startMs || process.after.atMs - link.clock.maxOffsetMs < endMs) ||
        link.peerId === machineId && (process.before.atMs > startMs || process.after.atMs < endMs))) fail("cleanup");
    const before = new Set(process.before.identities.map(birthKey));
    const owned = new Set(links.flatMap(link => link.runs.filter(run => run.machineId === machineId).map(run => birthKey(run.process))));
    if (before.size !== process.before.identities.length || new Set(process.after.identities.map(birthKey)).size !== process.after.identities.length ||
        process.after.identities.some(item => !before.has(birthKey(item)) || owned.has(birthKey(item)))) fail("cleanup");
  }
  return { ok: violations.size === 0, violations: [...violations] };
}

export interface RelaySoakRunLink {
  id: string; topology: SoakTopology; relayId: string; peerId: string;
  from: RelaySubmit["from"]; target: RelaySubmit["target"];
}
export type RelaySoakRecord = { linkId: string } & (
  | ({ type: "run" } & SoakRun)
  | ({ type: "submission" } & SoakSubmission)
  | ({ type: "handoff" | "receipt" } & SoakEvent)
  | ({ type: "outcome" } & SoakOutcomeEvent)
  | ({ type: "state" | "relay-state" } & SoakStateEvent)
  | ({ type: "rss" } & SoakRss)
  | { type: "poll-start" | "poll-end"; atMs: number; pollId: string; wireLinkId: string; holdMs: 0 | 20000; process: BirthIdentity }
  | { type: "submission-error"; atMs: number; id: string }
);

interface DriverBase {
  link: RelaySoakRunLink; clock: Clock; signal: AbortSignal; startMs: number; endMs: number;
  rssAllowanceBytes: number; process: BirthIdentity; emit(record: RelaySoakRecord): void;
}
export interface RelaySoakReceiptSink { receive(id: string): Promise<void> }
export interface RelaySoakDialOptions extends DriverBase {
  relay: RelayPeer; peer: Peer; transport: Pick<Transport, "resolve" | "exec">; rssBytes(): number; sink: RelaySoakReceiptSink;
}
export interface RelaySoakSubmitOptions extends DriverBase {
  submit(relayId: string, value: RelaySubmit, signal: AbortSignal): Promise<RelayResult>;
  list(signal: AbortSignal): Promise<readonly RelayLinkView[]>;
  nextId?(): string;
}
export type RelaySoakBurstOptions = Omit<RelaySoakSubmitOptions, "list">;

function runRecord(options: DriverBase, role: SoakRun["role"]): void {
  options.emit({ type: "run", linkId: options.link.id, role, startMs: options.startMs, endMs: options.endMs,
    rssAllowanceBytes: options.rssAllowanceBytes, machineId: role === "dial" ? options.link.relayId : options.link.peerId, process: options.process });
}

/** Drive the real carrier; the sink records a receipt independently of the broker outcome. */
export async function runRelaySoakDial(options: RelaySoakDialOptions): Promise<void> {
  const { link, relay, peer, transport, clock, signal, emit, sink } = options;
  runRecord(options, "dial");
  let cancelRss = () => {};
  const sampleRss = () => {
    if (signal.aborted) return;
    emit({ type: "rss", linkId: link.id, atMs: clock.now(), bytes: options.rssBytes(), process: options.process });
    cancelRss = clock.later(30_000, sampleRss);
  };
  sampleRss();
  const observedTransport: Pick<Transport, "resolve" | "exec"> = {
    resolve: (value, call) => transport.resolve(value, call),
    async exec(value, argv, call) {
      const holdMs = Number(argv.at(-1)) as 0 | 20000;
      const poll = decodeRelayPoll(call.stdin!, holdMs);
      const event = { linkId: link.id, pollId: poll.hello.pollId, wireLinkId: poll.hello.linkId, holdMs, process: options.process };
      emit({ type: "poll-start", atMs: clock.now(), ...event });
      try { return await transport.exec(value, argv, call); }
      finally { emit({ type: "poll-end", atMs: clock.now(), ...event }); }
    },
  };
  try {
    await runRelayPollLoop({ relay, peer, transport: observedTransport, clock, signal, reach: () => [relay],
      observe: view => emit({ type: "relay-state", linkId: link.id, atMs: clock.now(), sinceMs: view.sinceMs, state: view.state }),
      async forward(submit) {
        const id = submit.message.id;
        emit({ type: "handoff", linkId: link.id, id, atMs: clock.now() });
        const from = submit.from, expected = link.from, target = submit.target, pin = link.target;
        if (submit.kind !== "send" || submit.message.text !== "relay-soak" || from.machineId !== expected.machineId ||
            from.address.sessionId !== expected.address.sessionId || from.address.scopeId !== expected.address.scopeId ||
            from.name !== expected.name || from.homeEpoch !== expected.homeEpoch || from.endpointEpoch !== expected.endpointEpoch ||
            target.machineId !== pin.machineId || target.homeEpoch !== pin.homeEpoch ||
            target.selector.by !== pin.selector.by || target.selector.value !== pin.selector.value) {
          return { type: "result", messageId: id, attempted: false, outcome: { kind: "refused", code: "unauthorized" } };
        }
        await sink.receive(id);
        return { type: "result", messageId: id, attempted: true, outcome: { kind: "socket_delivered", id } };
      },
    });
  } finally { cancelRss(); }
}

function waitUntil(clock: Clock, targetMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (clock.now() >= targetMs) return Promise.resolve(true);
  return new Promise(resolve => {
    let cancel = () => {};
    const finish = (ready: boolean) => { cancel(); signal.removeEventListener("abort", aborted); resolve(ready); };
    const aborted = () => finish(false);
    cancel = clock.later(targetMs - clock.now(), () => finish(true));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function submissionDriver(options: RelaySoakBurstOptions) {
  const { link, clock, signal, emit } = options;
  const nextId = options.nextId ?? randomUUID;
  const ids = new Set<string>();
  const freshId = (): string => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = nextId();
      if (text(id) && !ids.has(id)) { ids.add(id); return id; }
    }
    throw new Error("Cannot create a unique soak message ID");
  };
  const send = (kind: "cadence" | "burst", marker: number | string): Promise<void> => {
    const id = freshId(), atMs = clock.now();
    const markerFields = kind === "cadence" ? { scheduledMs: marker as number } : { burstId: marker as string };
    emit({ type: "submission", linkId: link.id, id, atMs, deadlineMs: atMs + V0_INTERCOM_MS, kind, ...markerFields });
    const frame: RelaySubmit = { type: "submit", kind: "send", from: link.from, target: link.target,
      message: { id, timestamp: atMs, text: "relay-soak" } };
    return (async () => {
      try {
        const result = await options.submit(link.relayId, frame, signal);
        if (!isRelayResult(result) || result.messageId !== id) throw new Error("Invalid soak result");
        emit({ type: "outcome", linkId: link.id, id, atMs: clock.now(), kind: result.outcome.kind });
      } catch {
        // A failed call is not a fabricated final outcome. The checker will reject it.
        emit({ type: "submission-error", linkId: link.id, id, atMs: clock.now() });
      }
    })();
  };
  return { send, freshId };
}

/** Submit on the peer clock without replaying missed five-second slots. */
export async function runRelaySoakSubmit(options: RelaySoakSubmitOptions): Promise<void> {
  const { link, clock, signal, startMs, endMs, emit } = options;
  runRecord(options, "submit");
  const driver = submissionDriver(options), pending = new Set<Promise<void>>();
  const schedule = async () => {
    let slot = 0;
    while (!signal.aborted) {
      const scheduledMs = startMs + slot * CADENCE_MS;
      if (scheduledMs >= endMs || !await waitUntil(clock, scheduledMs, signal)) break;
      const now = clock.now();
      if (now >= endMs) break;
      if (now >= scheduledMs + CADENCE_MS) { slot = Math.floor((now - startMs) / CADENCE_MS); continue; }
      const sent = driver.send("cadence", scheduledMs);
      pending.add(sent);
      void sent.then(() => pending.delete(sent));
      slot++;
    }
  };
  const sampleStates = async () => {
    let next = clock.now(), unavailableSinceMs: number | undefined;
    while (!signal.aborted) {
      if (!await waitUntil(clock, Math.min(next, endMs), signal)) break;
      let view: RelayLinkView | undefined;
      try {
        const views = await options.list(signal);
        const matches = views.filter(view => view.relay.machineId === link.relayId);
        if (matches.length === 1) view = matches[0];
      } catch { /* Missing broker evidence stays unavailable. */ }
      const atMs = clock.now();
      if (view) {
        unavailableSinceMs = undefined;
        emit({ type: "state", linkId: link.id, atMs, sinceMs: view.sinceMs, state: view.state });
      } else {
        unavailableSinceMs ??= atMs;
        emit({ type: "state", linkId: link.id, atMs, sinceMs: unavailableSinceMs, state: "unavailable" });
      }
      if (atMs >= endMs) break;
      next = Math.max(next + CADENCE_MS, atMs);
    }
  };
  await Promise.all([schedule(), sampleStates()]);
  await Promise.allSettled([...pending]);
}

/** Send a single batch concurrently. A separate process may invoke it once during the run. */
export async function runRelaySoakBurst(options: RelaySoakBurstOptions): Promise<void> {
  if (options.signal.aborted || options.clock.now() < options.startMs || options.clock.now() >= options.endMs) throw new Error("Burst is outside the soak");
  runRecord(options, "submit");
  const driver = submissionDriver(options), burstId = driver.freshId();
  const sends = Array.from({ length: 100 }, () => driver.send("burst", burstId));
  await Promise.all(sends);
}

export interface RelaySoakManifest {
  startMs: number; endMs: number; rssAllowanceBytes: number;
  links: readonly (Pick<RelaySoakLinkEvidence, "id" | "topology" | "relayId" | "peerId" | "clock"> & {
    recordFiles: readonly string[]; receiptFile: string;
  })[];
  faults: readonly RelaySoakFault[]; processes: readonly SoakProcessCensus[];
}
const invalidRecord = () => new Error("Invalid soak record");
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function decodeRecord(line: string, linkId: string): RelaySoakRecord {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw invalidRecord(); }
  if (!object(value) || value.linkId !== linkId || typeof value.type !== "string") throw invalidRecord();
  const fields: Record<string, readonly string[]> = {
    run: ["role", "startMs", "endMs", "rssAllowanceBytes", "machineId", "process"],
    submission: ["id", "atMs", "deadlineMs", "kind", value.kind === "cadence" ? "scheduledMs" : "burstId"],
    handoff: ["id", "atMs"], receipt: ["id", "atMs"],
    outcome: Object.hasOwn(value, "clientDeadlineMs") ? ["id", "atMs", "kind", "clientDeadlineMs"] : ["id", "atMs", "kind"],
    state: ["atMs", "sinceMs", "state"], "relay-state": ["atMs", "sinceMs", "state"], rss: ["atMs", "bytes", "process"],
    "poll-start": ["atMs", "pollId", "wireLinkId", "holdMs", "process"],
    "poll-end": ["atMs", "pollId", "wireLinkId", "holdMs", "process"],
    "submission-error": ["atMs", "id"],
  };
  const expected = fields[value.type];
  if (!expected || !exactKeys(value, ["type", "linkId", ...expected])) throw invalidRecord();
  return value as unknown as RelaySoakRecord;
}

function* decodeLog(data: string, linkId: string, allowEmpty = false): Generator<RelaySoakRecord> {
  if (allowEmpty && data === "") return;
  if (typeof data !== "string" || !data.endsWith("\n")) throw invalidRecord();
  for (const line of data.slice(0, -1).split("\n")) {
    if (!line || Buffer.byteLength(line) > 8192) throw invalidRecord();
    yield decodeRecord(line, linkId);
  }
}

/** Join operator observations, driver logs, and the independent receipt files. */
export function assembleRelaySoak(manifest: RelaySoakManifest, readRecords: (path: string) => string): RelaySoakEvidence {
  if (!object(manifest) || !Array.isArray(manifest.links) || !Array.isArray(manifest.faults) || !Array.isArray(manifest.processes)) throw invalidRecord();
  const links: RelaySoakLinkEvidence[] = manifest.links.map(input => {
    if (!object(input) || !text(input.id) || !entries(input.recordFiles, text) || !text(input.receiptFile)) throw invalidRecord();
    const runs: SoakRun[] = [], submissions: SoakSubmission[] = [], handoffs: SoakEvent[] = [], receipts: SoakEvent[] = [];
    const outcomes: SoakOutcomeEvent[] = [], stateEvents: SoakStateEvent[] = [], relayStates: SoakStateEvent[] = [];
    const rss: SoakRss[] = [], calls: SoakCall[] = [];
    const open = new Map<string, Extract<RelaySoakRecord, { type: "poll-start" | "poll-end" }>>();
    const seen = new Set<string>();
    for (const record of decodeLog(readRecords(input.receiptFile), input.id, true)) {
      if (record.type !== "receipt") throw invalidRecord();
      receipts.push(record);
    }
    for (const path of input.recordFiles as string[]) {
      for (const record of decodeLog(readRecords(path), input.id)) {
        switch (record.type) {
          case "run": runs.push(record); break;
          case "submission": submissions.push(record); break;
          case "handoff": handoffs.push(record); break;
          case "receipt": throw invalidRecord();
          case "outcome": outcomes.push(record); break;
          case "state": stateEvents.push(record); break;
          case "rss": rss.push(record); break;
          case "relay-state": relayStates.push(record); break;
          case "submission-error": throw invalidRecord();
          case "poll-start":
            if (!text(record.pollId) || !text(record.wireLinkId) || !time(record.atMs) || !identity(record.process) ||
                record.holdMs !== 0 && record.holdMs !== 20_000 || seen.has(record.pollId)) throw invalidRecord();
            seen.add(record.pollId); open.set(record.pollId, record); break;
          case "poll-end": {
            const started = open.get(record.pollId);
            if (!started || !time(record.atMs) || record.atMs < started.atMs || record.holdMs !== started.holdMs ||
                record.wireLinkId !== started.wireLinkId || !identity(record.process) || birthKey(record.process) !== birthKey(started.process)) throw invalidRecord();
            calls.push({ pollId: record.pollId, holdMs: record.holdMs, startMs: started.atMs, endMs: record.atMs, process: record.process });
            open.delete(record.pollId);
            break;
          }
        }
      }
    }
    for (const record of open.values()) calls.push({ pollId: record.pollId, holdMs: record.holdMs, startMs: record.atMs, endMs: null, process: record.process });
    return { id: input.id, topology: input.topology as SoakTopology, relayId: input.relayId as string, peerId: input.peerId as string,
      clock: input.clock as SoakClock, runs, submissions, handoffs, outcomes, receipts, states: stateEvents, relayStates, rss, calls };
  });
  const evidence: RelaySoakEvidence = { startMs: manifest.startMs, endMs: manifest.endMs, rssAllowanceBytes: manifest.rssAllowanceBytes,
    links, faults: manifest.faults, processes: manifest.processes };
  if (!isEvidence(evidence)) throw invalidRecord();
  return evidence;
}

export interface RelaySoakOriginDeps {
  readIdentity(root: string): RoamConfig;
  readRoutes(root: string, config: RoamConfig): V0Routes;
  lookup(agentDir: string, op: Extract<V0BrokerOp, { kind: "lookup" }>): Promise<V0Reply>;
}

/** Obtain the admitted fixture's exact local broker pin without starting a broker. */
export async function lookupRelaySoakOrigin(root: string, sessionId: string, scopeId: string | null,
  overrides: Partial<RelaySoakOriginDeps> = {}): Promise<RelaySubmit["from"]> {
  if (!text(sessionId) || scopeId !== null && !text(scopeId)) throw new Error("Invalid fixture origin");
  const config = (overrides.readIdentity ?? readLocalIdentity)(root);
  const routes = (overrides.readRoutes ?? readV0Routes)(root, config);
  if (routes.version !== 2) throw new Error("Invalid fixture routes");
  const result = await (overrides.lookup ?? requestV0Broker)(routes.agentDir, { kind: "lookup", scopeId, selector: { by: "id", value: sessionId } });
  if (result.kind !== "matches" || result.targets.length !== 1 || result.targets[0].address.sessionId !== sessionId ||
      result.targets[0].address.scopeId !== scopeId || !text(result.targets[0].endpointEpoch) || result.targets[0].homeEpoch <= 0) {
    throw new Error("Fixture origin is not admitted");
  }
  return { machineId: config.machineId, ...result.targets[0] };
}

export interface RelaySoakIo { out(text: string): void; err(text: string): void }
export interface RelaySoakCliDeps {
  readText(path: string): string;
  readIdentity(root: string): RoamConfig;
  readRoutes(root: string, config: RoamConfig): V0Routes;
  createTransport(root: string, routes: V0Routes): Pick<Transport, "resolve" | "exec">;
  processIdentity(): Promise<BirthIdentity>;
  submitRelay(agentDir: string, relayId: string, submit: RelaySubmit, signal: AbortSignal): Promise<RelayResult>;
  listRelays(agentDir: string, signal: AbortSignal): Promise<readonly RelayLinkView[]>;
  clock: Clock; signal: AbortSignal; rssBytes(): number;
}
interface RelaySoakRunFile { root: string; startMs: number; rssAllowanceBytes: number; links: readonly RelaySoakRunLink[] }

function parseRunFile(value: unknown): RelaySoakRunFile {
  if (!object(value) || !exactKeys(value, ["root", "startMs", "rssAllowanceBytes", "links"]) ||
      !text(value.root) || !isAbsolute(value.root) || !time(value.startMs) || !time(value.startMs + SOAK_MS) ||
      !time(value.rssAllowanceBytes) || !Array.isArray(value.links) || value.links.length === 0) throw new Error("Invalid soak run file");
  const links: RelaySoakRunLink[] = value.links.map(item => {
    if (!object(item) || !exactKeys(item, ["id", "topology", "relayId", "peerId", "from", "target"]) || !text(item.id) ||
        !text(item.relayId) || !text(item.peerId) || item.relayId === item.peerId ||
        item.topology !== "laptop-to-box" && item.topology !== "box-to-box" || !object(item.from) || item.from.machineId !== item.peerId ||
        !isRelaySubmit({ type: "submit", kind: "send", from: item.from, target: item.target,
          message: { id: "soak-validation", timestamp: value.startMs, text: "relay-soak" } })) throw new Error("Invalid soak link");
    return item as unknown as RelaySoakRunLink;
  });
  if (new Set(links.map(link => link.id)).size !== links.length) throw new Error("Duplicate soak link");
  return { root: value.root, startMs: value.startMs, rssAllowanceBytes: value.rssAllowanceBytes, links };
}

const systemClock: Clock = { now: () => Date.now(), later(ms, fn) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
async function ownProcessIdentity(): Promise<BirthIdentity> {
  const birthId = processStartIdentity(process.pid), bootId = await localBootId();
  if (!birthId || !bootId) throw new Error("Process identity is unavailable");
  return { pid: process.pid, birthId, bootId };
}

/** The check command reads local evidence only. Dial and submit are explicit operator actions. */
export async function relaySoakMain(args: readonly string[], io: RelaySoakIo,
  overrides: Partial<RelaySoakCliDeps> = {}): Promise<number> {
  const readText = overrides.readText ?? ((path: string) => readFileSync(path, "utf8"));
  if (args[0] === "check" && args.length === 2) {
    let result: ReturnType<typeof checkRelaySoak>;
    try {
      const raw: unknown = JSON.parse(readText(args[1]));
      const evidence = object(raw) && Array.isArray(raw.links) && raw.links.length > 0 &&
        raw.links.every(link => object(link) && Array.isArray(link.recordFiles))
        ? assembleRelaySoak(raw as unknown as RelaySoakManifest, path => readText(resolve(dirname(args[1]), path)))
        : raw as RelaySoakEvidence;
      result = checkRelaySoak(evidence);
    } catch { result = { ok: false, violations: ["evidence"] }; }
    io.out(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  }
  const dial = args[0] === "dial" && args.length === 4;
  const submit = args[0] === "submit" && (args.length === 3 || args.length === 4 && args[3] === "--burst");
  if (!dial && !submit) {
    io.err("Usage: relay-soak dial <run-file> <link-id> <receipt-file> | submit <run-file> <link-id> [--burst] | check <evidence-file>\n");
    return 2;
  }
  try {
    const run = parseRunFile(JSON.parse(readText(args[1]))), link = run.links.find(item => item.id === args[2]);
    if (!link) throw new Error("Soak link not found");
    const config = (overrides.readIdentity ?? readLocalIdentity)(run.root);
    const routes = (overrides.readRoutes ?? readV0Routes)(run.root, config);
    if (routes.version !== 2 || !routes.relays.includes(link.relayId)) throw new Error("Soak relay is not configured");
    const identity = await (overrides.processIdentity ?? ownProcessIdentity)();
    if (!identity || !object(identity) || !identity.pid || !identity.birthId || !identity.bootId) throw new Error("Process identity is unavailable");
    const clock = overrides.clock ?? systemClock, signal = overrides.signal ?? new AbortController().signal;
    const common = { link, clock, signal, startMs: run.startMs, endMs: run.startMs + SOAK_MS,
      rssAllowanceBytes: run.rssAllowanceBytes, process: identity, emit: (record: RelaySoakRecord) => io.out(`${JSON.stringify(record)}\n`) };
    if (dial) {
      const peer = routes.sendTo.find(item => item.machineId === link.peerId), alias = config.intercom.machineAlias ?? link.relayId;
      if (config.machineId !== link.relayId || !routes.linkTo.includes(link.peerId) || !peer || !isV0Alias(alias)) throw new Error("Soak peer is not pinned");
      const transport = overrides.createTransport?.(run.root, routes) ?? createRoamTransport({ ...localHerdrConnection(run.root), enrolled: routes.sendTo });
      const receiptFile = await open(args[3], constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        if (!(await receiptFile.stat()).isFile()) throw new Error("Invalid soak receipt file");
        await runRelaySoakDial({ ...common, relay: { machineId: link.relayId, alias }, peer, transport,
          rssBytes: overrides.rssBytes ?? (() => process.memoryUsage().rss),
          sink: { async receive(id) {
            const bytes = Buffer.from(JSON.stringify({ type: "receipt", linkId: link.id, id, atMs: clock.now() }) + "\n");
            // One append per line, even when several deliveries settle together.
            const { bytesWritten } = await receiptFile.write(bytes);
            if (bytesWritten !== bytes.length) throw new Error("Incomplete soak receipt");
            await receiptFile.sync();
          } },
        });
      } finally { await receiptFile.close(); }
    } else {
      if (config.machineId !== link.peerId) throw new Error("Soak origin is not local");
      const submitRelay = overrides.submitRelay ?? submitV0Relay, listRelays = overrides.listRelays ?? listV0RelayLinks;
      const options = { ...common, submit: (relayId: string, frame: RelaySubmit, callSignal: AbortSignal) => submitRelay(routes.agentDir, relayId, frame, callSignal),
        list: (callSignal: AbortSignal) => listRelays(routes.agentDir, callSignal) };
      if (args[3] === "--burst") await runRelaySoakBurst(options);
      else await runRelaySoakSubmit(options);
    }
    return 0;
  } catch {
    io.err("relay-soak: cannot start; check the run file and local prerequisites\n");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    process.exitCode = await relaySoakMain(process.argv.slice(2), {
      out: text => { process.stdout.write(text); }, err: text => { process.stderr.write(text); },
    }, { signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
