// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Real pi processes: fenced agent settings, the scripted provider, the observer, gates, and the RPC/interactive drivers.
import { mkdir, writeFile, chmod, readFile, readdir, realpath } from 'node:fs/promises';
import { existsSync, watch, mkdirSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkoutRoot, HarnessError, ownedPath, type OwnedPath } from './environment.js';
import { spawnOwned, stopProcessGroup, jsonLines, type OwnedProcess } from './processes.js';
import { identityAlive, identityOf, type LedgerHandle, type ProcessIdentity } from './resources.js';
import { waitFor, deadline as makeDeadline, type Deadline } from './wait.js';
import type { Cores } from './hc.js';
import type { PackedBuild } from './pack.js';
import type { ScriptFile } from '../fixtures/scripted-provider.js';

export const PROVIDER = 'e2e-fixture';
export const MODEL = 'scripted';
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;

export interface PiEnvironment {
  root: OwnedPath; bin: OwnedPath; launcher: OwnedPath; observerDir: OwnedPath; scriptPath: OwnedPath; gateSocket: OwnedPath;
  providerPath: string; observerPath: string; env: Record<string, string>; story: string;
}
/** The installed pi CLI that the test-owned launcher imports. */
export async function installedPiCli(nodeExecutable: string = process.execPath): Promise<string> {
  let cli = await realpath(join(dirname(nodeExecutable), 'pi')).catch(() => null);
  let source = 'node-sibling';
  if (!cli || !existsSync(cli)) {
    const dependency = join(checkoutRoot(), 'node_modules', '@earendil-works', 'pi-coding-agent');
    const manifest = JSON.parse(await readFile(join(dependency, 'package.json'), 'utf8').catch(() => '{}')) as { bin?: string | { pi?: string } };
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pi;
    cli = bin ? await realpath(join(dependency, bin)).catch(() => null) : null;
    source = 'checkout-dependency';
  }
  if (!cli || !existsSync(cli)) throw new HarnessError('missing-prerequisite', 'pi 1.2.0 is not installed beside this node or in the checkout dependency');
  let directory = dirname(cli), version: string | undefined;
  while (dirname(directory) !== directory) {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8').catch(() => '{}')) as { name?: string; version?: string };
    if (manifest.name === '@earendil-works/pi-coding-agent') { version = manifest.version; break; }
    directory = dirname(directory);
  }
  if (!version) throw new HarnessError('missing-prerequisite', 'the selected pi binary has no package version');
  const evidence = ownedPath(join(checkoutRoot(), '.spider', 'scratch'), join(checkoutRoot(), '.spider', 'scratch', 'e2', '_evidence', '_pi', `${process.pid}.json`));
  await mkdir(dirname(evidence), { recursive: true });
  await writeFile(evidence, JSON.stringify({ path: cli, version, source }, null, 2), { mode: 0o600 });
  return cli;
}

/**
 * Writes the fenced agent settings (packed spider + provider + observer as installed packages), spider's global config,
 * and the `pi` launcher on PATH. Settings-based loading avoids explicit -e arguments, which cutover refuses.
 */
export async function preparePi(root: string, env: Record<string, string>, packed: PackedBuild, story: string, script: ScriptFile = { story, scripts: {} }): Promise<PiEnvironment> {
  const own = (p: string) => ownedPath(root, p);
  const bin = own(join(root, 'bin')), observerDir = own(join(root, 'o')), scriptPath = own(join(root, 'script.json')), gateSocket = own(join(root, 'g.s'));
  await mkdir(bin, { recursive: true }); await mkdir(observerDir, { recursive: true });
  const providerPath = fixture('scripted-provider.ts'), observerPath = fixture('pi-observer.ts');
  await writeScript(scriptPath, script);
  const launcher = own(join(bin, 'pi'));
  const baked: Record<string, string> = {
    SPIDER_E2E_PI_CLI: await installedPiCli(), SPIDER_E2E_SOURCE_GUARD: join(checkoutRoot(), 'packages'),
    SPIDER_E2E_OBSERVER_DIR: observerDir, SPIDER_E2E_SCRIPT: scriptPath, SPIDER_E2E_GATE_SOCKET: gateSocket,
  };
  await writeFile(launcher, `#!/bin/sh\n${Object.entries(baked).map(([k, v]) => `${k}=${quote(v)}; export ${k}`).join('\n')}\nexec ${quote(process.execPath)} ${quote(fixture('pi-launch.mjs'))} "$@"\n`);
  await chmod(launcher, 0o700);
  const agent = own(env.PI_CODING_AGENT_DIR);
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ packages: [packed.root, providerPath, observerPath], defaultProvider: PROVIDER, defaultModel: MODEL, defaultThinkingLevel: 'off', quietStartup: true, defaultProjectTrust: 'never' }, null, 2));
  // Standalone setup resolves roles from the catalog without loading extensions, so the synthetic model is also
  // declared here. The provider extension supplies the only stream implementation; nothing here reaches a network.
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { [PROVIDER]: { baseUrl: 'https://offline.invalid', api: 'e2e-fixture-api', apiKey: 'fixture-only',
    models: [{ id: MODEL, name: 'Scripted fixture', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 8000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }, null, 2));
  const global = own(env.SPIDER_GLOBAL_ROOT);
  await mkdir(global, { recursive: true });
  await writeFile(join(global, 'config.json'), JSON.stringify({
    'organism.enabled': false, 'subagents.keepCacheWarm': false, 'usage.counter.poll': false, 'memory.reviewer.enabled': false,
    'skills.reviewer.enabled': false, 'embeddings.drain': false, 'subagents.extensions': [providerPath, observerPath],
  }, null, 2));
  return { root: root as OwnedPath, bin, launcher, observerDir, scriptPath, gateSocket, providerPath, observerPath, env: { ...env }, story };
}
export async function writeScript(path: string, script: ScriptFile): Promise<void> { await writeFile(path, JSON.stringify(script, null, 2)); }

// ---------------------------------------------------------------- gates
export interface GateReady { story: string; gate: string; marker: string; step: number; pid: number }
export interface GateServer {
  /** Resolves when a provider reports ready at this gate. */
  ready(gate: string, limit: Deadline): Promise<GateReady>;
  release(gate: string): void;
  /** Closes the control connection for a waiting gate, which aborts that provider request. */
  abort(gate: string): void;
  /** Sends bytes that are not a valid release (negative control). */
  sendRaw(gate: string, bytes: string): void;
  errors(): readonly string[];
  close(): Promise<void>;
}
export async function createGateServer(path: string, story: string): Promise<GateServer> {
  const waiting = new Map<string, { ready: GateReady; socket: Socket }>(); const released = new Set<string>(); const errors: string[] = [];
  const listeners = new Set<() => void>();
  const server: Server = createServer(socket => {
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString('utf8'); const newline = buffer.indexOf('\n'); if (newline < 0) return;
      let ready: GateReady;
      try { ready = JSON.parse(buffer.slice(0, newline)); } catch { errors.push('malformed ready'); socket.destroy(); return; }
      buffer = buffer.slice(newline + 1);
      if (ready.story !== story) { errors.push(`ready from story ${ready.story}`); socket.destroy(); return; }
      waiting.set(ready.gate, { ready, socket }); for (const l of listeners) l();
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  const take = (gate: string) => { const entry = waiting.get(gate); if (!entry) throw new HarnessError(released.has(gate) ? 'gate-already-released' : 'gate-not-ready', gate); waiting.delete(gate); return entry; };
  return {
    ready: (gate, limit) => waitFor(`provider ready at gate ${gate}`, () => waiting.get(gate)?.ready, Boolean, limit, { subscribe: wake => { listeners.add(wake); return () => listeners.delete(wake); } }) as Promise<GateReady>,
    release(gate) { const { ready, socket } = take(gate); released.add(gate); socket.end(JSON.stringify({ type: 'release', story, gate, step: ready.step }) + '\n'); },
    abort(gate) { take(gate).socket.destroy(); },
    sendRaw(gate, bytes) { take(gate).socket.end(bytes); },
    errors: () => [...errors],
    close: () => new Promise<void>(resolve => { for (const { socket } of waiting.values()) socket.destroy(); waiting.clear(); server.close(() => resolve()); }),
  };
}

// ---------------------------------------------------------------- observations
export interface ObservedEvent { at: number; pid: number; type: string; [key: string]: unknown }
export interface PiObservations {
  waitEvent(type: string, predicate: (event: ObservedEvent) => boolean, deadline: Deadline): Promise<ObservedEvent>;
  toolResult(callId: string, deadline: Deadline): Promise<ObservedEvent>;
  events(): Promise<ObservedEvent[]>;
  close(): Promise<void>;
}
export async function readObserved(directory: string, pid?: number): Promise<ObservedEvent[]> {
  const files = pid === undefined ? (await readdir(directory).catch(() => [])).filter(f => f.endsWith('.jsonl')) : [`${pid}.jsonl`];
  const out: ObservedEvent[] = [];
  for (const file of files) {
    const lines = (await readFile(join(directory, file), 'utf8').catch(() => '')).split('\n');
    for (const line of lines.slice(0, -1)) if (line) out.push(JSON.parse(line));
  }
  return out.sort((a, b) => a.at - b.at);
}
/** Observations for one pi process (by PID) read from the observer's log, watched with a bounded reconcile. */
export function observe(directory: string, pid: () => number | undefined): Pick<PiObservations, 'waitEvent' | 'toolResult' | 'events'> {
  const events = async () => { const p = pid(); return p === undefined ? [] : readObserved(directory, p); };
  const waitEvent: PiObservations['waitEvent'] = async (type, predicate, limit) => {
    const found = await waitFor(`pi event ${type}`, events, list => list.some(e => e.type === type && predicate(e)), limit, {
      subscribe: wake => { const w = watch(directory, () => wake()); return () => w.close(); }, reconcileMs: 250,
    });
    return found.find(e => e.type === type && predicate(e))!;
  };
  return { events, waitEvent, toolResult: (callId, limit) => waitEvent('tool_execution_end', e => e.toolCallId === callId, limit) };
}

// ---------------------------------------------------------------- drivers
export type PiMode = 'interactive' | 'rpc' | 'print' | 'json';
interface Common extends PiObservations { readonly pid: number; readonly identity: ProcessIdentity; readonly cwd: string }
export interface RpcDriver extends Common { mode: 'rpc'; rpc(command: Record<string, unknown>, limit?: Deadline): Promise<Record<string, unknown>>; prompt(text: string, limit?: Deadline): Promise<ObservedEvent>; records(): readonly Record<string, unknown>[] }
export interface OneShotDriver extends Common { mode: 'print' | 'json'; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; output(): Promise<string> }
export interface InteractiveDriver extends Common { mode: 'interactive'; terminal: string; prompt(text: string): Promise<void>; key(bytes: string): Promise<void>; draft(): Promise<string>; rawOutput(): Promise<Buffer> }
export type PiDriver = RpcDriver | OneShotDriver | InteractiveDriver;
export interface LaunchOptions { mode: PiMode; cwd: string; args?: readonly string[]; prompt?: string; extraEnv?: Record<string, string>; label?: string }

let launches = 0;
export async function launchPi(pi: PiEnvironment, ledger: LedgerHandle, options: LaunchOptions, cores?: Cores): Promise<PiDriver> {
  const n = ++launches, label = options.label ?? `pi-${options.mode}-${n}`;
  const env = { ...pi.env, ...options.extraEnv };
  const cwd = ownedPath(pi.root, options.cwd);
  if (options.mode === 'interactive') {
    if (!cores) throw new HarnessError('interactive-needs-terminal', 'interactive pi needs an hc terminal; a pipe-only launch selects print mode');
    return launchInteractive(pi, ledger, cores, cwd, options, n);
  }
  const args = options.mode === 'rpc' ? ['--mode', 'rpc', ...(options.args ?? [])]
    : options.mode === 'json' ? ['--mode', 'json', ...(options.args ?? []), ...(options.prompt ? [options.prompt] : [])]
    : ['-p', ...(options.args ?? []), ...(options.prompt ? [options.prompt] : [])];
  const logs = ownedPath(pi.root, join(pi.root, 'logs')); mkdirSync(logs, { recursive: true });
  const stdoutLog = join(logs, `${label}.out`);
  const proc = spawnOwned(ledger, { label, command: pi.launcher, args, env, cwd, stdio: options.mode === 'rpc' ? 'pipe' : { log: stdoutLog }, stderrLog: join(logs, `${label}.err`) });
  const observations = observe(pi.observerDir, () => proc.identity.pid);
  const common = { pid: proc.identity.pid, identity: proc.identity, cwd, ...observations };
  if (options.mode !== 'rpc') return { ...common, mode: options.mode, exited: proc.exited, output: () => readFile(stdoutLog, 'utf8'), close: () => proc.stop() };
  return rpcDriver(proc, common);
}

function rpcDriver(proc: OwnedProcess, common: Omit<Common, 'close'>): RpcDriver {
  const pending = new Map<string, { resolve(v: Record<string, unknown>): void; reject(e: Error): void }>();
  const records: Record<string, unknown>[] = []; let failure: HarnessError | undefined; let ids = 0;
  const fail = (error: HarnessError) => { failure ??= error; for (const p of pending.values()) p.reject(error); pending.clear(); };
  proc.child.stdout!.on('data', jsonLines(value => {
    const record = value as Record<string, unknown>; records.push(record);
    if (record.type === 'response' && typeof record.id === 'string') { const p = pending.get(record.id); pending.delete(record.id); p?.resolve(record); }
  }, line => fail(new HarnessError('rpc-malformed-record', line.slice(0, 500)))));
  void proc.exited.then(exit => fail(new HarnessError('rpc-exited', `pi exited ${JSON.stringify(exit)}`)));
  const rpc: RpcDriver['rpc'] = (command, limit = makeDeadline(30_000)) => {
    if (failure) return Promise.reject(failure);
    const id = `e2e-${++ids}`;
    return new Promise((resolve, reject) => {
      const onAbort = () => { pending.delete(id); reject(new HarnessError('rpc-deadline', `${String(command.type)} had no response`)); };
      limit.signal.addEventListener('abort', onAbort, { once: true });
      pending.set(id, { resolve: r => { limit.signal.removeEventListener('abort', onAbort); if (r.success === false) reject(new HarnessError('rpc-failed', String(r.error), r)); else resolve(r); }, reject });
      proc.child.stdin!.write(JSON.stringify({ ...command, id }) + '\n');
    });
  };
  return {
    ...common, mode: 'rpc', rpc, records: () => records,
    async prompt(text, limit = makeDeadline(60_000)) {
      const before = Date.now();
      const response = await rpc({ type: 'prompt', message: text }, limit);
      if ((response.data as { disposition?: string } | undefined)?.disposition === 'handled') return { at: before, pid: common.pid, type: 'handled' };
      return common.waitEvent('agent_settled', e => e.at >= before, limit);
    },
    async close() {
      if (proc.child.exitCode === null && proc.child.signalCode === null) {
        proc.child.stdin!.end();
        try { await waitFor('rpc pi exit event after stdin closes', () => proc.child.exitCode !== null || proc.child.signalCode !== null, Boolean, makeDeadline(10_000), { reconcileMs: 100 }); }
        catch (error) { if (!(error instanceof HarnessError) || error.code !== 'wait-deadline') throw error; }
      }
      await proc.stop();
    },
  };
}

async function launchInteractive(pi: PiEnvironment, ledger: LedgerHandle, cores: Cores, cwd: OwnedPath, options: LaunchOptions, n: number): Promise<InteractiveDriver> {
  const socketPath = ownedPath(pi.root, join(pi.root, `b${n}.s`)), rawLog = ownedPath(pi.root, join(pi.root, 'logs', `tui-${n}.raw`));
  mkdirSync(dirname(rawLog), { recursive: true });
  // hc decides the terminal program's base environment; the broker replaces it with the fenced one plus extraEnv,
  // keeping only the HC_* variables hc set for this terminal.
  const envFile = ownedPath(pi.root, join(pi.root, `env-${n}.json`));
  await writeFile(envFile, JSON.stringify({ ...pi.env, ...options.extraEnv }), { mode: 0o600 });
  const argv = ['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--cwd', cwd, '--', '/usr/bin/python3', fileURLToPath(new URL('./pty-broker.py', import.meta.url)), '--socket', socketPath, '--log', rawLog, '--env-file', envFile, '--', pi.launcher, ...(options.args ?? [])];
  const result = await cores.hc(argv, 'local', { cwd });
  const address = (result.json as { address?: unknown; terminal?: { address?: unknown } } | null);
  const terminal = typeof address?.address === 'string' ? address.address : typeof address?.terminal?.address === 'string' ? address.terminal.address : null;
  if (result.exitCode !== 0 || !terminal) throw new HarnessError('hc-run-failed', result.stderr || result.stdout);
  ledger.update(l => { l.terminals.push({ side: 'local', address: terminal }); });
  const call = (request: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = connect(socketPath); let buffer = '';
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', d => { buffer += d; const i = buffer.indexOf('\n'); if (i >= 0) { socket.destroy(); try { resolve(JSON.parse(buffer.slice(0, i))); } catch (e) { reject(e); } } });
    socket.on('error', reject);
  });
  await waitFor('pty broker socket', () => existsSync(socketPath), Boolean, makeDeadline(20_000));
  const hello = await call({ op: 'hello' });
  if (typeof hello.pid !== 'number' || hello.terminal !== terminal) throw new HarnessError('broker-identity', `broker reports ${JSON.stringify(hello)} for ${terminal}`);
  if (typeof hello.brokerPid !== 'number') throw new HarnessError('broker-identity', 'broker did not report its own PID');
  const identity = identityOf(hello.pid), brokerIdentity = identityOf(hello.brokerPid);
  ledger.update(l => { l.processes.push({ ...identity, label: `pi-tui-${n}`, group: false }, { ...brokerIdentity, label: `pi-broker-${n}`, group: false }); });
  const send = async (data: string) => { const r = await call({ op: 'input', pid: identity.pid, terminal, data }); if (r.ok !== true) throw new HarnessError('broker-refused', JSON.stringify(r)); };
  const observations = observe(pi.observerDir, () => identity.pid);
  return {
    mode: 'interactive', pid: identity.pid, identity, cwd, terminal, ...observations,
    prompt: text => send(text + '\r'), key: send,
    async draft() {
      const r = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = connect(join(pi.observerDir, `${identity.pid}.s`)); let buffer = '';
        socket.on('connect', () => socket.write('{"op":"draft"}\n'));
        socket.on('data', d => { buffer += d; const i = buffer.indexOf('\n'); if (i >= 0) { socket.destroy(); resolve(JSON.parse(buffer.slice(0, i))); } });
        socket.on('error', reject);
      });
      if (typeof r.draft !== 'string') throw new HarnessError('draft-unavailable', JSON.stringify(r));
      return r.draft;
    },
    rawOutput: () => readFile(rawLog),
    async close() {
      await stopProcessGroup(identity, 'interactive pi', makeDeadline(10_000));
      const state = await cores.hc(['get', terminal, '--json']);
      if ((state.json as { state?: string } | null)?.state === 'live') await cores.hc(['kill', terminal, '--json']);
      await cores.hc(['rm', terminal, '--json']);
      await waitFor('interactive pi and broker have exited', () => ({ pi: identityAlive(identity), broker: identityAlive(brokerIdentity) }), state => !state.pi && !state.broker, makeDeadline(5000), { reconcileMs: 50 });
    },
  };
}
