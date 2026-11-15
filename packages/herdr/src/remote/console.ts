// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { HERDR_KINDS, HERDR_LABELS, type Disposable, type HcClient, type JobHandle, type JobPort, type MachineName, type Owner, type PreparedProgram, type RemoteSource, type RunId, type RuntimeTarget, type TerminalHandle, type TerminalSummary } from '../contracts.js';
import { encodeRuntimePublication, parseRuntimePublication, type ConsoleCommand } from './runtime.js';
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrError } from '../client/parse.js';
import { createCleanupSweep } from '../jobs/cleanup.js';
import { herdrErrorNotice } from '../notices.js';

export type AgentConsoleOwner = Owner & { runId?: RunId };
export interface AgentConsoleLaunch {
  owner: Owner; on: MachineName; target: RuntimeTarget; source: RemoteSource; job?: JobHandle;
  startedAt?: number; enabled?: boolean; kind?: Parameters<JobPort['start']>[3]['kind'];
  isConsoleIdle?(): Promise<boolean>; reportError?(error: unknown): void;
}
export interface AgentConsoleLifecyclePorts {
  hc: HcClient; currentOwner(ctx: ExtensionContext): Owner | null; env?: Readonly<NodeJS.ProcessEnv>;
  ownerIsLive?(console: TerminalSummary): Promise<boolean | null>;
  runIsLive?(console: TerminalSummary): Promise<boolean | null>;
  /** False keeps a crashed child's console open until its foreground cleanup is confirmed. */
  beforeReap?(console: TerminalSummary): Promise<boolean>;
  subscribeRunEnds?(owner: Owner, listener: (runId: RunId) => void): () => void;
  reportError?(error: unknown): void;
  reportCleanupError?(error: unknown): void;
}
export interface AgentConsoleHandle extends TerminalHandle { directory: string }
export interface AgentConsoleStart extends AgentConsoleLaunch {
  program: () => Promise<PreparedProgram>; jobs: JobPort & { consoleIdle?(owner: Owner, on: MachineName, runId?: RunId): Promise<boolean>; consoleError?(error: unknown): void }; hc: HcClient; options: Parameters<JobPort['start']>[3];
}
interface ConsoleState { owner: AgentConsoleOwner; handle: AgentConsoleHandle; directory: string; count: number }
const queues = new Map<string, Promise<unknown>>();
const consoles = new Map<string, ConsoleState>();
const endedAgents = new Set<string>();
const agentKey = (owner: AgentConsoleOwner) => JSON.stringify([owner.sessionId, owner.runId ?? null]);
const consoleKey = (owner: AgentConsoleOwner, on: MachineName) => JSON.stringify([agentKey(owner), on]);
function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}
function missing(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  return e.code === 'not_found' || e.code === 'ENOENT' || (e.code === 'invalid_params' && !!e.message?.startsWith('ENOENT:'));
}
function consoleMissing(error: unknown): boolean {
  return (error as { code?: string })?.code === 'not_found';
}
async function snapshot(hc: HcClient): Promise<readonly TerminalSummary[]> {
  const events = hc.events(); let off = () => {}; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<readonly TerminalSummary[]>((resolve, reject) => {
      timer = setTimeout(() => reject(new HerdrError('console-snapshot-timeout', 'Console inventory did not become ready')), 5000);
      off = events.subscribe(event => { if (event.type === 'snapshot' || event.type === 'missed') resolve(event.terminals); });
      void events.ready.catch(reject);
    });
  } finally { if (timer) clearTimeout(timer); off(); await events.dispose(); }
}
function ownsConsole(terminal: TerminalSummary, owner: AgentConsoleOwner, on?: MachineName): boolean {
  const labels = terminal.labels;
  return labels[HERDR_LABELS.kind] === HERDR_KINDS.remoteConsole && labels[HERDR_LABELS.session] === owner.sessionId &&
    (labels[HERDR_LABELS.run] ?? undefined) === owner.runId && (on === undefined || labels[HERDR_LABELS.machine] === on);
}
async function confirmConsoleMissing(hc: HcClient, address: TerminalSummary['address'], expectedMachine?: string): Promise<void> {
  const slash = address.lastIndexOf('/');
  if (slash < 0) throw new HerdrError('machine-unavailable', 'Console cleanup requires a qualified remote address');
  const name = address.slice(0, slash), machines = await hc.machines();
  if (!machines.some(machine => {
    const matches = (value: string) => machine.name === value || machine.aliases.includes(value);
    return machine.state === 'connected' && matches(name) && (!expectedMachine || matches(expectedMachine));
  })) throw new HerdrError('machine-unavailable', 'Console cleanup requires the connected destination');
  try { await hc.get(address); }
  catch (error) { if (consoleMissing(error)) return; throw error; }
  throw new HerdrError('console-outcome-unknown', 'Console terminal is still present');
}
async function commandCount(hc: HcClient, on: MachineName, directory: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (true) {
    let bytes: Buffer;
    try { bytes = await hc.fileRead(on, join(directory, 'head.json')); }
    catch (error) { if (missing(error)) return 0; throw error; }
    try {
      if (bytes.length > 1024) throw new HerdrError('console-head-invalid', 'Console head exceeded its bound');
      const head = parseRuntimePublication(bytes);
      if (head.version !== 1 || !Number.isSafeInteger(head.count) || (head.count as number) < 0) throw new HerdrError('console-head-invalid', 'Console head is invalid');
      return head.count as number;
    } catch (error) { if (Date.now() >= deadline) throw error; await delay(25); }
  }
}
async function waitForHeartbeat(hc: HcClient, on: MachineName, directory: string, instance: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const bytes = await hc.fileRead(on, join(directory, 'heartbeat.json'));
      if (bytes.length <= 1024) {
        const heartbeat = JSON.parse(bytes.toString());
        if (heartbeat.version === 1 && heartbeat.instance === instance) return;
      }
    } catch { /* The remote console has not published its first atomic heartbeat yet. */ }
    await delay(25);
  }
  throw new HerdrError('console-ready-timeout', 'Console did not publish its heartbeat');
}
function consoleOwner(request: AgentConsoleLaunch, env: Readonly<NodeJS.ProcessEnv>): AgentConsoleOwner | null {
  if (request.enabled === false || !env.HC_TERMINAL_ID) return null;
  const runId = env.PI_SUBAGENT_CHILD === '1' ? env.PI_SUBAGENT_RUN_ID as RunId | undefined : undefined;
  if (env.PI_SUBAGENT_CHILD === '1' && !runId) return null;
  return { ...request.owner, ...(runId ? { runId } : {}) };
}
async function retireOlderConsole(terminal: TerminalSummary, request: AgentConsoleLaunch, owner: AgentConsoleOwner, hc: HcClient): Promise<'reuse' | 'replace' | 'foreign'> {
  if (terminal.labels[HERDR_LABELS.ownerCore] !== owner.terminal.coreId || terminal.labels[HERDR_LABELS.ownerTerminal] !== owner.terminal.terminalId ||
    terminal.labels[HERDR_LABELS.runtime] === request.target.runtimeSha256 || !request.isConsoleIdle) return 'reuse';
  try { if (!await request.isConsoleIdle()) return 'reuse'; }
  catch (error) { request.reportError?.(error); return 'reuse'; }
  try {
    const latest = await hc.get(terminal.address);
    if (!ownsConsole(latest, owner, request.on)) return 'foreign';
    if ([HERDR_LABELS.kind, HERDR_LABELS.session, HERDR_LABELS.ownerCore, HERDR_LABELS.ownerTerminal, HERDR_LABELS.machine, HERDR_LABELS.run, HERDR_LABELS.runtime]
      .some(key => latest.labels[key] !== terminal.labels[key])) return 'reuse';
    if (latest.state === 'live') await hc.kill(terminal.address);
    await hc.rm(terminal.address);
    return 'replace';
  } catch (error) {
    if (missing(error)) return 'replace';
    request.reportError?.(error);
    try {
      const latest = await hc.get(terminal.address);
      if (!ownsConsole(latest, owner, request.on)) return 'foreign';
      return latest.state === 'live' ? 'reuse' : 'replace';
    } catch (lookupError) { return missing(lookupError) ? 'replace' : 'reuse'; }
  }
}
async function ensureInQueue(request: AgentConsoleLaunch, hc: HcClient, env: Readonly<NodeJS.ProcessEnv>, owner: AgentConsoleOwner, key: string): Promise<AgentConsoleHandle | null> {
  if (endedAgents.has(agentKey(owner))) return null;
  let state = consoles.get(key);
  let terminal: TerminalSummary | undefined;
  if (state) {
    try { const latest = await hc.get(state.handle.address); if (latest.state === 'live' && ownsConsole(latest, owner, request.on)) terminal = latest; }
    catch (error) { if (!missing(error)) throw error; }
    if (!terminal) { consoles.delete(key); state = undefined; }
  }
  if (!state) terminal = (await snapshot(hc)).find(item => item.state === 'live' && ownsConsole(item, owner, request.on));
  let replacement = false;
  if (terminal) {
    const retirement = await retireOlderConsole(terminal, request, owner, hc);
    if (retirement !== 'reuse') {
      replacement = retirement === 'replace';
      terminal = undefined; state = undefined; consoles.delete(key);
    }
  }
  if (!state) try {
    const digest = createHash('sha256').update(key).digest('hex');
    const directory = join(request.target.directory, '.consoles', digest.slice(0, 32));
    const count = await commandCount(hc, request.on, directory);
    const runId = owner.runId;
    const name = runId ? env.PI_SUBAGENT_RUN_NAME || runId : owner.name || owner.sessionId;
    const suffix = ` · ${request.on}`.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    const title = name.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, Math.max(0, 512 - suffix.length)) + suffix;
    await hc.fileWrite(request.on, join(directory, 'console.json'), encodeRuntimePublication({ version: 1, title, ...(replacement ? { start: count } : {}) }));
    await hc.fileWrite(request.on, join(directory, 'head.json'), encodeRuntimePublication({ version: 1, count }));
    const instance = randomUUID();
    const handle = terminal ? { address: terminal.address, coreId: (await hc.machines()).find(machine => machine.name === request.on)!.id } : await hc.run({
      name: `console-${digest.slice(0, 20)}`, argv: [request.target.nodePath, request.target.runtimePath, '--console', directory, instance], cwd: null, on: request.on, parent: null,
      labels: { [HERDR_LABELS.kind]: HERDR_KINDS.remoteConsole, [HERDR_LABELS.session]: owner.sessionId, [HERDR_LABELS.ownerCore]: owner.terminal.coreId,
        [HERDR_LABELS.ownerTerminal]: owner.terminal.terminalId, [HERDR_LABELS.machine]: request.on, [HERDR_LABELS.runtime]: request.target.runtimeSha256, [HERDR_LABELS.displayName]: title.slice(0, -suffix.length) + ' @ ' + request.on, ...(runId ? { [HERDR_LABELS.run]: runId } : {}) },
      background: true, outliveParent: true, noNotify: true,
    });
    if (!terminal) await waitForHeartbeat(hc, request.on, directory, instance);
    state = { owner, handle: { ...handle, directory }, directory, count }; consoles.set(key, state);
  } catch (error) {
    if (replacement) request.reportError?.(error);
    throw error;
  }
  if (!request.job) return state.handle;
  const kind = request.kind ?? (request.source.kind === 'file' ? 'exec-file' : 'exec');
  const tool = kind === 'exec-file' ? 'exec_file' : kind;
  const command: ConsoleCommand = { version: 1, jobId: request.job.id, directory: request.job.remoteDirectory, command: request.source.code.split('\n')[0].slice(0, 1024), startedAt: request.startedAt ?? Date.now(), tool };
  const bytes = encodeRuntimePublication({ ...command });
  if (bytes.length > 8192) throw new HerdrError('console-command-invalid', 'Console descriptor exceeded its bound');
  await hc.fileWrite(request.on, join(state.directory, `command-${state.count}.json`), bytes);
  await hc.fileWrite(request.on, join(state.directory, 'head.json'), encodeRuntimePublication({ version: 1, count: state.count + 1 }));
  state.count++;
  return state.handle;
}
/** Called only from the active Herdr remote executor. Each payload remains in its supervised job. */
export async function ensureAgentConsole(request: AgentConsoleLaunch, hc: HcClient, env: Readonly<NodeJS.ProcessEnv> = process.env): Promise<AgentConsoleHandle | null> {
  const owner = consoleOwner(request, env); if (!owner) return null;
  const key = consoleKey(owner, request.on);
  return serialize(key, () => ensureInQueue(request, hc, env, owner, key));
}
/** Console failure is optional; the payload is still launched once through the supervised job port. */
export async function startWithAgentConsole(request: AgentConsoleStart): Promise<JobHandle> {
  const env = process.env, owner = consoleOwner(request, env);
  const work = async () => {
    const launch: AgentConsoleLaunch = { ...request,
      isConsoleIdle: owner && request.jobs.consoleIdle ? () => request.jobs.consoleIdle!(request.owner, request.on, owner.runId) : undefined,
      reportError: request.jobs.consoleError,
    };
    const key = owner ? consoleKey(owner, request.on) : '';
    const console = owner ? await ensureInQueue(launch, request.hc, env, owner, key).catch(() => null) : null;
    const prepare = async () => {
      const program = { ...await request.program() };
      if (console) program.consoleDirectory = console.directory;
      else delete program.consoleDirectory;
      return program;
    };
    const job = await request.jobs.start(prepare, request.owner, request.on, request.options);
    if (console && owner) await ensureInQueue({ ...launch, job }, request.hc, env, owner, key).catch(() => {});
    return job;
  };
  return owner ? serialize(consoleKey(owner, request.on), work) : work();
}

async function closeConsoleAddress(owner: AgentConsoleOwner, hc: HcClient, address: TerminalSummary['address'], machine: string | undefined, closing: () => boolean): Promise<void> {
  if (!closing()) return;
  try {
    const terminal = await hc.get(address);
    if (!closing()) return;
    if (ownsConsole(terminal, owner)) {
      if (terminal.state === 'live') await hc.kill(address);
      const latest = await hc.get(address);
      if (closing() && ownsConsole(latest, owner)) await hc.rm(address);
    }
  } catch (error) {
    if (!closing()) return;
    if (!consoleMissing(error)) throw error;
    await confirmConsoleMissing(hc, address, machine);
  }
  if (closing()) for (const [key, state] of consoles) if (agentKey(state.owner) === agentKey(owner) && state.handle.address === address) consoles.delete(key);
}

async function closeAgentConsolesInternal(owner: AgentConsoleOwner, hc: HcClient, onFailure?: (address: TerminalSummary['address'], machine: string | undefined, error: unknown) => void, closing: (address?: TerminalSummary['address']) => boolean = () => true): Promise<void> {
  endedAgents.add(agentKey(owner));
  // Wait for in-flight appends and creations before taking the inventory.
  await Promise.all([...queues.entries()].filter(([key]) => JSON.parse(key)[0] === agentKey(owner)).map(([, pending]) => pending.catch(() => {})));
  const inventory = (await snapshot(hc)).filter(terminal => ownsConsole(terminal, owner));
  // The same core can appear through multiple machine names. Prefer the entry on the labeled machine.
  const addresses = new Map(inventory.filter(terminal => {
    const slash = terminal.address.lastIndexOf('/'), machine = terminal.labels[HERDR_LABELS.machine];
    if (slash < 0 || !machine || terminal.address.slice(0, slash) === machine) return true;
    return !inventory.some(other => other.address === `${machine}/${terminal.address.slice(slash + 1)}` && other.labels[HERDR_LABELS.machine] === machine);
  }).map(terminal => [terminal.address, terminal.labels[HERDR_LABELS.machine]]));
  for (const [key, state] of consoles) if (agentKey(state.owner) === agentKey(owner)) addresses.set(state.handle.address, JSON.parse(key)[1]);
  const failures: unknown[] = [];
  for (const [address, machine] of addresses) {
    try { await closeConsoleAddress(owner, hc, address, machine, () => closing(address)); }
    catch (error) { failures.push(error); onFailure?.(address, machine, error); }
  }
  if (failures.length) throw failures[0];
}
/** Parent handoff supplies runId to find a killed child's consoles, without depending on its memory. */
export async function closeAgentConsoles(owner: AgentConsoleOwner, hc: HcClient): Promise<void> {
  await closeAgentConsolesInternal(owner, hc);
}
function registerLifecycle(pi: ExtensionAPI, ports: AgentConsoleLifecyclePorts, child: boolean): Disposable {
  const env = ports.env ?? process.env;
  if ((env.PI_SUBAGENT_CHILD === '1') !== child) return { dispose() {} };
  let previous: AgentConsoleOwner | null = null;
  let stopWatching = () => {}, closed = false;
  const pending = new Map<string, Promise<void>>();
  const sweep = createCleanupSweep(Date.now, () => {}); sweep.start();
  const cleanup = new Map<string, { machines: Set<string>; operation: () => Promise<void>; owner?: string; failures: number; revision: number }>();
  const exhausted = new Map<string, string | undefined>(), machineStates = new Map<string, boolean>();
  const maxAttempts = 24, reconnectInterval = 2000;
  let reconnectTimer: ReturnType<typeof setInterval> | undefined, machineCheck: Promise<void> | undefined, recheckMachines = false;
  const nameKey = (name: string) => name.toLowerCase().replace(/\.$/, '');
  const addressKey = (address: string) => `console:${address}`;
  const reportCleanup = (error: unknown) => {
    try {
      if (ports.reportCleanupError) ports.reportCleanupError(error);
      else process.stderr.write((error instanceof HerdrError && error.code === 'console-cleanup-exhausted' ? error.message : herdrErrorNotice(error)) + '\n');
    } catch { /* Diagnostics must not interrupt lifecycle setup. */ }
  };
  const observeMachines = () => {
    if (closed || !cleanup.size) return;
    if (machineCheck) { recheckMachines = true; return; }
    machineCheck = Promise.resolve().then(() => ports.hc.machines()).then(machines => {
      if (closed || !cleanup.size) return;
      const states = new Map<string, boolean>();
      for (const machine of machines) for (const name of [machine.name, ...machine.aliases]) states.set(nameKey(name), machine.state === 'connected');
      const names = new Set([...machineStates.keys(), ...states.keys(), ...[...cleanup.values()].flatMap(entry => [...entry.machines])]);
      const connected = new Set<string>();
      for (const name of names) {
        const next = states.get(name) ?? false;
        if (machineStates.get(name) === false && next) connected.add(name);
        machineStates.set(name, next);
      }
      if (connected.size) sweep.retry([...cleanup].filter(([, entry]) => !entry.machines.size || [...entry.machines].some(name => connected.has(name))).map(([key]) => key));
    }).catch(() => { /* An unavailable inventory is retried by the next check. */ }).finally(() => {
      machineCheck = undefined;
      if (recheckMachines) { recheckMachines = false; observeMachines(); }
    });
  };
  const updateReconnectTimer = () => {
    if (!closed && cleanup.size && !reconnectTimer) {
      reconnectTimer = setInterval(observeMachines, reconnectInterval); reconnectTimer.unref();
    } else if ((closed || !cleanup.size) && reconnectTimer) {
      clearInterval(reconnectTimer); reconnectTimer = undefined;
    }
  };
  const stopCleanup = (key: string, entry: { owner?: string }, error: unknown) => {
    cleanup.delete(key); exhausted.set(key, entry.owner); sweep.cancel(key); updateReconnectTimer();
    reportCleanup(new HerdrError('console-cleanup-exhausted', `Console cleanup stopped after ${maxAttempts} failures`, { key, cause: error }));
  };
  const queueCleanup = (key: string, names: readonly string[], operation: () => Promise<void>, error: unknown, owner?: string) => {
    if (closed || exhausted.has(key)) return;
    const existing = cleanup.get(key);
    if (existing) {
      for (const name of names) existing.machines.add(nameKey(name));
      if (owner) { existing.operation = operation; existing.owner = owner; existing.revision++; }
      if (++existing.failures >= maxAttempts) stopCleanup(key, existing, error);
      return;
    }
    const entry = { machines: new Set(names.map(nameKey)), operation, owner, failures: 1, revision: 0 };
    cleanup.set(key, entry); reportCleanup(error);
    if ((error as { code?: string })?.code === 'machine-unavailable') for (const name of entry.machines) machineStates.set(name, false);
    sweep.enqueue(key, async () => {
      try {
        let revision: number;
        do { revision = entry.revision; await entry.operation(); } while (cleanup.get(key) === entry && revision !== entry.revision);
        if (cleanup.get(key) === entry) cleanup.delete(key);
        updateReconnectTimer();
      } catch (failure) {
        if (cleanup.get(key) !== entry) return;
        if (++entry.failures >= maxAttempts) { stopCleanup(key, entry, failure); return; }
        throw failure;
      }
    }, { afterFailure: true });
    updateReconnectTimer(); observeMachines();
  };
  const cancelOwnerCleanup = (owner: AgentConsoleOwner) => {
    const key = agentKey(owner);
    for (const [id, entry] of cleanup) if (entry.owner === key) { cleanup.delete(id); sweep.cancel(id); }
    for (const [id, ownerKey] of exhausted) if (ownerKey === key) exhausted.delete(id);
    updateReconnectTimer();
  };
  const machineNames = (address: string, machine?: string) => {
    const slash = address.lastIndexOf('/');
    return [...new Set([slash < 0 ? undefined : address.slice(0, slash), machine].filter((name): name is string => Boolean(name)))];
  };
  const closeOrRetry = async (owner: AgentConsoleOwner) => {
    const ownerKey = agentKey(owner), closing = (address?: TerminalSummary['address']) => endedAgents.has(ownerKey) && (!address || !exhausted.has(addressKey(address)));
    const close = async () => {
      let delegated = false;
      try {
        await closeAgentConsolesInternal(owner, ports.hc, (address, machine, error) => {
          delegated = true;
          queueCleanup(addressKey(address), machineNames(address, machine), () => closeConsoleAddress(owner, ports.hc, address, machine, () => closing(address)), error, ownerKey);
        }, closing);
      } catch (error) { if (!delegated) throw error; }
    };
    try { await close(); }
    catch (error) { queueCleanup(`close:${ownerKey}`, [], async () => { if (closing()) await close(); }, error, ownerKey); }
  };
  const reap = (terminal: TerminalSummary, endedRunOnly = false): Promise<void> => {
    const existing = pending.get(terminal.address); if (existing) return existing.then(() => reap(terminal, endedRunOnly));
    const operation = (async () => {
      if (terminal.labels[HERDR_LABELS.kind] !== HERDR_KINDS.remoteConsole) return;
      const sameOwner = (latest: TerminalSummary) => [HERDR_LABELS.kind, HERDR_LABELS.session, HERDR_LABELS.ownerCore, HERDR_LABELS.ownerTerminal, HERDR_LABELS.machine, HERDR_LABELS.run]
        .every(key => latest.labels[key] === terminal.labels[key]);
      for (;;) {
        const active = previous;
        if (!terminal.labels[HERDR_LABELS.run] && active?.sessionId === terminal.labels[HERDR_LABELS.session]) return;
        const ownerGone = await ports.ownerIsLive?.(terminal) === false;
        const runLive = terminal.labels[HERDR_LABELS.run] ? await ports.runIsLive?.(terminal) : null;
        if (previous !== active) continue;
        const runEnded = runLive === false;
        if (endedRunOnly && !runEnded) return;
        if (!runEnded && (!ownerGone || runLive === true)) return;
        const ready = !ports.beforeReap || await ports.beforeReap(terminal);
        if (previous !== active) continue;
        if (!ready) return;
        try {
          const latest = await ports.hc.get(terminal.address);
          if (previous !== active) continue;
          if (!sameOwner(latest)) return;
          if (latest.state === 'live') await ports.hc.kill(terminal.address);
          const beforeRemove = await ports.hc.get(terminal.address);
          if (previous !== active) continue;
          if (sameOwner(beforeRemove)) await ports.hc.rm(terminal.address);
          return;
        } catch (error) {
          if (previous !== active) continue;
          if (!consoleMissing(error)) throw error;
          await confirmConsoleMissing(ports.hc, terminal.address, terminal.labels[HERDR_LABELS.machine]);
          return;
        }
      }
    })().catch(error => {
      const key = addressKey(terminal.address);
      if (!cleanup.has(key) && !exhausted.has(key)) queueCleanup(key, machineNames(terminal.address, terminal.labels[HERDR_LABELS.machine]), () => reap(terminal, endedRunOnly), error);
      throw error;
    }).finally(() => { pending.delete(terminal.address); });
    pending.set(terminal.address, operation); return operation;
  };
  const current = (ctx: ExtensionContext): AgentConsoleOwner | null => {
    const owner = ports.currentOwner(ctx), runId = child ? env.PI_SUBAGENT_RUN_ID as RunId | undefined : undefined;
    return owner && (!child || runId) ? { ...owner, ...(runId ? { runId } : {}) } : null;
  };
  const offs = [
    pi.on('session_start', async (_event, ctx) => {
      stopWatching(); stopWatching = () => {};
      if (!env.HC_TERMINAL_ID) return;
      const owner = current(ctx); if (!owner) { previous = null; return; }
      const old = previous;
      previous = owner; endedAgents.delete(agentKey(owner)); cancelOwnerCleanup(owner);
      if (old && agentKey(old) !== agentKey(owner)) await closeOrRetry(old);
      if (child || !ports.ownerIsLive) return;
      // A child can be killed before its first console launch replies or writes a job journal.
      // Watch both run completion and later console creation so neither ordering leaks a console.
      let watching = true;
      const reapOrRetry = async (terminal: TerminalSummary, endedRunOnly = false) => {
        const key = addressKey(terminal.address);
        if (cleanup.has(key) || exhausted.has(key)) return;
        try { await reap(terminal, endedRunOnly); }
        catch { /* The address lock queues the failed check before it is released. */ }
      };
      const stream = ports.hc.events();
      const offEvents = stream.subscribe(event => {
        if (!watching) return;
        if (event.type === 'snapshot' || event.type === 'missed') observeMachines();
        if ((event.type === 'created' || event.type === 'restarted') && event.data.labels[HERDR_LABELS.run]) void reapOrRetry(event.data);
        if (event.type === 'missed') for (const terminal of event.terminals) if (terminal.labels[HERDR_LABELS.run]) void reapOrRetry(terminal);
      });
      const offRuns = ports.subscribeRunEnds?.(owner, runId => {
        void snapshot(ports.hc).then(terminals => watching ? Promise.all(terminals.filter(t => t.labels[HERDR_LABELS.session] === owner.sessionId && t.labels[HERDR_LABELS.run] === runId).map(terminal => reapOrRetry(terminal))) : undefined).catch(error => { if (watching) ports.reportError?.(error); });
      }) ?? (() => {});
      stopWatching = () => { watching = false; offEvents(); offRuns(); void stream.dispose(); };
      await stream.ready;
      for (const terminal of await snapshot(ports.hc)) {
        if (_event?.reason !== 'reload' || terminal.labels[HERDR_LABELS.run]) await reapOrRetry(terminal, _event?.reason === 'reload');
      }
    }),
    pi.on('session_shutdown', async (event, ctx) => {
      const reason = event?.reason;
      stopWatching(); stopWatching = () => {};
      if (!env.HC_TERMINAL_ID || !reason || reason === 'reload' || child && reason !== 'quit') return;
      const active = current(ctx), owner = active ? previous ?? active : null;
      previous = null; if (owner) await closeOrRetry(owner);
    }),
  ];
  return { dispose() { closed = true; stopWatching(); for (const off of offs) off?.(); cleanup.clear(); updateReconnectTimer(); void sweep.dispose(); } };
}
export function registerAgentConsoleLifecycle(pi: ExtensionAPI, ports: AgentConsoleLifecyclePorts): Disposable {
  return registerLifecycle(pi, ports, false);
}
export function registerChildAgentConsoleLifecycle(pi: ExtensionAPI, ports: AgentConsoleLifecyclePorts): Disposable {
  return registerLifecycle(pi, ports, true);
}
