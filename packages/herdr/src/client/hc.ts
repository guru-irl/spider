// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { invokeCli as invokeTransport } from './cli-transport.js';
import childProcess from 'node:child_process';
import { requireCoreAvailable } from './liveness.js';
import { realpathSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, basename, join, isAbsolute, sep } from 'node:path';
import type { HcClient, HcClientOptions, TerminalId, HcEventStream, Disposable, MachineName, MachineSummary, CoreId } from '../contracts.js';
import { HERDR_LABELS } from '../contracts.js';
import { createHcEventStream } from './events.js';
import { HerdrError, parseCore, parseTerminal, object, text, selectedSocket } from './parse.js';

export async function invokeCli(binary: string, argv: readonly string[], env: Readonly<NodeJS.ProcessEnv>, maxBytes: number = 1024 * 1024, input?: Buffer): Promise<unknown> {
  const environment = Object.freeze({ ...env, HC_SOCKET: selectedSocket(env) });
  await requireCoreAvailable(environment);
  // hc has no no-autostart mode. Keep the unavoidable check-then-call race to
  // this immediate spawn; a core exiting in that gap can still be auto-started.
  return invokeTransport(binary, argv, environment, maxBytes, input);
}
function physicalPath(path: string): string {
  const tail: string[] = []; let parent = resolve(path);
  while (!existsSync(parent) && dirname(parent) !== parent) { tail.unshift(basename(parent)); parent = dirname(parent); }
  return join(realpathSync(parent), ...tail);
}
function guardTestSocket(options: HcClientOptions): void {
  const checkout = process.env.SPIDER_TEST_FIXTURE_CHECKOUT || options.env.SPIDER_TEST_FIXTURE_CHECKOUT;
  if (!checkout) return;
  const root = physicalPath(join(checkout, '.spider/scratch'));
  const inside = (path: string) => { const suffix = relative(root, physicalPath(path)); return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`); };
  const socket = selectedSocket(options.env);
  if (!inside(socket) || (options.env.HC_TERMINAL_SOCKET && !inside(options.env.HC_TERMINAL_SOCKET))) throw new HerdrError('isolation-unproved', 'Tests must use a socket inside their owned scratch root');
  const proof = options.isolationProof;
  if (proof && (!proof.sockets.includes(socket) || proof.sessionNamespace !== (options.env.HC_SESSION || 'default') || physicalPath(proof.checkout) !== physicalPath(checkout) || proof.coreIds.length !== proof.sockets.length || proof.coreIds.length === 0 || proof.sockets.some(path => !inside(path)))) throw new HerdrError('isolation-unproved', 'Isolation proof does not match the selected core');
}
export async function processContainsCaller(pid: unknown, env: Readonly<NodeJS.ProcessEnv>, callerPid: number = process.pid): Promise<boolean> {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === callerPid) return true;
  // One bounded process snapshot, including shells between the terminal root and pi.
  const windows = process.platform === 'win32';
  const argv = windows ? ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'] : ['-eo', 'pid=,ppid='];
  const output = await new Promise<string>((resolve, reject) => {
    childProcess.execFile(windows ? 'powershell.exe' : 'ps', argv, { env: { ...env, LC_ALL: 'C' }, encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => error ? reject(new HerdrError('caller-probe-unavailable', 'Cannot verify the Herdr terminal process ancestry')) : resolve(stdout));
  });
  const parents = new Map<number, number>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  const visited = new Set<number>();
  for (let current: number | undefined = callerPid; current && !visited.has(current); current = parents.get(current)) {
    if (current === pid) return true;
    visited.add(current);
  }
  return false;
}
export function createHcClient(options: HcClientOptions): HcClient & Disposable {
  const env = Object.freeze({ ...options.env, HC_SOCKET: selectedSocket(options.env) });
  guardTestSocket({ ...options, env });
  const call = (argv: readonly string[], input?: Buffer) => invokeCli(options.binary, argv, env, options.maxReplyBytes, input);
  let selectedCore: CoreId | undefined = options.isolationProof?.coreIds[options.isolationProof.sockets.indexOf(selectedSocket(env))];
  const identity: HcClient['identity'] = async () => {
    const core = parseCore(await call(['server', 'status', '--json']), env);
    if (selectedCore !== undefined && selectedCore !== core.coreId) throw new HerdrError('core-mismatch', "this session's Herdr terminal belongs to a core that is no longer running; start a new session in Herdr", core);
    selectedCore = core.coreId; return core;
  };
  const get: HcClient['get'] = async address => {
    const terminal = parseTerminal(await call(['get', address, '--json']));
    if (terminal.address !== address) throw new HerdrError('caller-mismatch', 'Returned terminal address differs from the requested address');
    return terminal;
  };
  let eventStream: HcEventStream | undefined;
  let disposal: Promise<void> | undefined;
  const machines: HcClient['machines'] = async () => {
    const rows = object(await call(['machine', 'ls', '--json'])).machines;
    if (!Array.isArray(rows)) throw new HerdrError('invalid-reply', 'Expected machine list');
    return rows.map(value => {
      const m = object(value); const name = text(m.name);
      const aliases = [name, text(m.host), ...(m.via ? [] : [text(m.target).replace(/^.*@/, '')])].map(v => v.toLowerCase().replace(/\.$/, ''));
      return { id: text(m.id) as CoreId, name: name as MachineName, aliases: [...new Set(aliases)], state: m.state === 'connected' ? 'connected' : 'disconnected', sessionNamespace: m.session === null || m.session === undefined ? 'default' : text(m.session), runtime: null } satisfies MachineSummary;
    });
  };
  const machineValidations = new Map<MachineName, { promise: Promise<MachineSummary>; expiresAt: number | null }>();
  const machine = (on: MachineName): Promise<MachineSummary> => {
    const now = Date.now(), cached = machineValidations.get(on);
    if (cached && (cached.expiresAt === null || now < cached.expiresAt)) return cached.promise;
    for (const [name, entry] of machineValidations) if (entry.expiresAt !== null && now >= entry.expiresAt) machineValidations.delete(name);
    const promise = machines().then(rows => {
      const m = rows.find(m => m.name === on); if (!m) throw new HerdrError('machine-not-found', 'No configured machine matches on');
      const entry = machineValidations.get(on); if (entry?.promise === promise) entry.expiresAt = Date.now() + 5000;
      return m;
    }).catch(error => { if (machineValidations.get(on)?.promise === promise) machineValidations.delete(on); throw error; });
    machineValidations.set(on, { promise, expiresAt: null }); return promise;
  };
  return {
    identity, get, machines,
    read: async (address, { lines }) => {
      const reply = object(await call(['read', address, '--json', '--lines', String(lines)]));
      if (typeof reply.text !== 'string') throw new HerdrError('invalid-reply', 'Expected a terminal screen'); return reply.text;
    },
    caller: async callerEnv => {
      const core = await identity();
      if (!callerEnv.HC_TERMINAL_ID || callerEnv.HC_TERMINAL_SOCKET !== core.socket || (callerEnv.HC_SESSION || 'default') !== core.sessionNamespace)
        throw new HerdrError('caller-mismatch', 'Caller does not belong to the selected core');
      const reply = object(await call(['get', callerEnv.HC_TERMINAL_ID, '--json']));
      const terminal = parseTerminal(reply);
      if (terminal.address !== callerEnv.HC_TERMINAL_ID) throw new HerdrError('caller-mismatch', 'Returned terminal address differs from the requested address');
      if (terminal.state !== 'live' || !await processContainsCaller(reply.pid, callerEnv))
        throw new HerdrError('terminal-core-mismatch', `this process is not running inside this session's Herdr terminal (${callerEnv.HC_TERMINAL_ID}); start this session inside that terminal`);
      // Recheck identity after the process probe so a replaced core cannot be claimed.
      await identity();
      return { ...core, terminalId: callerEnv.HC_TERMINAL_ID as TerminalId, address: terminal.address };
    },
    run: async request => {
      const coreId = request.on ? (await machine(request.on)).id : (await identity()).coreId;
      if (request.on && request.parent !== undefined && request.parent !== null) throw new HerdrError('remote-parent', 'Remote launches cannot specify a parent terminal');
      const argv = ['run', '--json'];
      if (request.background) argv.push('--bg');
      if (request.name !== undefined) argv.push('--name', request.name);
      argv.push('--no-notify');
      if (request.outliveParent) argv.push('--outlive-parent');
      if (request.on) argv.push('--on', request.on);
      if (request.cwd !== null) argv.push('--cwd', request.cwd);
      if (request.parent === null) argv.push('--no-parent');
      else if (request.parent !== undefined) argv.push('--parent', request.parent);
      for (const [key, value] of Object.entries(request.labels)) argv.push('--label', `${key}=${value}`);
      argv.push('--', ...request.argv);
      return { address: text(object(await call(argv)).address) as import('../contracts.js').TerminalAddress, coreId };
    },
    kill: async address => { await call(['kill', address, '--json']); },
    rm: async address => { await call(['rm', address, '--json']); },
    setLabels: async (address, labels) => {
      const entries = Object.entries(labels);
      const allowedKeys: readonly string[] = Object.values(HERDR_LABELS);
      if (entries.length === 0 || entries.some(([key]) => !allowedKeys.includes(key)))
        throw new HerdrError('invalid-labels', 'Expected a nonempty map of canonical Herdr label keys');
      await call(['label', address, ...entries.map(([key, value]) => `${key}=${value ?? ''}`), '--json']);
    },
    fileRead: async (on, path) => { await machine(on); const reply = object(await call(['file', 'read', '--json', '--on', on, path])); if (typeof reply.text !== 'string') throw new HerdrError('invalid-reply', 'Expected text file'); return Buffer.from(reply.text); },
    fileWrite: async (on, path, bytes) => { await machine(on); await call(['file', 'write', '--json', '--on', on, path], bytes); },
    events: () => {
      if (disposal) throw new HerdrError('disposed', 'Hc client disposed');
      const source = eventStream ??= createHcEventStream({ ...options, env });
      const subscriptions = new Set<() => void>();
      let disposed = false;
      const waits = new Set<(error: Error) => void>();
      function wait<T>(promise: Promise<T>): Promise<T> {
        if (disposed) return Promise.reject(new HerdrError('disposed', 'Event view disposed'));
        return new Promise<T>((resolve, reject) => {
          waits.add(reject);
          void promise.then(value => { waits.delete(reject); resolve(value); }, error => { waits.delete(reject); reject(error); });
        });
      }
      return {
        get ready() { return wait(source.ready); },
        lookup: address => {
          if (disposed) return Promise.reject(new HerdrError('disposed', 'Event view disposed'));
          return wait(source.lookup(address));
        },
        subscribe: listener => {
          if (disposed) throw new HerdrError('disposed', 'Event view disposed');
          const unsubscribe = source.subscribe(listener);
          const remove = () => { unsubscribe(); subscriptions.delete(remove); };
          subscriptions.add(remove);
          return remove;
        },
        dispose: () => {
          if (disposed) return;
          disposed = true;
          for (const reject of waits) reject(new HerdrError('disposed', 'Event view disposed'));
          waits.clear();
          for (const remove of subscriptions) remove();
        },
      };
    },
    dispose: () => disposal ??= Promise.resolve(eventStream?.dispose()),
  };
}
