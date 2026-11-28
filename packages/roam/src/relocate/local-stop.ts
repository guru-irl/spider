import type { Db } from "@spider/db-core";
import { parseLocationStores } from "@spider/db-core/roam/catalog";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { openRoamStoreReadOnly } from "@spider/db-core/roam/reads";
import type { StoreKey } from "@spider/db-core/roam/types";
import { bootIdChanged, localBootId, type IdLockObservation } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { birthlessTerminalEnd } from "../../../subagents/src/reaper";
import type { Clock } from "../contracts";
import { decodeManagedHome, readManagedHome, sameManagedHome } from "./home";
import { object, parsePlacement } from "./journal";
import type { LocalIO, LocalRuntime } from "./local";
import { createStopWork } from "./local-stop-work";
import type { OwnerGeneration, StopBlocker, StopMode, StopObservation } from "./session-stop-types";
import type { RelocateAdapterOptions, RelocateHome, SessionId, StoppedHome } from "./types";

const modeState = "relocate-stop-mode", proofState = "relocate-stop-proof";
const graceMs = 5_000, probeMs = 100, terminalReadMs = 1_500;
const processStartResolutionMs = 1_000; // ps lstart reports whole seconds.
const unavailable = "The local session or its work could not be verified.";
const expired = "The local stop check ran out of time.";
type Evidence = StopObservation["evidence"];
type Signal = Parameters<LocalIO["signal"]>[1];
type Terminal = Awaited<ReturnType<LocalIO["terminals"]>>[number];
type Identity = Pick<OwnerGeneration, "pid" | "startIdentity">;
type Child = Identity & { kind: "verified" | "run" | "detached" | "unclassified" };
// Earlier proofs marked only verified subagent children as "run".
const verifiedChild = (child: Child) => child.kind === "verified" || child.kind === "run";
type Capture = { owner: OwnerGeneration; terminal: string | null; children: Child[] };
type Proof = { home: StoppedHome; bootId: string; observedAt: number; evidence: Evidence; capture: Capture | null; carried?: readonly Identity[] };
type ModeRecord = { home: StoppedHome; mode: StopMode };
type Location = { file: string | null; cwd: string | null; local: boolean };
type Owner = { generation: OwnerGeneration; terminal: string | null; admitted: boolean };
type OwnerScan = { owner: Owner | null; terminalsKnown: boolean };
type StateLock = <T>(id: SessionId, run: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

const pending = (reason: string, blockers: readonly StopBlocker[] = []): Evidence => ({ kind: "pending", reason, blockers });
const check = (reason: string): StopBlocker => ({ kind: "check", reason });
const sameProcess = (a: Identity, b: Identity) => a.pid === b.pid && a.startIdentity === b.startIdentity;
const safePid = (pid: number) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid;
const knownText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

class StopCheck extends Error {}
class WindowEnded extends Error {}

function readProof(db: Db, home: StoppedHome, bootId: string, scope: "exact" | "include-earlier" = "exact"): Proof | null {
  const proof = readLocal<Proof>(db, proofState, home.sessionId);
  if (proof === undefined) return null;
  if (!proof || !knownText(proof.bootId)) throw new StopCheck(unavailable);
  const savedHome = decodeManagedHome(object(proof.home));
  if (proof.bootId !== bootId || savedHome.state !== "stopped" || savedHome.sessionId !== home.sessionId ||
      (!sameManagedHome(savedHome, home) && !(scope === "include-earlier" && savedHome.epoch < home.epoch))) return null;
  const identity = (value: Identity) => safePid(value?.pid) && knownText(value?.startIdentity);
  const owner = (value: OwnerGeneration) => identity(value) && value.bootId === bootId;
  if (!Number.isSafeInteger(proof.observedAt) || proof.observedAt < 0 || !proof.evidence ||
      (proof.evidence.kind === "confirmed" ? proof.evidence.owner !== null && !owner(proof.evidence.owner)
        : proof.evidence.kind === "pending" ? !knownText(proof.evidence.reason) || !Array.isArray(proof.evidence.blockers)
        : proof.evidence.kind !== "checking") ||
      proof.carried !== undefined && (!Array.isArray(proof.carried) || !proof.carried.every(identity) ||
        proof.evidence.kind === "confirmed" && proof.carried.length > 0) ||
      proof.capture !== null && (!owner(proof.capture.owner) ||
        proof.capture.terminal !== null && !knownText(proof.capture.terminal) || !Array.isArray(proof.capture.children) ||
        !proof.capture.children.every(child => identity(child) && child.pid !== proof.capture!.owner.pid &&
          ["verified", "run", "detached", "unclassified"].includes(child.kind)))) throw new StopCheck(unavailable);
  return { ...proof, home: savedHome };
}

/** This transaction does not take the session lock, so it can upgrade a wait in progress. */
export function queueStopMode(db: Db, home: StoppedHome, mode: StopMode): void {
  db.raw.transaction(() => {
    const actual = readManagedHome(db, home.sessionId);
    if (actual?.state !== "stopped" || !sameManagedHome(actual, home)) return;
    const prior = readLocal<ModeRecord>(db, modeState, home.sessionId);
    if (prior?.mode === "hard" && sameManagedHome(prior.home, home)) return;
    writeLocal(db, modeState, home.sessionId, { home, mode });
  }).immediate();
}

function openMembership(db: Db, key: StoreKey, options: RelocateAdapterOptions): Db | undefined {
  const store = openRoamStoreReadOnly(db, key);
  if (!store) return;
  try {
    const meta = store.prepare("SELECT machine_id, store_key FROM roam_meta WHERE id=1").get() as { machine_id: string; store_key: string | null } | undefined;
    if (meta?.machine_id !== options.config.machineId || meta.store_key !== null && meta.store_key !== key) throw new StopCheck(unavailable);
    return store;
  } catch (error) { store.close(); throw error; }
}

function locateRecords(options: RelocateAdapterOptions, id: SessionId, displaced: boolean): Location {
  const db = options.globalDb;
  const value = readLocal<unknown>(db, "relocate-managed", id);
  const placement = value === undefined ? null : parsePlacement(value);
  if (placement && (placement.sessionId !== id || placement.machineId !== options.config.machineId)) throw new StopCheck(unavailable);
  const row = db.prepare("SELECT file,cwd,stores_json FROM roam_locations WHERE session_id=?").get(id) as
    { file: string | null; cwd: string | null; stores_json: string } | undefined;
  const stores = [...new Set([...(placement?.stores ?? []), ...(row ? parseLocationStores(JSON.parse(row.stores_json), { allowEmpty: true }) : [])])]
    .filter(key => key.startsWith("worktree:"));
  const file = placement?.file ?? row?.file ?? null, cwd = placement?.cwd ?? row?.cwd ?? null;
  if (file !== null && !isAbsolute(file) || cwd !== null && !isAbsolute(cwd)) throw new StopCheck(unavailable);
  let local = !displaced || !!placement || file !== null && cwd !== null;
  // Catalog-only replicas don't establish local provenance. A retained local
  // membership can, even when its placement no longer resolves to a checkout.
  if (!local) for (const key of stores) {
    const store = openMembership(db, key, options);
    if (!store) continue;
    try { local = !!store.prepare("SELECT 1 FROM roam_sessions WHERE session_id=? AND state IN ('active','frozen')").get(id); }
    finally { store.close(); }
    if (local) break;
  }
  return { file, cwd, local };
}

function budget(clock: Clock, readyMs: number) {
  const end = clock.now() + readyMs;
  const controller = new AbortController();
  const timeout = new StopCheck(expired);
  let reject!: (error: Error) => void;
  const limit = new Promise<never>((_, fail) => { reject = fail; });
  void limit.catch(() => {});
  const cancel = clock.later(readyMs, () => { controller.abort(); reject(timeout); });
  function remaining(until = end): number {
    return Math.max(0, Math.floor(Math.min(end, until) - clock.now()));
  }
  function assert(): void { if (controller.signal.aborted || remaining() === 0) throw timeout; }
  async function read<T>(run: () => Promise<T>, until = end): Promise<T> {
    assert();
    const ms = remaining(until);
    if (!ms) throw new WindowEnded();
    let closeWindow: (() => void) | undefined;
    try {
      const limits = [limit];
      if (until < end) limits.push(new Promise<never>((_, fail) => {
        closeWindow = clock.later(ms, () => fail(new WindowEnded()));
      }));
      const value = await Promise.race([run(), ...limits]);
      assert();
      if (!remaining(until)) throw new WindowEnded();
      return value;
    } finally { closeWindow?.(); }
  }
  return { end, remaining, read, cancel, signal: controller.signal };
}

export function createLocalStop(options: RelocateAdapterOptions, io: LocalIO, withSessionState: StateLock): Pick<LocalRuntime, "enforceStopped" | "observeStopped"> {
  const { config: { machineId }, globalDb: db, clock } = options;
  const work = createStopWork(options);
  const leases = createSessionLeases(join(options.root, "herdr"));
  const readBoot = () => io.bootId ? io.bootId() : localBootId();
  const readLease = (file: string) => io.fileLease ? io.fileLease(file) : leases.get(file);

  async function stoppedCheck(expected: StoppedHome, enforce: boolean): Promise<StopObservation> {
    const id = expected.sessionId;
    const time = budget(clock, options.limits.readyMs);
    let home: RelocateHome | null = null, bootId: string | null = null;
    let capture: Capture | null = null;
    let carried: readonly Identity[] = [];
    let proofUnreadable = false;
    const observation = (evidence: Evidence, observedAt = clock.now()): StopObservation => ({ sessionId: id, machineId, home, bootId, observedAt, evidence });
    const mismatch = () => new StopCheck(home ? "The local home differs from the requested stopped home." : "The stopped home is missing locally.");
    function requireStoppedHome(): void {
      if (home?.state !== "stopped" || !sameManagedHome(home, expected)) throw mismatch();
    }
    async function readHome(until?: number): Promise<void> {
      home = await time.read(() => options.homes.read(id), until);
      requireStoppedHome();
    }
    async function readInitialState(): Promise<void> {
      home = await time.read(() => options.homes.read(id));
      bootId = (await time.read(readBoot)) || null;
      requireStoppedHome();
      if (!bootId) throw new StopCheck("The local boot identity is unavailable.");
    }
    async function guard(until?: number): Promise<void> {
      const boot = await time.read(readBoot, until);
      if (boot !== bootId) {
        bootId = boot || null;
        capture = null;
        carried = [];
        throw new StopCheck("The local boot changed during the stop check.");
      }
      await readHome(until);
    }
    function save(evidence: Evidence): StopObservation {
      const at = clock.now();
      // Publication can race a proof write on another connection.
      db.raw.transaction(() => {
        home = readManagedHome(db, id);
        requireStoppedHome();
        if (!bootId) throw new StopCheck("The local boot identity is unavailable.");
        // Keep unreadable survivor evidence unless a fresh owner supplied a
        // capture. Malformed storage can prevent even that replacement, but
        // must not prevent enforcement of the exact stopped home.
        if (proofUnreadable && !capture) return;
        try { writeLocal(db, proofState, id, { home: expected, bootId, observedAt: at, evidence, capture,
          ...(carried.length ? { carried } : {}),
        } satisfies Proof); }
        catch (error) { if (!proofUnreadable) throw error; }
      }).immediate();
      return observation(evidence, at);
    }
    const hard = () => {
      const record = readLocal<ModeRecord>(db, modeState, id);
      return record?.mode === "hard" && sameManagedHome(record.home, expected);
    };
    const probe = (pid: number, until?: number) => time.read(() => io.probe(pid), until);
    const inspect = () => time.read(() => io.inspect(id));
    async function liveTerminals(detail: boolean, admittedPid?: number) {
      const timeout = Math.min(terminalReadMs, options.limits.controlMs, time.remaining());
      return (await time.read(() => io.terminals(id, admittedPid, detail, { timeoutMs: timeout }), clock.now() + timeout)).filter(t => t.state === "live");
    }
    async function lockOwner(lock: IdLockObservation | null): Promise<Identity | null> {
      if (!lock || bootIdChanged(lock.bootId, bootId!)) return null;
      const p = await probe(lock.identity.pid);
      if (p.kind === "absent" || p.kind === "live" && p.startIdentity !== lock.identity.startIdentity) return null;
      if (p.kind !== "live" || !p.pi || !safePid(lock.identity.pid) || lock.bootId !== bootId || lock.pendingOperationId !== null)
        throw new StopCheck("The current session ID lock does not identify a verified pi owner.");
      return lock.identity;
    }
    async function shortCheck(): Promise<boolean> {
      const lock = await inspect();
      const free = !await lockOwner(lock) && (await liveTerminals(false)).length === 0 && isDeepStrictEqual(await inspect(), lock);
      await guard();
      return free;
    }
    async function scanOwner(location: Location): Promise<OwnerScan> {
      const lock = await inspect(), held = await lockOwner(lock);
      // The exact ID lock can still identify pi if Herdr is offline. In
      // that case neither a lockless owner nor absence can be established.
      const terminals = await liveTerminals(true, held?.pid).catch(() => null);
      const terminal = terminals?.[0];
      function validateLabel(t: Terminal): void {
        const launch = t.launch;
        if (!launch || launch.sessionId !== id || launch.machineId !== machineId || launch.epoch >= expected.epoch ||
            location.file !== null && launch.file !== location.file || location.cwd !== null && launch.cwd !== location.cwd ||
            t.pid === null || !safePid(t.pid) || held && t.pid !== held.pid || lock && !held && t.pid === lock.identity.pid)
          throw new StopCheck("A live terminal has conflicting session ownership evidence.");
      }
      if (terminals && terminals.length > 1) throw new StopCheck("More than one live terminal names this session.");
      let identity = held;
      if (terminal) {
        // An ordinary terminal may be returned by the PID fallback. Any
        // claimed session labels, including malformed ones, must agree.
        if (!held || terminal.pid !== held.pid || terminal.launch || terminal.labelled) validateLabel(terminal);
        if (!identity) {
          const pid = terminal.pid!;
          const process = await probe(pid);
          if (process.kind !== "live" || !process.pi) throw new StopCheck("The labelled terminal has no verified pi process.");
          identity = { pid, startIdentity: process.startIdentity };
        }
      }
      const file = location.file ?? terminal?.launch?.file ?? null;
      let leased = false;
      if (file !== null) {
        const lease = await time.read(() => readLease(file));
        if (lease && !(lease.bootId && bootIdChanged(lease.bootId, bootId!))) {
          const p = await probe(lease.pid);
          if (p.kind === "unknown" || p.kind === "live" && p.startIdentity === lease.startIdentity &&
              (!identity || !sameProcess(identity, lease) || lease.bootId !== undefined && lease.bootId !== bootId))
            throw new StopCheck("The session file lease conflicts with the verified owner.");
          leased = p.kind === "live" && p.startIdentity === lease.startIdentity;
        }
      }
      if (!isDeepStrictEqual(await inspect(), lock)) throw new StopCheck("The session ID lock changed during verification.");
      await guard();
      return { owner: identity && { generation: { ...identity, bootId: bootId! },
        terminal: terminal && terminal.launch ? JSON.stringify([terminal.terminal, terminal.launch]) : null,
        admitted: !!held && leased }, terminalsKnown: terminals !== null };
    }
    async function currentOwner(location: Location): Promise<OwnerScan> {
      const current = await scanOwner(location);
      if (current.owner && (!capture || !sameProcess(current.owner.generation, capture.owner) ||
          capture.terminal && current.owner.terminal && capture.terminal !== current.owner.terminal))
        throw new StopCheck("A replacement owner appeared during the stop check.");
      return current;
    }
    async function gone(identity: Identity, until?: number): Promise<boolean> {
      const state = await probe(identity.pid, until);
      return state.kind === "absent" || state.kind === "live" && state.startIdentity !== identity.startIdentity;
    }
    async function inventory(children: readonly Identity[]) {
      const result = await time.read(() => work.inventory(id));
      const excluded = new Set(result.excludedRoots);
      for (const child of children) if (result.excludedRoots.includes(child.pid)) {
        for (const descendant of (await time.read(() => io.tree(child.pid))).descendants) excluded.add(descendant.pid);
      }
      return { ...result, excluded };
    }
    async function captureTree(owner: Owner, location: Location): Promise<void> {
      const tree = (await time.read(() => io.tree(owner.generation.pid, { verifyAncestry: true }))).descendants;
      const children = [...(capture?.children ?? [])];
      const members = new Map<number, Child>(), verified = new Set<number>();
      for (const member of tree) {
        if (!safePid(member.pid) || !knownText(member.startIdentity) || member.pid === owner.generation.pid || members.has(member.pid))
          throw new StopCheck(unavailable);
        let child = children.find(child => sameProcess(child, member));
        if (!child) {
          child = { pid: member.pid, startIdentity: member.startIdentity, kind: "unclassified" };
          children.push(child);
        }
        members.set(child.pid, child);
        if (member.ancestryVerified !== false) verified.add(child.pid);
        else if (child.kind !== "detached") child.kind = "unclassified";
      }
      // Retain sightings even if pi exits during verification. Until the
      // root and tree agree, newly seen processes are blockers, not targets.
      capture = { owner: owner.generation, terminal: owner.terminal ?? capture?.terminal ?? null, children };
      const { excluded, complete } = tree.length ? await inventory(tree) : { excluded: new Set<number>(), complete: true };
      for (const child of children) if (excluded.has(child.pid)) child.kind = "detached";
      if (!(await currentOwner(location)).owner || await gone(owner.generation))
        throw new StopCheck("Pi exited while its process tree was being checked.");
      if (complete) for (const child of members.values()) {
        if (child.kind !== "detached" && verified.has(child.pid)) child.kind = "verified";
      }
      save({ kind: "checking" });
    }
    async function recapture(location: Location): Promise<void> {
      const { owner } = await currentOwner(location);
      if (owner) await captureTree(owner, location);
    }
    async function canSignal(target: Identity | Child, location: Location): Promise<boolean> {
      const current = await currentOwner(location);
      const child = "kind" in target;
      if (child ? !current.terminalsKnown || !current.owner && !await gone(capture!.owner) : !current.owner) return false;
      if (child && current.owner) {
        const root = current.owner.generation.pid;
        const tree = await time.read(() => io.tree(root, { verifyAncestry: true, targetPid: target.pid })).catch(() => null);
        if (!tree?.descendants.some(member => member.ancestryVerified !== false && sameProcess(member, target))) {
          target.kind = "unclassified";
          save({ kind: "checking" });
          return false;
        }
        // Catch a replacement owner during the ancestry read. If pi exited,
        // the verified capture is the ancestry evidence for reparented work.
        const latest = await currentOwner(location);
        if (!latest.terminalsKnown || !latest.owner && !await gone(capture!.owner)) return false;
      }
      const state = await probe(target.pid);
      if (state.kind !== "live" || state.startIdentity !== target.startIdentity || !child && !state.pi) return false;
      await readHome();
      return true;
    }
    async function signalTargets(signal: Signal, location: Location): Promise<boolean> {
      if (!capture) return false;
      let sent = false;
      const targets = [capture.owner, ...capture.children.filter(verifiedChild)];
      for (const target of targets) {
        if (signal === "SIGTERM" && hard()) break;
        if ("kind" in target) {
          const { excluded, complete } = await inventory(capture.children);
          if (excluded.has(target.pid) || !complete) continue;
        }
        if (!await canSignal(target, location)) continue;
        if (signal === "SIGTERM" && hard()) break;
        try { await time.read(() => io.signal(target.pid, signal)); }
        catch (error) { if ((error as NodeJS.ErrnoException | null)?.code !== "ESRCH") throw error; }
        await guard();
        sent = true;
      }
      return sent;
    }
    async function waitFor(targets: readonly Identity[], until: number): Promise<void> {
      try {
        while (time.remaining(until) && !hard()) {
          let alive = false;
          for (const target of targets) if (!await gone(target, until)) { alive = true; break; }
          if (!alive || hard()) break;
          const ms = time.remaining(until);
          if (!ms) break;
          await time.read(() => io.pause(Math.min(probeMs, ms)), until);
          await guard(until);
        }
      } catch (error) { if (!(error instanceof WindowEnded)) throw error; }
      await guard();
    }
    async function proveAbsence(location: Location, recordBlockers: readonly StopBlocker[]): Promise<StopObservation> {
      const current = await currentOwner(location);
      if (current.owner || capture && !await gone(capture.owner))
        return save(pending("The verified pi process has not exited.", recordBlockers));
      const blockers = [...recordBlockers];
      if (!current.terminalsKnown) blockers.push(check("The labelled terminals could not be checked."));
      const runs = await time.read(() => work.settleRuns(id, async row => {
        const pid = row.pid;
        const birth = knownText(row.pid_start_time) ? row.pid_start_time : null;
        const endedAt = birthlessTerminalEnd(row);
        const p = pid === null ? { kind: "absent" } as const : endedAt === null
          ? await probe(pid) : await time.read(() => io.probe(pid, true));
        const absent = p.kind === "absent" || p.kind === "live" && (birth !== null ? p.startIdentity !== birth
          : endedAt !== null && p.startedAt !== undefined && p.startedAt - endedAt > processStartResolutionMs);
        if (!absent || await lockOwner(await inspect())) return false;
        // A lockless labelled pi cannot admit runs. Recheck all labels and
        // leases below before publishing absence, not for each historical row.
        await guard();
        return true;
      }));
      blockers.push(...runs);
      const survivors: Child[] = [];
      for (const child of capture?.children ?? []) if (!await gone(child)) survivors.push(child);
      const jobs = await time.read(() => work.inspect(id));
      blockers.push(...jobs.blockers);
      if (!jobs.complete && !jobs.blockers.length) blockers.push(check("Session work records could not be checked."));
      for (const child of survivors) {
        if (child.kind !== "detached" || !jobs.blockers.some(blocker => blocker.kind === "job"))
          blockers.push(check(`A captured process is still present or unverified (PID ${child.pid}).`));
      }
      const stillCarried: Identity[] = [];
      for (const identity of carried) if (!await gone(identity)) {
        stillCarried.push(identity);
        blockers.push(check(`A captured process is still present or unverified (PID ${identity.pid}).`));
      }
      carried = stillCarried;
      const latest = await currentOwner(location);
      if (latest.owner || !latest.terminalsKnown) blockers.push(check("The owner or labelled terminals are not verified absent."));
      if (blockers.length) return save(pending("Local session work has not been verified absent.", [...new Map(blockers.map(b => [JSON.stringify(b), b])).values()]));
      await time.read(() => work.freezeMembership(id, expected.epoch, guard));
      if (!await shortCheck()) return save(pending("New local evidence appeared while freezing membership."));
      return save({ kind: "confirmed", owner: capture?.owner ?? null });
    }
    async function enforceLocked(): Promise<StopObservation> {
      const recordBlockers: StopBlocker[] = [];
      try {
        await readInitialState();
        let prior: Proof | null = null;
        try { prior = readProof(db, expected, bootId!, "include-earlier"); }
        catch {
          proofUnreadable = true;
          recordBlockers.push(check("The local stop proof could not be read."));
        }
        const exact = prior && sameManagedHome(prior.home, expected);
        if (prior?.evidence.kind === "confirmed" && exact && await shortCheck().catch(() => false))
          return observation(prior.evidence, prior.observedAt);
        carried = prior?.carried ?? [];
        if (prior?.capture && prior.evidence.kind !== "confirmed") {
          if (exact) capture = prior.capture;
          else {
            // A new stopped epoch does not make the old tree disappear. Its
            // process identities can block exit, but cannot authorize a signal.
            const previous = [...carried, prior.capture.owner, ...prior.capture.children];
            carried = [...new Map(previous.map(({ pid, startIdentity }) => [JSON.stringify([pid, startIdentity]), { pid, startIdentity }])).values()];
          }
        }
        const displaced = expected.machineId !== machineId;
        let location: Location;
        try { location = locateRecords(options, id, displaced); }
        catch (error) {
          if (displaced) throw error;
          location = { file: null, cwd: null, local: true };
          recordBlockers.push(check("The local session placement could not be read."));
        }
        if (!location.local) throw new StopCheck("No prior local placement or membership is known for this displaced session.");
        await guard();
        save({ kind: "checking" });
        const first = await scanOwner(location);
        let waited = false;
        if (first.owner) {
          if (capture && !sameProcess(capture.owner, first.owner.generation)) {
            if (!await gone(capture.owner)) throw new StopCheck("The previous pi identity has not been verified absent.");
            for (const child of capture.children) if (!await gone(child)) throw new StopCheck("Work from a previous owner is still present.");
            capture = null;
          }
          if (capture?.terminal && first.owner.terminal && capture.terminal !== first.owner.terminal)
            throw new StopCheck("The verified owner's terminal labels changed.");
          await captureTree(first.owner, location);
          if (!hard() && first.owner.admitted && await canSignal(first.owner.generation, location) && !hard()) {
            const until = Math.min(time.end, clock.now() + graceMs);
            // The socket timeout covers transport; the independent deadline
            // below covers both a silent peer and an acknowledgement without exit.
            const { pid, startIdentity, bootId } = first.owner.generation;
            const timeout = Math.min(options.limits.controlMs, time.remaining(until));
            if (timeout) void io.shutdown({ id: `stop-${expected.epoch}`, machineId, expectedEpoch: expected.epoch, kind: "session-shutdown",
              args: { v0: true, sessionId: id, homeState: "stopped", homeMachineId: expected.machineId, owner: { pid, startIdentity, bootId } },
            }, timeout).catch(() => {});
            await waitFor([first.owner.generation], until);
            waited = true;
          }
        }
        if (capture && !hard()) {
          if (waited) await recapture(location);
          save({ kind: "checking" });
          waited = await signalTargets("SIGTERM", location);
          if (waited) await waitFor([capture.owner, ...capture.children.filter(verifiedChild)], clock.now() + graceMs);
        }
        if (capture) {
          if (waited) await recapture(location);
          await guard();
          save({ kind: "checking" });
          await signalTargets("SIGKILL", location);
        }
        return await proveAbsence(location, recordBlockers);
      } catch (error) {
        const evidence = pending(error instanceof StopCheck ? error.message : unavailable, recordBlockers);
        if (bootId && sameManagedHome(home, expected)) {
          try { return save(evidence); } catch { /* Do not replace proof for a different home. */ }
        }
        return observation(evidence);
      }
    }
    async function observe(): Promise<StopObservation> {
      try {
        await readInitialState();
        const prior = readProof(db, expected, bootId!);
        if (!prior) return observation(pending("No stop proof is recorded for this home and boot."));
        if (prior.evidence.kind === "confirmed") {
          if (!await shortCheck() || !isDeepStrictEqual(prior, readProof(db, expected, bootId!)))
            return observation(pending("New local evidence invalidates the stop confirmation."));
        }
        return observation(prior.evidence, prior.observedAt);
      } catch (error) { return observation(pending(error instanceof StopCheck ? error.message : unavailable)); }
    }
    try {
      return enforce ? await withSessionState(id, enforceLocked, time.signal) : await observe();
    } catch { return observation(pending("Another local session state change is in progress or could not be checked.")); }
    finally { time.cancel(); }
  }
  return { enforceStopped: (home: StoppedHome) => stoppedCheck(home, true), observeStopped: (home: StoppedHome) => stoppedCheck(home, false) };
}
