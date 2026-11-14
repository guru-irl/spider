import { lstatSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, readdir, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { assertTestConfigPath, openDbReadOnly } from "@spider/db-core";
import type { HcClient, TerminalAddress } from "@spider/herdr";
import type { HostingObservation } from "./hosting";
import type { HostIntent, Clock, Diagnostic } from "./contracts";
import { readLocal } from "@spider/db-core/roam/local-state";
import type { BoxLocalOrigin } from "./session-control";
import type { Probe, Readiness } from "@spider/db-core/roam/types";
import { createHcClient } from "@spider/herdr/client/hc";
import { bootIdChanged, inspectIdLock, localBootId } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases, type ProcessInventoryPorts, type ProcessProbe } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import { createIntentStore } from "./intent";
import { createExactLaunchAdapter, createProductionLocalExactHc } from "./launcher";
import { createLocalDiagnosticPorts } from "./local-diagnostics";
import { loadHerdrConfig } from "./production-hub";
import { createParticipantSupervisor } from "./participant-supervisor";
import { openLocalRuntime, readLocalIdentity } from "./runtime";
import { assertBoxEnrollment, participantCaptureInitialized, createRunningIntentAuthority, readReadiness } from "./session-control";
import { observeHosting } from "./hosting";
import { readPrivateBytes } from "./selected-files";

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
export async function startProductionSupervisor(root: string, options: { system?: SupervisorSystemPorts; clock?: Clock } = {}): Promise<{ stop(): Promise<void> }> {
  const enrolled = readLocalIdentity(root);
  assertBoxEnrollment(enrolled);
  if (!participantCaptureReady(root, enrolled.machineId)) {
    let active: { stop(): Promise<void> } | undefined, closed = false, checking: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (closed || checking || active) return;
      checking = (async () => { const current = readLocalIdentity(root); assertBoxEnrollment(current); if (participantCaptureReady(root, current.machineId)) active = await startProductionSupervisor(root, options); })()
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
    const observer = createHcClient({ binary: herdr.core.binary, env: process.env });
    let core;
    try { core = await observer.identity(); } finally { await observer.dispose(); }
    const env: Readonly<NodeJS.ProcessEnv> = Object.freeze({ ...process.env, HC_SESSION: core.sessionNamespace, HC_SOCKET: core.socket,
      SPIDER_GLOBAL_ROOT: root, PI_CODING_AGENT_DIR: herdr.agentDirectory });
    const hc = createProductionLocalExactHc({ binary: herdr.core.binary, env, probe: pid => system.inventory.probe(pid) }); dispose = () => hc.dispose();
    const eventClient = createHcClient({ binary: herdr.core.binary, env });
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
    const supervisor = createParticipantSupervisor({ root, agent: runtime.agent, clock, diagnostics,
      async identityCurrent() { const current = readLocalIdentity(root); return current.role === "box" && current.machineId === runtime.config.machineId && current.hubMachineId === runtime.config.hubMachineId && participantCaptureReady(root, current.machineId); },
      events: createSupervisorEvents(runtime.db.raw.name, eventClient),
      owner: intent => owner(root, intent, system),
      async launch(intent, operationId, mode) {
        const currentCore = await hc.coreId(new AbortController().signal);
        const bytes = await readFile(intent.file), absolutePi = env.SPIDER_ROAM_PI;
        if (!absolutePi || !isAbsolute(absolutePi)) throw new Error("provisioned-pi-unavailable");
        const adapter = createExactLaunchAdapter({ journal: runtime.journal, hc,
          clock: { now: clock.now, async wait(ms, signal) { await new Promise<void>((done, reject) => { const timer = setTimeout(done, ms); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true }); }); } },
          base: { leases: system.inventory.leases, processInventory: system.inventory, processIdentity: { pid: process.pid, startIdentity: identity.startIdentity },
            env, machineId: runtime.config.machineId, core: { coreId: currentCore, session: env.HC_SESSION ?? "", socket: env.HC_SOCKET ?? "" },
            bootId: system.bootId, limits: system.limits, shell: "/bin/sh", sessionBytes: runtime.config.limits.sessionBytes } });
        await adapter.launch({ sessionId: intent.sessionId, file: intent.file, cwd: intent.cwd, epoch: intent.epoch, moveId: intent.moveId,
          pi: absolutePi, sha256: createHash("sha256").update(bytes).digest("hex"), operationId }, { mode: mode === "initial" ? "fresh" : "reconcile" });
        const ready = readReadiness(runtime.journal, operationId);
        return { code: ready ? 0 : 3, reason: ready ? "ready" : "readiness-pending", operationId, home: null, epoch: intent.epoch, repairCommand: null, value: ready };
      },
      async stop(id) {
        const intent = await createRunningIntentAuthority(runtime.db).get(id); if (!intent) return { kind: "uncertain" };
        const observed = await owner(root, intent, system);
        if (observed.kind === "live") process.kill(observed.identity.pid, "SIGTERM");
        return owner(root, intent, system);
      },
      async notify() { /* Suspension is persisted by the supervisor and collected by the hub observer. */ },
    });
    let release!: () => void;
    const held = new Promise<void>(done => { release = done; });
    let ready!: () => void, fail!: (error: unknown) => void;
    const started = new Promise<void>((done, reject) => { ready = done; fail = reject; });
    const lock = withProcessLock(join(root, "roam"), "roam-supervisor", async () => {
      supervisor.start(); ready(); await held; await supervisor.stop();
    }, { identity: { pid: process.pid, startIdentity: identity.startIdentity }, probe: pid => system.inventory.probe(pid) });
    void lock.catch(fail);
    await started;
    let stopping: Promise<void> | undefined;
    return { stop() { return stopping ??= (async () => { release(); try { await lock; } finally { await dispose?.(); runtime.close(); } })(); } };
  } catch (error) { await dispose?.(); runtime.close(); throw error; }
}
