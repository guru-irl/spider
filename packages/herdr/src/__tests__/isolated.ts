// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, writeFile, readFile, access, chmod, rm, stat, unlink, rename } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync, openSync, closeSync } from 'node:fs';
import { connect } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { vi } from 'vitest';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { AcceptanceMode, HcClient, AppClient, CoreId, TestIsolationProof, Owner, SessionId, Generation } from '../contracts.js';
import { createHcClient } from '../client/hc.js';
import { invokeCli } from '../client/cli-transport.js';
import { createAppClient } from '../client/app.js';
import { HerdrError, object, text, selectedSocket } from '../client/parse.js';

const syntheticInventories = new Map<string, () => readonly { address: string; pid?: number | null }[]>();
let syntheticPs: ReturnType<typeof vi.spyOn> | undefined;
function syntheticCaller(socket: string, inventory: () => readonly { address: string; pid?: number | null }[]): () => void {
  syntheticInventories.set(socket, inventory);
  if (!syntheticPs) {
    const original = childProcess.execFile;
    syntheticPs = vi.spyOn(childProcess, 'execFile').mockImplementation(((file: string, argv: string[], options: { env?: NodeJS.ProcessEnv }, callback: Function) => {
      const env = options?.env;
      if (file === 'ps' && argv.join(' ') === '-eo pid=,ppid=' && env?.HERDR_TEST_SYNTHETIC_CALLER === String(process.pid)) {
        const terminal = syntheticInventories.get(env.HC_SOCKET ?? '')?.().find(t => t.address === env.HC_TERMINAL_ID);
        if (terminal?.pid) {
          queueMicrotask(() => callback(null, `${process.pid} ${terminal.pid}\n${terminal.pid} 0\n`, ''));
          return {} as ReturnType<typeof childProcess.execFile>;
        }
      }
      return (original as Function)(file, argv, options, callback);
    }) as unknown as typeof childProcess.execFile);
  }
  return () => { syntheticInventories.delete(socket); if (!syntheticInventories.size) { syntheticPs?.mockRestore(); syntheticPs = undefined; } };
}

export interface FakeStep {
  argvPrefix?: string[]; argvIncludes?: string[]; once?: boolean; reply?: unknown; stderr?: unknown; exitCode?: number;
  delayMs?: number; beforeReply?: unknown[]; writes?: Record<string, string>;
}
export interface FakeScenario {
  steps?: FakeStep[]; events?: ({ record: unknown; delayMs?: number } | Record<string, unknown>)[];
  files?: Record<string, string | { base64: string }>; machineSocket?: string;
  app?: { holdAdoption?: boolean; adoptionDelayMs?: number }; [key: string]: unknown;
}
export interface OwnedResource { kind: string; id: string; pid?: number }
export interface HerdrHarness {
  mode: AcceptanceMode; root: string; namespace: string; hcBinary: string; appBinary: string; sshBinary: string; nodeBinary: string;
  localSocket: string; remoteSocket: string; foreignSocket: string; localEnv: NodeJS.ProcessEnv; remoteEnv: NodeJS.ProcessEnv;
  localCoreId: CoreId | null; remoteCoreId: CoreId | null; hc: HcClient; remoteHc: HcClient; app: AppClient; owner: Owner | null;
  directories: { local: string; remote: string; app: string; agent: string; global: string; tmp: string };
  start(): Promise<void>; close(): Promise<void>; remainingOwnedResources(): Promise<OwnedResource[]>;
  inventory(): Promise<OwnedResource[]>; mutations(): readonly string[]; withUnprovedSocket(): HerdrHarness;
  trackProcess(pid: number): void;
  scenario(value: FakeScenario, side?: 'local' | 'remote'): Promise<void>; emitCore(event: unknown, side?: 'local' | 'remote'): Promise<void>;
  calls(side?: 'local' | 'remote'): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }[]>;
  cli(argv: string[], side?: 'local' | 'remote'): Promise<unknown>; cleanupProof: unknown;
}
function processIdentity(pid: number): string | null {
  try {
    process.kill(pid, 0);
    if (process.platform === 'win32') return String(pid);
    const value = execFileSync('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' }).trim();
    const space = value.indexOf(' ');
    return space < 0 || value.startsWith('Z') ? null : value.slice(space).trim();
  } catch { return null; }
}
function defaultIdentity(): string | null {
  const path = join(homedir(), '.local/state/herdr-core/default/core.json');
  try { return text(object(JSON.parse(readFileSync(path, 'utf8'))).id); } catch { return null; }
}
export function proveSocketPaths(root: string, sockets: readonly string[]): void {
  const all = sockets.flatMap(path => path.includes('/herdr-core/') ? [path, path.replace(/\.sock$/, '.holder.ffffffff.sock')] : [path]);
  for (const path of all) {
    if (!path.startsWith(root + '/') || path === join(homedir(), '.local/state/herdr-core/default/default.sock')) throw new HerdrError('isolation-unproved', 'Socket is not test-owned');
    if (Buffer.byteLength(path, 'utf8') > 103) throw new HerdrError('socket-path-too-long', 'Use a shorter test root; the full socket path exceeds 103 UTF-8 bytes');
  }
}
export async function createHerdrHarness(mode: AcceptanceMode): Promise<HerdrHarness> {
  if (mode !== 'fake' && process.env.SPIDER_HERDR_E2E !== '1') throw new HerdrError('real-mode-not-enabled', 'Set SPIDER_HERDR_E2E=1 for real isolated hc');
  if (mode === 'app' && process.env.SPIDER_HERDR_APP_E2E !== '1') throw new HerdrError('real-mode-not-enabled', 'Set SPIDER_HERDR_APP_E2E=1 for the fenced app');
  if (mode === 'app' && process.env.SPIDER_HERDR_APP_TESTS !== '1') throw new HerdrError('app-launch-disabled', 'Real app windows require the user opt-in SPIDER_HERDR_APP_TESTS=1');
  if (mode === 'app' && !process.env.SPIDER_HERDR_TEST_DISPLAY_UUID) throw new HerdrError('app-display-required', 'SPIDER_HERDR_TEST_DISPLAY_UUID is required for real app tests');
  const realHc = process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc');
  const realApp = process.env.SPIDER_HERDR_APP_BINARY || join(homedir(), '.local/bin/herdr-app');
  if (mode !== 'fake') { try { await access(realHc); if (mode === 'app') await access(realApp); } catch { throw new HerdrError('missing-binary', 'Explicit real mode requires installed hc and app binaries'); } }
  const scratch = resolve('.spider/scratch/h'); await mkdir(scratch, { recursive: true });
  let root = '';
  for (let tries = 0; tries < 4096; tries++) {
    const candidate = join(scratch, (randomBytes(2).readUInt16BE() % 1296).toString(36).padStart(2, '0'));
    try { await mkdir(candidate, { mode: 0o700 }); root = candidate; break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  if (!root) throw new HerdrError('fixture-collision', 'No short owned fixture directory is available');
  const runId = process.env.SPIDER_HERDR_TEST_RUN_ID;
  if (runId) await writeFile(join(root, 'test-owner.json'), JSON.stringify({ runId, mode, binary: mode === 'fake' ? join(root, 'hc') : realHc }));
  const directories = { local: join(root, 'l'), remote: join(root, 'r'), app: join(root, 'a'), agent: join(root, 'p'), global: join(root, 'g'), tmp: join(root, 'tmp') };
  for (const path of Object.values(directories)) await mkdir(path, { recursive: true });
  await writeFile(join(directories.global, 'config.json'), JSON.stringify({ organism: { enabled: false } }));
  const base = { ...process.env, TMPDIR: directories.tmp, PI_CODING_AGENT_DIR: directories.agent, SPIDER_GLOBAL_ROOT: directories.global };
  for (const key of Object.keys(base)) if (key.startsWith('HC_') || key.startsWith('HERDR_') || key.startsWith('PI_SUBAGENT_') || key.startsWith('PI_SPIDER_')) delete (base as NodeJS.ProcessEnv)[key];
  const localEnv: NodeJS.ProcessEnv = { ...base, HC_SESSION: 'l', HC_SOCKET: join(root, 'herdr-core/l/l.sock'), XDG_STATE_HOME: root, XDG_CONFIG_HOME: join(directories.local, 'c') };
  const remoteEnv: NodeJS.ProcessEnv = { ...base, HC_SESSION: 'r', HC_SOCKET: join(root, 'herdr-core/r/r.sock'), XDG_STATE_HOME: root, XDG_CONFIG_HOME: join(directories.remote, 'c') };
  // Unit-test supervisors are synthetic owners, not descendants of their hc terminals.
  // A separate real in-terminal probe runs without this explicit marker or double.
  localEnv.HERDR_TEST_SYNTHETIC_CALLER = remoteEnv.HERDR_TEST_SYNTHETIC_CALLER = String(process.pid);
  const localSocket = selectedSocket(localEnv), remoteSocket = selectedSocket(remoteEnv), appSocket = join(directories.app, 'herdr-app.sock');
  const stopSynthetic = [localEnv, remoteEnv].map(env => syntheticCaller(selectedSocket(env), () => {
    try {
      const path = mode === 'fake' ? join(env === localEnv ? directories.local : directories.remote, 'core.json') : join(root, 'herdr-core', env.HC_SESSION!, 'terminals.json');
      const state = JSON.parse(readFileSync(path, 'utf8'));
      return Array.isArray(state.terminals) ? state.terminals : Object.values(state.terminals ?? {}) as { address: string; pid?: number | null }[];
    } catch { return []; }
  }));
  proveSocketPaths(root, [localSocket, remoteSocket, appSocket]);
  let hcBinary = realHc, appBinary = realApp;
  const quoted = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
  const wrapper = async (name: string, content: string) => { const path = join(root, name); await writeFile(path, '#!/bin/sh\n' + content + '\n'); await chmod(path, 0o700); return path; };
  if (mode === 'fake') {
    hcBinary = await wrapper('hc', `exec ${quoted(process.execPath)} ${quoted(fileURLToPath(new URL('./fake-hc.mjs', import.meta.url)))} "$@"`);
    appBinary = await wrapper('app', `exec ${quoted(process.execPath)} ${quoted(fileURLToPath(new URL('./fake-app.mjs', import.meta.url)))} "$@"`);
    for (const [env, dir] of [[localEnv, directories.local], [remoteEnv, directories.remote]] as const) {
      env.HERDR_TEST_ROOT = root; env.HERDR_TEST_OWNER_PID = String(process.pid); env.HERDR_FAKE_ROOT = dir; env.HERDR_FAKE_DAEMON = '1'; env.HERDR_FAKE_SCENARIO = join(dir, 'scenario.json');
      await writeFile(join(dir, 'core.json'), JSON.stringify({ coreId: randomUUID(), terminals: [], machines: [] }));
      for (const f of ['calls.jsonl', 'events.jsonl']) await writeFile(join(dir, f), ''); await writeFile(join(dir, 'scenario.json'), '{}');
    }
    localEnv.HERDR_FAKE_REMOTE_SOCKET = remoteSocket;
    await writeFile(join(directories.local, 'app.json'), JSON.stringify({ spaces: [] })); await writeFile(join(directories.local, 'app-calls.jsonl'), '');
  }
  localEnv.PATH = `${root}:${dirname(hcBinary)}:${dirname(process.execPath)}:${localEnv.PATH || ''}`;
  remoteEnv.PATH = `${root}:${dirname(hcBinary)}:${dirname(process.execPath)}:${remoteEnv.PATH || ''}`;
  for (const env of [localEnv, remoteEnv]) { await mkdir(join(env.XDG_CONFIG_HOME!, 'herdr-core'), { recursive: true }); await writeFile(join(env.XDG_CONFIG_HOME!, 'herdr-core/config.toml'), 'notes = false\n'); }
  const sshBinary = await wrapper('ssh', `exec ${quoted(process.execPath)} ${quoted(fileURLToPath(new URL('./fake-via.mjs', import.meta.url)))} --ssh ${quoted(join(directories.local, 'scenario.json'))} ${quoted(join(root, 'ssh-calls.jsonl'))} "$@"`);
  const descriptor = join(root, 'via.json');
  await writeFile(descriptor, JSON.stringify({ root, env: remoteEnv, log: join(root, 'via.log') }));
  const viaBinary = await wrapper('via', `exec ${quoted(process.execPath)} ${quoted(fileURLToPath(new URL('./fake-via.mjs', import.meta.url)))} ${quoted(descriptor)} "$@"`);
  const clients = new Set<ReturnType<typeof createHcClient>>(); const mutationLog: string[] = []; const pids = new Map<number, string>(); let started = false; let closed = false;
  const track = (pid: number) => { const identity = processIdentity(pid); if (identity) pids.set(pid, identity); };
  const owned = (pid: number, identity: string) => processIdentity(pid) === identity;
  const defaultBefore = defaultIdentity();
  const ownClient = (env: NodeJS.ProcessEnv, isolationProof?: TestIsolationProof): HcClient => {
    const client = createHcClient({ binary: hcBinary, env, isolationProof });
    clients.add(client); return client;
  };
  let appProcess: ReturnType<typeof spawn> | undefined;
  const h: HerdrHarness = {
    mode, root, namespace: 'l', hcBinary, appBinary, sshBinary, nodeBinary: process.execPath, localSocket, remoteSocket, foreignSocket: '/unproved/socket', localEnv, remoteEnv,
    localCoreId: null, remoteCoreId: null, directories, hc: ownClient(localEnv), remoteHc: ownClient(remoteEnv), app: createAppClient({ binary: appBinary, env: { ...localEnv, HERDR_APP_HOME: directories.app } }), owner: null, cleanupProof: null,
    mutations: () => [...mutationLog],
    trackProcess: track,
    withUnprovedSocket: () => ({ ...h, start: async () => { proveSocketPaths(root, [h.foreignSocket, remoteSocket]); } }),
    scenario: async (value, side = 'local') => {
      const path = join(side === 'local' ? directories.local : directories.remote, 'scenario.json');
      const temporary = `${path}.${randomUUID()}.new`;
      try {
        await writeFile(temporary, JSON.stringify({ ...value, fixtureRevision: randomUUID() }), { flag: 'wx' });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    },
    emitCore: async (event, side = 'local') => { const dir = side === 'local' ? directories.local : directories.remote; const path = join(dir, 'events.jsonl'); const bytes = await readFile(path); await writeFile(path, Buffer.concat([bytes, Buffer.from(JSON.stringify(event) + '\n')])); },
    calls: async (side = 'local') => { const dir = side === 'local' ? directories.local : directories.remote; const lines = await readFile(join(dir, 'calls.jsonl'), 'utf8').catch(() => ''); return lines.split('\n').filter(Boolean).map(line => JSON.parse(line)); },
    cli: async (args, side = 'local') => {
      const env = side === 'local' ? localEnv : remoteEnv;
      if (['run', 'kill', 'rm', 'label'].includes(args[0]) || (args[0] === 'server' && args[1] !== 'status') || (args[0] === 'machine' && args[1] !== 'ls') || (args[0] === 'file' && args[1] !== 'read')) mutationLog.push(`${side}:${args.join(' ')}`);
      return invokeCli(hcBinary, args, env, 8 * 1024 * 1024);
    },
    start: async () => {
      if (started) return; if (closed) throw new HerdrError('disposed', 'Harness is closed');
      proveSocketPaths(root, [localSocket, remoteSocket, appSocket]);
      try {
        for (const side of ['local', 'remote'] as const) {
          await h.cli(['server', 'start', '--json'], side);
          const result = object(await h.cli(['server', 'status', '--json'], side)); if (typeof result.pid === 'number') track(result.pid);
        }
        const local = await h.hc.identity(), remote = await h.remoteHc.identity();
        if (local.socket !== localSocket || remote.socket !== remoteSocket || local.coreId === remote.coreId || !(await stat(localSocket)).isSocket() || !(await stat(remoteSocket)).isSocket()) throw new HerdrError('isolation-unproved', 'Both sockets and independent core IDs must be proved');
        h.localCoreId = local.coreId; h.remoteCoreId = remote.coreId;
        const proof: TestIsolationProof = { checkout: process.cwd(), sessionNamespace: local.sessionNamespace, coreIds: [local.coreId, remote.coreId], sockets: [local.socket, remote.socket] };
        h.hc = ownClient(localEnv, proof); h.remoteHc = ownClient(remoteEnv, { ...proof, sessionNamespace: remote.sessionNamespace });
        await h.cli(['machine', 'add', '--via', viaBinary, '--name', 'remote.invalid', '--session', 'r', '--json']);
        const machine = (await h.hc.machines()).find(m => m.name === 'remote.invalid'); if (machine?.id !== remote.coreId) throw new HerdrError('isolation-unproved', 'Fake machine must route to the proved remote core');
        const handle = await h.hc.run({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: root, labels: {}, parent: null, outliveParent: true, background: true, noNotify: true });
        localEnv.HC_TERMINAL_ID = handle.address; localEnv.HC_TERMINAL_SOCKET = localSocket; h.hc = ownClient(localEnv, proof);
        const terminal = await h.hc.caller(localEnv);
        h.owner = { sessionId: randomUUID() as SessionId, generation: randomUUID() as Generation, terminal, cwd: root, sessionFile: null, name: 'fixture' };
        if (mode === 'fake') await writeFile(join(directories.local, 'app.json'), JSON.stringify({ spaces: [{ id: 's1', name: 'Fixture', tabs: [{ id: 'tb1', name: 'Owner', terminals: [{ terminal: handle.address, pane: 'p1' }] }] }] }));
        if (mode === 'app') {
          const coreWrapper = await wrapper('app-core', Object.entries(localEnv).filter(([k, v]) => v !== undefined && ['HC_SESSION', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'PATH'].includes(k)).map(([k, v]) => `export ${k}=${quoted(v!)}`).join('\n') + `\nunset HC_TERMINAL_ID HC_TERMINAL_SOCKET HC_SCOPE\nprintf '%s\\n' "$*" >> ${quoted(join(root, 'app-core-calls.txt'))}\nexec ${quoted(hcBinary)} "$@"`);
          await seedAppWindow(directories.app, process.env.SPIDER_HERDR_TEST_DISPLAY_UUID);
          await writeFile(join(directories.app, 'settings.json'), JSON.stringify({ core: coreWrapper }));
          const appEnv: NodeJS.ProcessEnv = { ...localEnv, HERDR_APP_HOME: directories.app }; delete appEnv.HC_TERMINAL_ID; delete appEnv.HC_TERMINAL_SOCKET;
          const settings = object(JSON.parse(await readFile(join(directories.app, 'settings.json'), 'utf8')));
          if (settings.core !== coreWrapper) throw new HerdrError('isolation-unproved', 'App core executable is not fenced');
          let prelaunchFailed = false; try { await invokeCli(appBinary, ['status'], appEnv); } catch { prelaunchFailed = true; }
          if (!prelaunchFailed || existsSync(appSocket)) throw new HerdrError('isolation-unproved', 'Fenced app socket must not exist before launch');
          const log = openSync(join(root, 'app.log'), 'a'); appProcess = spawn(appBinary, [], { env: appEnv, stdio: ['ignore', log, log] }); closeSync(log); if (appProcess.pid) track(appProcess.pid);
          h.app = createAppClient({ binary: appBinary, env: appEnv }); const deadline = Date.now() + 10000;
          while (!existsSync(appSocket) && Date.now() < deadline) await delay(50);
          if (!(await stat(appSocket)).isSocket()) throw new HerdrError('isolation-unproved', 'Fenced app did not create its owned socket');
          const calls = await readFile(join(root, 'app-core-calls.txt'), 'utf8'); if (!calls.includes('connect')) throw new HerdrError('isolation-unproved', 'App did not use its fenced core executable');
          let placed = await h.app.command('space.new', { name: 'Fixture', folder: root, tab: 'Owner', argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'] });
          const readyDeadline = Date.now() + 10000;
          while (placed.error?.message === "This machine's layout is unavailable. Try again when it reconnects." && Date.now() < readyDeadline) {
            await delay(50); placed = await h.app.command('space.new', { name: 'Fixture', folder: root, tab: 'Owner', argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'] });
          }
          if (placed.error || !placed.terminal) throw new HerdrError('isolation-unproved', 'App did not create an owned fixture terminal');
          localEnv.HC_TERMINAL_ID = placed.terminal; h.hc = ownClient(localEnv, proof);
          h.owner = { ...h.owner!, terminal: await h.hc.caller(localEnv) };
          const placementDeadline = Date.now() + 10000;
          while (true) { try { await h.app.ownerPlacement(placed.terminal); break; } catch (error) { if (Date.now() >= placementDeadline) throw error; await delay(50); } }
        }
        started = true;
      } catch (error) { await h.close().catch(() => {}); throw error; }
    },
    inventory: async () => {
      if (closed) return h.remainingOwnedResources();
      const resources: OwnedResource[] = [];
      for (const side of ['local', 'remote'] as const) {
        const socket = side === 'local' ? localSocket : remoteSocket; if (!existsSync(socket)) continue;
        resources.push({ kind: 'core-socket', id: socket });
        const rows = object(await h.cli(['ls', '--all', '--json'], side)).terminals; if (!Array.isArray(rows)) throw new HerdrError('invalid-reply', 'Invalid terminal inventory');
        for (const row of rows) { const t = object(row); resources.push({ kind: 'terminal', id: `${side}:${text(t.address)}`, ...(typeof t.pid === 'number' ? { pid: t.pid } : {}) }); }
      }
      return resources;
    },
    remainingOwnedResources: async () => {
      const remaining: OwnedResource[] = [];
      for (const socket of [localSocket, remoteSocket, appSocket]) if (existsSync(socket)) remaining.push({ kind: 'socket', id: socket });
      for (const [pid, identity] of pids) if (owned(pid, identity)) remaining.push({ kind: 'process', id: String(pid), pid });
      if (defaultIdentity() !== defaultBefore) remaining.push({ kind: 'default-core-changed', id: 'default' });
      return remaining;
    },
    close: async () => {
      if (closed) return;
      const observed: Record<string, unknown> = {};
      let cleanupError: unknown;
      try {
      if (appProcess) { try { await h.app.command('window.close', {}); } catch {} if (appProcess.exitCode === null && appProcess.signalCode === null) { const exit = new Promise<void>(resolve => appProcess!.once('close', () => resolve())); appProcess.kill('SIGTERM'); await exit; }
        if (existsSync(appSocket)) {
          const listening = await new Promise<boolean>(resolve => { const socket = connect(appSocket); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
          if (listening) throw new HerdrError('cleanup-unproved', 'An owned app socket still has a listener');
          await unlink(appSocket);
        }
      }
      const viaLog = await readFile(join(root, 'via.log'), 'utf8').catch(() => '');
      for (const line of viaLog.split('\n').filter(Boolean)) { const entry = object(JSON.parse(line)); if (typeof entry.pid === 'number') track(entry.pid); if (typeof entry.childPid === 'number') track(entry.childPid); }
      for (const client of clients) await client.dispose(); clients.clear();
      for (const side of ['local', 'remote'] as const) {
        const socket = side === 'local' ? localSocket : remoteSocket; if (!existsSync(socket)) continue;
        const result = object(await h.cli(['ls', '--all', '--json'], side)).terminals; if (!Array.isArray(result)) throw new HerdrError('cleanup-unproved', 'Invalid cleanup inventory');
        for (const row of result) {
          const t = object(row); if (typeof t.pid === 'number') track(t.pid);
          const address = text(t.address); if (side === 'local' && address.includes('/')) continue;
          const absent = (error: unknown) => { if (!(error instanceof HerdrError) || error.code !== 'not_found') throw error; };
          if (t.state === 'live') await h.cli(['kill', address, '--json'], side).catch(absent);
          await h.cli(['rm', address, '--json'], side).catch(absent);
        }
        observed[`${side}Terminals`] = object(await h.cli(['ls', '--all', '--json'], side)).terminals;
      }
      if (existsSync(localSocket)) { const machines = object(await h.cli(['machine', 'ls', '--json'])).machines; if (Array.isArray(machines) && machines.some(m => object(m).name === 'remote.invalid')) await h.cli(['machine', 'rm', 'remote.invalid', '--json']); observed.machines = object(await h.cli(['machine', 'ls', '--json'])).machines; }
      // Removing the machine clears local remote mirrors. Both independent cores must now be empty.
      if (existsSync(localSocket)) observed.localTerminals = object(await h.cli(['ls', '--all', '--json'])).terminals;
      for (const key of ['localTerminals', 'remoteTerminals', 'machines']) if (observed[key] !== undefined && (!Array.isArray(observed[key]) || (observed[key] as unknown[]).length)) throw new HerdrError('cleanup-unproved', 'Owned core or machine inventory is not empty', observed);
      } catch (error) { cleanupError = error; }
      finally {
        for (const client of clients) { try { await client.dispose(); } catch (error) { cleanupError ??= error; } }
        clients.clear();
        for (const side of ['local', 'remote'] as const) {
          if (!existsSync(side === 'local' ? localSocket : remoteSocket)) continue;
          try { await h.cli(['server', 'stop', '--json'], side); } catch (error) { cleanupError ??= error; }
        }
        const deadline = Date.now() + 1000;
        while ((await h.remainingOwnedResources()).length && Date.now() < deadline) await delay(50);
        for (const [pid, identity] of pids) if (owned(pid, identity)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
        const stopped = Date.now() + 5000;
        while ((await h.remainingOwnedResources()).some(r => r.kind === 'process') && Date.now() < stopped) await delay(50);
        for (const socketPath of [localSocket, remoteSocket, appSocket]) {
          if (!existsSync(socketPath)) continue;
          const listening = await new Promise<boolean>(resolve => { const socket = connect(socketPath); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
          if (!listening) await unlink(socketPath).catch(() => {});
        }
        const remaining = await h.remainingOwnedResources();
        if (remaining.length) cleanupError ??= new HerdrError('cleanup-unproved', 'Owned resources survived cleanup', remaining);
        else {
          h.cleanupProof = { mode, localSocket, remoteSocket, localCoreId: h.localCoreId, remoteCoreId: h.remoteCoreId, observed, remaining, defaultCoreUnchanged: defaultIdentity() === defaultBefore };
          await writeFile(join(scratch, `cleanup-${root.split('/').at(-1)}.json`), JSON.stringify(h.cleanupProof, null, 2));
          closed = true; await rm(root, { recursive: true, force: true });
        }
      }
      for (const stop of stopSynthetic) stop();
      if (cleanupError) throw cleanupError;
    },
  };
  return h;
}

export async function seedAppWindow(home: string, displayUuid?: string): Promise<void> {
  if (!displayUuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(displayUuid)) throw new HerdrError('app-display-required', 'An explicit display UUID is required');
  const suffix = relative(realpathSync(resolve('.spider/scratch/h')), realpathSync(home));
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) throw new HerdrError('isolation-unproved', 'App home must be test-owned');
  const path = join(home, 'window.json');
  if (existsSync(path) && realpathSync(path) !== resolve(path)) throw new HerdrError('isolation-unproved', 'Window state must not be a symlink');
  await writeFile(path, JSON.stringify({ state: 'windowed', bounds: [40, 40, 1400, 900], display: displayUuid }), { mode: 0o600 });
}
