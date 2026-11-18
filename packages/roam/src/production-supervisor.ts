import { createPendingHandoffControl, pendingHandoffLifecycle } from "./pending-handoff";
import { machineMoveEvidence } from "./machine-move-evidence";
import { openFreezeJournal } from "./journal";
import { lstatSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, readdir, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { assertTestConfigPath, openDbReadOnly } from "@spider/db-core";
import type { HcClient, TerminalAddress } from "@spider/herdr";
import type { HostingObservation } from "./hosting";
import type { HostIntent, Clock, Diagnostic, IntercomLifecycle } from "./contracts";
import { readLocal } from "@spider/db-core/roam/local-state";
import type { BoxLocalOrigin } from "./session-control";
import type { Probe, Readiness } from "@spider/db-core/roam/types";
import { createHcClient } from "@spider/herdr/client/hc";
import { bootIdChanged, inspectIdLock, localBootId } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases, type ProcessIdentity, type ProcessInventoryPorts, type ProcessProbe } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import { createIntentStore } from "./intent";
import { createExactLaunchAdapter, createProductionLocalExactHc } from "./launcher";
import { createLocalDiagnosticPorts } from "./local-diagnostics";
import { loadHerdrConfig } from "./production-hub";
import { createParticipantSupervisor, retireParticipantSessions, supervisorRetirementLifecycle } from "./participant-supervisor";
import { openLocalRuntime, readLocalIdentity } from "./runtime";
import { assertBoxEnrollment, participantCaptureInitialized, createRunningIntentAuthority, readReadiness } from "./session-control";
import { createNativeHostingOutcomeReader, observeHosting } from "./hosting";
import { readPrivateBytes } from "./selected-files";
import { createMachineIntercom } from "./intercom-runtime";
import { createProductionIntercomMaintenance } from "./intercom-production";
import type { LocalPairPorts } from "./intercom-local-ops";
import { createTransport } from "./transport";
import { invokeCli as invokeCoreCli } from "@spider/herdr/client/cli-transport";
import { HerdrError, parseCore } from "@spider/herdr/client/parse";
import { requireCoreAvailable } from "@spider/herdr/client/liveness";

import { readSupervisorCorePin, supervisorCoreEnvironment, type SupervisorCorePin } from "./enrollment";
export interface SupervisorCore {
  pin: SupervisorCorePin; identity: import("@spider/herdr").CoreIdentity; pid: number; env: Readonly<NodeJS.ProcessEnv>;
}
function coreReply(value: unknown, pin: SupervisorCorePin, env: Readonly<NodeJS.ProcessEnv>) {
  const identity = parseCore(value, env);
  if (identity.coreId !== pin.coreId) throw new HerdrError("core-pin-changed", "The enrolled core identity has changed; stop hosting and run spider roam provision <machine> --replace-core-pin on the hub");
  const pid = (value as { pid?: unknown }).pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new HerdrError("core-unavailable", "Core process identity is unavailable");
  return { identity, pid };
}
/** This is the only supervisor call allowed to start a stopped core. */
export async function ensureSupervisorCore(pin: SupervisorCorePin, base: Readonly<NodeJS.ProcessEnv>): Promise<SupervisorCore> {
  for (const file of [pin.socket, pin.stateHome, pin.configHome]) assertTestConfigPath(file);
  const env = supervisorCoreEnvironment(pin, base);
  await invokeCoreCli(pin.binary, ["server", "start", "--json"], env, 64 * 1024);
  const reply = await invokeCoreCli(pin.binary, ["server", "status", "--json"], env, 64 * 1024);
  return { pin, env, ...coreReply(reply, pin, env) };
}
class CoreProcessReplaced extends HerdrError {
  constructor() { super("core-lost", "The hosting core process was replaced"); }
}
/** Do not let a health check auto-start a core after hosting has lost it. */
export async function assertSupervisorCoreCurrent(core: SupervisorCore, signal?: AbortSignal): Promise<void> {
  try {
    await requireCoreAvailable(core.env, signal);
    const reply = await invokeCoreCli(core.pin.binary, ["server", "status", "--json"], core.env, 64 * 1024, undefined, { signal });
    if (coreReply(reply, core.pin, core.env).pid !== core.pid) throw new CoreProcessReplaced();
  } catch (error) {
    if (error instanceof CoreProcessReplaced || error instanceof HerdrError && error.code === "core-pin-changed") throw error;
    throw new HerdrError("core-lost", "The hosting core was lost; the supervisor must restart");
  }
}

const supervisorClock: Clock = { now: () => Date.now(), later(ms, fn) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
type CoreLoss = "core-lost" | "core-pin-changed";
export interface CoreBoundSupervisor { stop(): Promise<void>; failed: Promise<CoreLoss> }
/** Startup may ensure the core; monitoring may only observe it and retire hosting. */
export async function startCoreBoundSupervisor(pin: SupervisorCorePin, env: Readonly<NodeJS.ProcessEnv>,
  startHosting: (core: SupervisorCore) => Promise<{ stop(): Promise<void> }>, clock: Clock = supervisorClock): Promise<CoreBoundSupervisor> {
  const core = await ensureSupervisorCore(pin, env), hosting = await startHosting(core);
  let closed = false, failures = 0, cancel: (() => void) | undefined, checking: Promise<void> | undefined, stopping: Promise<void> | undefined;
  const controller = new AbortController();
  let failed!: (reason: CoreLoss) => void;
  const failure = new Promise<CoreLoss>(done => { failed = done; });
  const stop = (): Promise<void> => stopping ??= (async () => {
    closed = true; cancel?.(); controller.abort();
    try { await checking; } finally { await hosting.stop(); }
  })();
  function schedule(): void {
    cancel = clock.later(10_000, () => {
      checking = (async () => {
        try { await assertSupervisorCoreCurrent(core, controller.signal); failures = 0; }
        catch (error) {
          const changed = error instanceof HerdrError && error.code === "core-pin-changed";
          if (!closed && (changed || error instanceof CoreProcessReplaced || ++failures >= 3)) {
            const reason: CoreLoss = changed ? "core-pin-changed" : "core-lost";
            void stop().then(() => failed(reason), () => failed(reason));
          }
        } finally { if (!closed) schedule(); }
      })();
    });
  }
  schedule();
  return { stop, failed: failure };
}

export function createSupervisorEvents(databaseFile: string, core: Pick<HcClient, "events">): { subscribe(listener: () => void): () => void } {
  return { subscribe(listener) {
    const stream = core.events();
    let unsubscribe: () => void;
    try { unsubscribe = stream.subscribe(event => { if (event.type !== "heartbeat") listener(); }); }
    catch (error) { stream.dispose(); throw error; }
    const directory = dirname(databaseFile), names = [basename(databaseFile), `${basename(databaseFile)}-wal`];
    const files = new Map<string, ReturnType<typeof watch>>();
    let closed = false, directoryWatcher: ReturnType<typeof watch> | undefined;
    function arm(name: string): void {
      files.get(name)?.close(); files.delete(name);
      if (closed) return;
      try {
        const watcher = watch(join(directory, name), { persistent: false }, event => {
          if (closed) return;
          if (event === "rename") arm(name);
          listener();
        });
        files.set(name, watcher);
        watcher.on("error", () => { if (files.get(name) === watcher) { files.delete(name); watcher.close(); } if (!closed) listener(); });
      } catch { /* A missing WAL is watched when the directory reports its creation. */ }
    }
    for (const name of names) arm(name);
    try {
      directoryWatcher = watch(directory, { persistent: false }, (event, file) => {
        if (closed) return;
        const name = file?.toString();
        if (name && !names.includes(name)) return;
        if (event === "rename" || !name) for (const target of names) arm(target);
        listener();
      });
      directoryWatcher.on("error", () => { directoryWatcher?.close(); if (!closed) listener(); });
    } catch { /* The periodic sweep still reconciles if file notifications are unavailable. */ }
    return () => { closed = true; directoryWatcher?.close(); for (const watcher of files.values()) watcher.close(); unsubscribe(); stream.dispose(); };
  } };
}

export interface SupervisorSystemPorts {
  shell?: string;
  bootId(): Promise<string>;
  limits(): Promise<{ soft: number; hard: number }>;
  inventory: ProcessInventoryPorts;
}
export function productionSupervisorSystem(root: string, machineId: string): SupervisorSystemPorts {
  const local = { machineId, label: "local machine", peer: null }, diagnostic = createLocalDiagnosticPorts(root, []);
  const probe = (pid: number) => diagnostic.probeProcess(local, pid);
  const inventory: ProcessInventoryPorts = { presence: createProcessPresence(join(root, "herdr")), leases: createSessionLeases(join(root, "herdr")), probe,
    async processes() {
      if (process.platform !== "linux") throw new Error("Linux hosting inventory required");
      const rows = [];
      for (const entry of await readdir("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const exe = await readlink(`/proc/${entry}/exe`), title = (await readFile(`/proc/${entry}/comm`, "utf8")).trim();
          if (!/(?:^|\/)pi$/.test(exe) && title !== "pi") continue;
          const observed = await probe(Number(entry));
          rows.push({ pid: Number(entry), startIdentity: observed.kind === "live" ? observed.startIdentity : null, classification: "pi" as const });
        } catch { /* A process may exit during enumeration. Presence and locks are checked separately. */ }
      }
      return rows;
    } };
  return { inventory,
    async bootId() {
      if (process.env.SPIDER_TEST_FIXTURE_CHECKOUT) {
        const file = process.env.SPIDER_TEST_ROAM_BOOT_ID ?? join(root, "roam", "fixture-boot-id");
        assertTestConfigPath(file); return (await readFile(file, "utf8")).trim();
      }
      return localBootId();
    },
    async limits() {
      if (process.env.SPIDER_TEST_FIXTURE_CHECKOUT) throw new Error("Fixture limit port required");
      const contents = await readFile("/proc/self/limits", "utf8"), match = /^Max open files\s+(\S+)\s+(\S+)/m.exec(contents);
      if (!match) throw new Error("Open-file limits unavailable");
      const number = (value: string) => value === "unlimited" ? Infinity : Number(value);
      return { soft: number(match[1]), hard: number(match[2]) };
    } };
}
async function owner(root: string, intent: HostIntent, system: SupervisorSystemPorts): Promise<Probe> {
  const lock = await inspectIdLock(join(root, "herdr"), intent.sessionId);
  if (!lock) return { kind: "absent" };
  if (lock.pendingOperationId) return { kind: "absent" };
  const bootId = await system.bootId(); if (!bootId || !lock.bootId) return { kind: "uncertain" };
  if (bootIdChanged(lock.bootId, bootId)) return { kind: "absent" };
  const probe = await system.inventory.probe(lock.identity.pid);
  if (probe.kind === "absent") return { kind: "absent" };
  if (probe.kind !== "live" || probe.startIdentity !== lock.identity.startIdentity) return { kind: "uncertain" };
  return { kind: "live", identity: { bootId, pid: lock.identity.pid, startTime: probe.startIdentity } };
}

/** Stop only the same proved owner; a replacement receives its own grace period. */
export function createBoundedStop(input: {
  now(): number; stopToken(id: string): Promise<string | null>; observe(id: string): Promise<Probe>;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}): { stop(id: string): Promise<Probe>; cancel(id: string): void } {
  const pending = new Map<string, { identity: Extract<Probe, { kind: "live" }>["identity"]; at: number; stopToken: string }>();
  const same = (left: Extract<Probe, { kind: "live" }>["identity"], right: Extract<Probe, { kind: "live" }>["identity"]) =>
    left.bootId === right.bootId && left.pid === right.pid && left.startTime === right.startTime;
  return {
    cancel(id) { pending.delete(id); },
    async stop(id) {
      const stopToken = await input.stopToken(id);
      if (!stopToken) { pending.delete(id); return { kind: "uncertain" }; }
      const observed = await input.observe(id);
      if (observed.kind !== "live") { if (observed.kind === "absent") pending.delete(id); return observed; }
      const now = input.now(), prior = pending.get(id);
      const fresh = !prior || prior.stopToken !== stopToken || !same(prior.identity, observed.identity) || now < prior.at;
      if (fresh || now - prior.at >= 30_000) {
        if (await input.stopToken(id) !== stopToken) { pending.delete(id); return { kind: "uncertain" }; }
        const confirmed = await input.observe(id);
        if (confirmed.kind !== "live" || !same(confirmed.identity, observed.identity)) { pending.delete(id); return confirmed; }
        if (await input.stopToken(id) !== stopToken) { pending.delete(id); return { kind: "uncertain" }; }
        try { input.signal(confirmed.identity.pid, fresh ? "SIGTERM" : "SIGKILL"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          pending.delete(id); return input.observe(id);
        }
        if (fresh) pending.set(id, { identity: confirmed.identity, at: now, stopToken });
      }
      return input.observe(id);
    },
  };
}

export async function observeLocalHosting(root: string, options: { system?: SupervisorSystemPorts } = {}): Promise<HostingObservation> {
  const runtime = openLocalRuntime(root);
  let hc: ReturnType<typeof createHcClient> | undefined;
  try {
    assertBoxEnrollment(runtime.config);
    if (!participantCaptureInitialized(runtime.db, runtime.config.machineId, "global")) return { readiness: [], suspensions: [] };
    const herdr = loadHerdrConfig(root), system = options.system ?? productionSupervisorSystem(root, runtime.config.machineId);
    const client = createHcClient({ binary: herdr.core.binary, env: process.env }); hc = client;
    return await observeHosting({ db: runtime.db, journal: runtime.journal, authority: createRunningIntentAuthority(runtime.db), intents: createIntentStore(root),
    machineId: runtime.config.machineId, hubMachineId: runtime.config.hubMachineId,
    terminalOutcome: createNativeHostingOutcomeReader(client),
    async live(ready) {
      const authoritative = await createRunningIntentAuthority(runtime.db).get(ready.sessionId);
      const intent: HostIntent = authoritative ?? { sessionId: ready.sessionId, epoch: ready.epoch, file: ready.file, cwd: ready.cwd, desired: "running", suspended: null, moveId: null };
      if ((await owner(root, intent, system)).kind !== "live") return false;
      const lock = await inspectIdLock(join(root, "herdr"), ready.sessionId);
      if (ready.origin === "hub-operation" && lock?.operationId !== ready.opId) return false;
      if (ready.origin === "box-local") {
        const origin = readLocal<BoxLocalOrigin>(runtime.db, "participant-origin", ready.sessionId);
        if (!origin || origin.pid !== lock?.identity.pid || origin.startIdentity !== lock.identity.startIdentity) return false;
      }
      const before = await client.identity(), terminal = await client.get(ready.terminal as TerminalAddress), after = await client.identity();
      return before.coreId === ready.core && after.coreId === ready.core && terminal.state === "live";
    } });
  } finally { await hc?.dispose(); runtime.close(); }
}

export function participantCaptureReady(root: string, machineId?: string): boolean {
  const file = join(root, "spider.db"); assertTestConfigPath(file);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
    const db = openDbReadOnly(file); if (!db) return false;
    try {
      const meta = db.prepare("SELECT machine_id FROM roam_meta WHERE id=1").get() as { machine_id: unknown } | undefined;
      return typeof meta?.machine_id === "string" && Boolean(meta.machine_id) && participantCaptureInitialized(db, machineId ?? meta.machine_id, "global");
    } finally { db.close(); }
  } catch { return false; }
}
export async function runLockedSupervisor(input: {
  root: string; identity: ProcessIdentity; probe(pid: number): Promise<ProcessProbe>;
  supervisor: { start(): void; stop(): Promise<void> }; intercom?: IntercomLifecycle;
}): Promise<{ stop(): Promise<void> }> {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  let ready!: () => void, fail!: (error: unknown) => void;
  const started = new Promise<void>((done, reject) => { ready = done; fail = reject; });
  const lock = withProcessLock(join(input.root, "roam"), "roam-supervisor", async () => {
    let supervisorStarted = false;
    try {
      await input.intercom?.start();
      supervisorStarted = true; input.supervisor.start();
      ready(); await held;
    } finally {
      try { if (supervisorStarted) await input.supervisor.stop(); } finally { await input.intercom?.stop(); }
    }
  }, { identity: input.identity, probe: input.probe, timeoutMs: 100 });
  void lock.catch(fail);
  await started;
  let stopping: Promise<void> | undefined;
  return { stop() { return stopping ??= (async () => { release(); await lock; })(); } };
}

export function createProductionSupervisorConnection(input: { root: string; config: import("./contracts").RoamConfig; globalDb: import("@spider/db-core").Db;
  transport: import("./contracts").Transport; stopSessions(): Promise<void> }): NonNullable<import("./supervisor").SupervisorPorts["connection"]> {
  const { config, globalDb } = input;
  return { machineId: config.machineId, stopSessions: input.stopSessions, async sync() { /* Boxes never initiate metadata replication. */ }, async handshake() {
    if (readLocal(globalDb, "supervisor-revoked", config.machineId)) return { kind: "retire-only", reason: "machine-revoked", machineId: config.machineId };
    // The hub pushes revocation durably. An offline hub never stops an active home.
    return { kind: "accepted", reason: "ok", machineId: config.machineId };
  } };
}

export async function startProductionSupervisor(root: string, options: { system?: SupervisorSystemPorts; clock?: Clock;
  intercomLocalPorts?: Omit<LocalPairPorts, "enrollBridge" | "inspectBridge" | "inspectFence"> } = {}): Promise<CoreBoundSupervisor> {
  assertBoxEnrollment(readLocalIdentity(root));
  return startCoreBoundSupervisor(readSupervisorCorePin(root), process.env, coreState => startEnrolledSupervisor(root, { ...options, coreState }), options.clock);
}

async function startEnrolledSupervisor(root: string, options: { coreState: SupervisorCore; system?: SupervisorSystemPorts; clock?: Clock;
  intercomLocalPorts?: Omit<LocalPairPorts, "enrollBridge" | "inspectBridge" | "inspectFence"> }): Promise<{ stop(): Promise<void> }> {
  const enrolled = readLocalIdentity(root);
  assertBoxEnrollment(enrolled);
  const platform = options.intercomLocalPorts;
  if (platform && (platform.root !== root || platform.machineId !== enrolled.machineId)) throw new Error("machine-mismatch");
  if (!participantCaptureReady(root, enrolled.machineId)) {
    let active: { stop(): Promise<void> } | undefined, closed = false, checking: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (closed || checking || active) return;
      checking = (async () => { const current = readLocalIdentity(root); assertBoxEnrollment(current); if (participantCaptureReady(root, current.machineId)) active = await startEnrolledSupervisor(root, options); })()
        .catch(() => undefined).finally(() => { checking = undefined; });
    }, 1000);
    return { async stop() { closed = true; clearInterval(timer); await checking; await active?.stop(); } };
  }
  const runtime = openLocalRuntime(root);
  let dispose: (() => Promise<void>) | undefined;
  try {
    assertBoxEnrollment(runtime.config);
    if (!options.system && process.platform !== "linux") throw new Error("hosting-platform-unsupported");
    const herdr = loadHerdrConfig(root), system = options.system ?? productionSupervisorSystem(root, runtime.config.machineId);
    const identity = await system.inventory.probe(process.pid);
    if (identity.kind !== "live") throw new Error("process-identity-unavailable");
    const core = options.coreState.identity;
    const env: Readonly<NodeJS.ProcessEnv> = Object.freeze({ ...options.coreState.env, HC_SESSION: core.sessionNamespace, HC_SOCKET: core.socket,
      SPIDER_GLOBAL_ROOT: root, PI_CODING_AGENT_DIR: herdr.agentDirectory });
    const hc = createProductionLocalExactHc({ binary: options.coreState.pin.binary, env, probe: pid => system.inventory.probe(pid) }); dispose = () => hc.dispose();
    const eventClient = createHcClient({ binary: options.coreState.pin.binary, env });
    dispose = async () => { await Promise.all([hc.dispose(), eventClient.dispose()]); };
    const clock = options.clock ?? { now: () => Date.now(), later(ms: number, fn: () => void) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
    const diagnostics = async (intent: HostIntent): Promise<readonly Diagnostic[]> => {
      try {
        const auth = readPrivateBytes(herdr.agentDirectory, "auth.json", runtime.config.limits.agentBytes);
        if (!auth) throw new Error("missing-auth");
        try { const parsed = JSON.parse(auth.toString("utf8")); if (!parsed || typeof parsed !== "object" || !Object.keys(parsed).length) throw new Error("missing-auth"); }
        finally { auth.fill(0); }
        const file = await readFile(intent.file); if (!file.length) throw new Error("session-file-invalid");
        return [];
      } catch { return [{ severity: "block", reason: "Hosting prerequisites need review", repairCommand: null }]; }
    };
    const authority = createRunningIntentAuthority(runtime.db);
    const stop = createBoundedStop({ now: clock.now, async stopToken(id) { return authority.stopToken(id); },
      async observe(id) {
        const intent = await authority.get(id);
        return intent?.desired === "stopped" ? owner(root, intent, system) : { kind: "uncertain" };
      },
      signal(pid, signal) { process.kill(pid, signal); },
    });
    const hosting = { db: runtime.db, journal: runtime.journal, authority, intents: createIntentStore(root),
      machineId: runtime.config.machineId, hubMachineId: runtime.config.hubMachineId,
      // Owner liveness is probed separately; every inspection must classify the execution terminal.
      live: async () => false, terminalOutcome: createNativeHostingOutcomeReader(eventClient) };
    const stopSessions = () => retireParticipantSessions(runtime.agent, stop.stop);
    const recoveryTransport = createTransport({ binary: options.coreState.pin.binary, env, enrolled: runtime.config.peers });
    const connection = createProductionSupervisorConnection({ root, config: runtime.config, globalDb: runtime.db, transport: recoveryTransport, stopSessions });
    const supervisor = createParticipantSupervisor({ root, agent: runtime.agent, clock, diagnostics, connection,
      async identityCurrent() { const current = readLocalIdentity(root); return current.role === "box" && current.machineId === runtime.config.machineId && current.hubMachineId === runtime.config.hubMachineId && participantCaptureReady(root, current.machineId); },
      events: createSupervisorEvents(runtime.db.raw.name, eventClient),
      async beforeInspect(sessionId) { await observeHosting({ ...hosting, sessionId }); },
      owner: intent => owner(root, intent, system),
      async launch(intent, operationId, mode) {
        const currentCore = await hc.coreId(new AbortController().signal);
        const bytes = await readFile(intent.file), absolutePi = env.SPIDER_ROAM_PI;
        if (!absolutePi || !isAbsolute(absolutePi)) throw new Error("provisioned-pi-unavailable");
        const adapter = createExactLaunchAdapter({ journal: runtime.journal, hc,
          clock: { now: clock.now, async wait(ms, signal) { await new Promise<void>((done, reject) => { const timer = setTimeout(done, ms); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true }); }); } },
          base: { leases: system.inventory.leases, processInventory: system.inventory, processIdentity: { pid: process.pid, startIdentity: identity.startIdentity },
            env, machineId: runtime.config.machineId, core: { coreId: currentCore, session: env.HC_SESSION ?? "", socket: env.HC_SOCKET ?? "" },
            bootId: system.bootId, limits: system.limits, shell: system.shell ?? "/bin/sh", sessionBytes: runtime.config.limits.sessionBytes } });
        const launched = await adapter.launch({ sessionId: intent.sessionId, file: intent.file, cwd: intent.cwd, epoch: intent.epoch, moveId: intent.moveId,
          pi: absolutePi, sha256: createHash("sha256").update(bytes).digest("hex"), operationId }, { mode: mode === "initial" ? "fresh" : "reconcile" });
        if ("kind" in launched && launched.kind === "adopted-exited") {
          return { code: 1, reason: "adopted-exited", operationId, home: null, epoch: intent.epoch, repairCommand: null, value: null };
        }
        const ready = readReadiness(runtime.journal, operationId);
        return { code: ready ? 0 : 3, reason: ready ? "ready" : "readiness-pending", operationId, home: null, epoch: intent.epoch, repairCommand: null, value: ready };
      },
      stop: stop.stop, cancelStop: stop.cancel,
      async confirmExit(previous) {
        const current = await system.inventory.probe(previous.pid);
        return current.kind === "absent" || current.kind === "live" && current.startIdentity !== previous.startTime;
      },
      async notify() { /* Suspension is persisted by the supervisor and collected by the hub observer. */ },
    });
    if (platform && platform.machineId !== runtime.config.machineId) throw new Error("machine-mismatch");
    const localPorts = platform && { machineId: platform.machineId, root: platform.root, home: platform.home, node: platform.node,
      ssh: platform.ssh, keygen: platform.keygen, keyscan: platform.keyscan, sshUser: platform.sshUser, recipe: platform.recipe,
      systemctl: platform.systemctl, run: platform.run, process: platform.process, cgroup: platform.cgroup };
    const direct = runtime.config.intercom.routes.filter(route => route.kind === "direct").map(route => route.peer);
    const machineIntercom = runtime.config.intercom.enabled ? createMachineIntercom({ root, globalDb: runtime.db, config: runtime.config, roamingEnabled: () => readLocalIdentity(root).enabled,
      ...machineMoveEvidence({ db: runtime.db, config: runtime.config, journal: openFreezeJournal(join(root, "roam", "journal.db")), transport: createTransport({ binary: options.coreState.pin.binary, env, enrolled: runtime.config.peers }) }),
      agentDir: herdr.agentDirectory, clock, env, directPeers: direct, transport: createTransport({ binary: options.coreState.pin.binary, env, enrolled: direct }),
      ...createProductionIntercomMaintenance({ root, config: runtime.config, binary: options.coreState.pin.binary, env, localPorts }) }) : undefined;
    const intercom = supervisorRetirementLifecycle(root, runtime.config, stopSessions, pendingHandoffLifecycle(root, createPendingHandoffControl({ root: join(root, "herdr"), journal: runtime.journal,
      authority, inventory: system.inventory, identity: { pid: process.pid, startIdentity: identity.startIdentity }, bootId: system.bootId }), machineIntercom));
    const running = await runLockedSupervisor({ root, supervisor, intercom,
      identity: { pid: process.pid, startIdentity: identity.startIdentity }, probe: pid => system.inventory.probe(pid) });
    let stopping: Promise<void> | undefined;
    return { stop() { return stopping ??= (async () => { try { await running.stop(); } finally { await dispose?.(); runtime.close(); } })(); } };
  } catch (error) { await dispose?.(); runtime.close(); throw error; }
}
