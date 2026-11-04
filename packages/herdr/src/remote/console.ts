// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { HERDR_KINDS, HERDR_LABELS, type Disposable, type HcClient, type JobHandle, type JobPort, type MachineName, type Owner, type PreparedProgram, type RemoteSource, type RunId, type RuntimeTarget, type TerminalHandle, type TerminalSummary } from '../contracts.js';
import { encodeRuntimePublication, parseRuntimePublication, type ConsoleCommand } from './runtime.js';
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrError } from '../client/parse.js';

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
}
export interface AgentConsoleHandle extends TerminalHandle { directory: string }
export interface AgentConsoleStart extends AgentConsoleLaunch {
  program: PreparedProgram; jobs: JobPort & { consoleIdle?(owner: Owner, on: MachineName, runId?: RunId): Promise<boolean>; consoleError?(error: unknown): void }; hc: HcClient; options: Parameters<JobPort['start']>[3];
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
  if (terminal.labels[HERDR_LABELS.runtime] === request.target.runtimeSha256 || !request.isConsoleIdle) return 'reuse';
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
  if (terminal && await retireOlderConsole(terminal, request, owner, hc) !== 'reuse') {
    terminal = undefined; state = undefined; consoles.delete(key);
  }
  if (!state) {
    const digest = createHash('sha256').update(key).digest('hex');
    const directory = join(request.target.directory, '.consoles', digest.slice(0, 32));
    const count = await commandCount(hc, request.on, directory);
    const runId = owner.runId;
    const name = runId ? env.PI_SUBAGENT_RUN_NAME || runId : owner.name || owner.sessionId;
    const suffix = ` · ${request.on}`.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    const title = name.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, Math.max(0, 512 - suffix.length)) + suffix;
    await hc.fileWrite(request.on, join(directory, 'console.json'), encodeRuntimePublication({ version: 1, title }));
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
    const program = { ...request.program };
    if (console) program.consoleDirectory = console.directory;
    else delete program.consoleDirectory;
    const job = await request.jobs.start(program, request.owner, request.on, request.options);
    if (console && owner) await ensureInQueue({ ...launch, job }, request.hc, env, owner, key).catch(() => {});
    return job;
  };
  return owner ? serialize(consoleKey(owner, request.on), work) : work();
}

/** Parent handoff supplies runId to find a killed child's consoles, without depending on its memory. */
export async function closeAgentConsoles(owner: AgentConsoleOwner, hc: HcClient): Promise<void> {
  endedAgents.add(agentKey(owner));
  // Wait for in-flight appends and creations before taking the inventory.
  await Promise.all([...queues.entries()].filter(([key]) => JSON.parse(key)[0] === agentKey(owner)).map(([, pending]) => pending.catch(() => {})));
  const addresses = new Set((await snapshot(hc)).filter(terminal => ownsConsole(terminal, owner)).map(terminal => terminal.address));
  for (const [key, state] of consoles) if (agentKey(state.owner) === agentKey(owner)) { addresses.add(state.handle.address); consoles.delete(key); }
  for (const address of addresses) {
    try { const terminal = await hc.get(address); if (terminal.state === 'live') await hc.kill(address); }
    catch (error) { if (!missing(error)) throw error; }
    try { await hc.rm(address); } catch (error) { if (!missing(error)) throw error; }
  }
}
function registerLifecycle(pi: ExtensionAPI, ports: AgentConsoleLifecyclePorts, child: boolean): Disposable {
  const env = ports.env ?? process.env;
  if ((env.PI_SUBAGENT_CHILD === '1') !== child) return { dispose() {} };
  let previous: AgentConsoleOwner | null = null;
  let stopWatching = () => {};
  const pending = new Map<string, Promise<void>>();
  const reap = (terminal: TerminalSummary): Promise<void> => {
    const existing = pending.get(terminal.address); if (existing) return existing.then(() => reap(terminal));
    const operation = (async () => {
      if (terminal.labels[HERDR_LABELS.kind] !== HERDR_KINDS.remoteConsole) return;
      try {
        const ownerGone = await ports.ownerIsLive?.(terminal) === false;
        const runLive = terminal.labels[HERDR_LABELS.run] ? await ports.runIsLive?.(terminal) : null;
        const runEnded = runLive === false;
        if (!runEnded && (!ownerGone || runLive === true)) return;
        if (ports.beforeReap && !await ports.beforeReap(terminal)) return;
        const latest = await ports.hc.get(terminal.address);
        if ([HERDR_LABELS.kind, HERDR_LABELS.session, HERDR_LABELS.ownerCore, HERDR_LABELS.ownerTerminal, HERDR_LABELS.machine, HERDR_LABELS.run]
          .some(key => latest.labels[key] !== terminal.labels[key])) return;
        if (latest.state === 'live') await ports.hc.kill(terminal.address);
        await ports.hc.rm(terminal.address);
      } catch (error) { if (!missing(error)) ports.reportError?.(error); }
    })().finally(() => { pending.delete(terminal.address); });
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
      if (previous && agentKey(previous) !== agentKey(owner)) await closeAgentConsoles(previous, ports.hc);
      previous = owner; endedAgents.delete(agentKey(owner));
      if (child || !ports.ownerIsLive) return;
      // A child can be killed before its first console launch replies or writes a job journal.
      // Watch both run completion and later console creation so neither ordering leaks a console.
      let watching = true;
      const stream = ports.hc.events();
      const offEvents = stream.subscribe(event => {
        if (!watching) return;
        if ((event.type === 'created' || event.type === 'restarted') && event.data.labels[HERDR_LABELS.run]) void reap(event.data);
        if (event.type === 'missed') for (const terminal of event.terminals) if (terminal.labels[HERDR_LABELS.run]) void reap(terminal);
      });
      const offRuns = ports.subscribeRunEnds?.(owner, runId => {
        void snapshot(ports.hc).then(terminals => watching ? Promise.all(terminals.filter(t => t.labels[HERDR_LABELS.session] === owner.sessionId && t.labels[HERDR_LABELS.run] === runId).map(reap)) : undefined).catch(error => { if (watching) ports.reportError?.(error); });
      }) ?? (() => {});
      stopWatching = () => { watching = false; offEvents(); offRuns(); void stream.dispose(); };
      await stream.ready;
      if (_event?.reason !== 'reload') for (const terminal of await snapshot(ports.hc)) await reap(terminal);
    }),
    pi.on('session_shutdown', async (event, ctx) => {
      const reason = event?.reason;
      stopWatching(); stopWatching = () => {};
      if (!env.HC_TERMINAL_ID || !reason || reason === 'reload' || child && reason !== 'quit') return;
      const active = current(ctx), owner = active ? previous ?? active : null;
      previous = null; if (owner) await closeAgentConsoles(owner, ports.hc);
    }),
  ];
  return { dispose() { stopWatching(); for (const off of offs) off?.(); } };
}
export function registerAgentConsoleLifecycle(pi: ExtensionAPI, ports: AgentConsoleLifecyclePorts): Disposable {
  return registerLifecycle(pi, ports, false);
}
export function registerChildAgentConsoleLifecycle(pi: ExtensionAPI, ports: AgentConsoleLifecyclePorts): Disposable {
  return registerLifecycle(pi, ports, true);
}
