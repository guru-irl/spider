// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TerminalAddress } from '../contracts.js';
import { connect, createServer, type Server } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname } from 'node:path';

export interface ClientFixture {
  root: string; namespace: string; localSocket: string; foreignSocket: string;
  hcBinary: string; appBinary: string; localEnv: NodeJS.ProcessEnv;
  configure(changes: Record<string, unknown>): Promise<void>;
  emitCore(record: unknown): Promise<void>;
  calls(): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }[]>;
  remoteLaunches(): Promise<{ argv: string[] }[]>;
  writeRoamFile(on: string, path: string, bytes: Buffer): Promise<void>;
  readRoamFile(on: string, path: string): Promise<Buffer>;
  removeRoamFile(on: string, path: string): Promise<void>;
  address(value: string): TerminalAddress;
  finishedTerminal(address: string, exitCode: number): Record<string, unknown>;
  listenCore(socket?: string): Promise<void>;
  stopCore(): Promise<void>;
  close(): Promise<void>;
}
export async function createClientFixture(): Promise<ClientFixture> {
  const scratch = resolve('.spider/scratch/h'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'f-'));
  const servers = new Set<Server>();
  const listenCore = async (socket: string) => {
    await mkdir(dirname(socket), { recursive: true });
    const server = createServer(connection => connection.end());
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    servers.add(server);
  };
  const stopCore = async () => { for (const server of servers) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); servers.clear(); };
  const namespace = 'fl';
  const localSocket = join(root, 's/herdr-core/fl/fl.sock');
  await listenCore(localSocket);
  const localEnv = { ...process.env, HC_SESSION: namespace, HC_TERMINAL_ID: 't1', HC_TERMINAL_SOCKET: localSocket, HC_SOCKET: localSocket,
    XDG_STATE_HOME: join(root, 's'), XDG_CONFIG_HOME: join(root, 'c'), HERDR_FAKE_ROOT: root, TMPDIR: root };
  for (const f of ['calls.jsonl', 'app-calls.jsonl', 'events.jsonl']) await writeFile(join(root, f), '');
  await writeFile(join(root, 'core.json'), JSON.stringify({ coreId: 'local-core', terminals: [terminal('t1')], machines: [] }));
  await writeFile(join(root, 'app.json'), JSON.stringify({ spaces: [] }));
  const binaries: Record<string, string> = {};
  for (const kind of ['hc', 'app']) {
    const script = fileURLToPath(new URL(`./fake-${kind}.mjs`, import.meta.url));
    const binary = join(root, kind); await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
    await chmod(binary, 0o700); binaries[kind] = binary;
  }
  const calls = async () => (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const roamFile = (on: string, path: string) => join(root, 'roam-files', Buffer.from(on).toString('hex'), Buffer.from(path).toString('hex'));
  return {
    root, namespace, localSocket, foreignSocket: join(root, 'foreign.sock'), hcBinary: binaries.hc, appBinary: binaries.app, localEnv,
    configure: async changes => { const p = join(root, 'core.json'); await writeFile(p, JSON.stringify({ ...JSON.parse(await readFile(p, 'utf8')), ...changes })); },
    emitCore: record => appendFile(join(root, 'events.jsonl'), typeof record === 'string' ? record : JSON.stringify(record) + '\n'),
    calls, remoteLaunches: async () => (await calls()).filter(c => c.argv[0] === 'run' && c.argv.includes('--on')),
    writeRoamFile: async (on, path, bytes) => { const file = roamFile(on, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes); },
    readRoamFile: (on, path) => readFile(roamFile(on, path)),
    removeRoamFile: (on, path) => rm(roamFile(on, path), { force: true }),
    address: v => v as TerminalAddress,
    finishedTerminal: (v, code) => ({ ...terminal(v), pid: null, state: 'finished', exit_code: code, reason: 'exited', finished_ms: 1234 }),
    listenCore: (socket = localSocket) => listenCore(socket), stopCore,
    close: async () => { await stopCore(); await rm(root, { recursive: true, force: true }); },
  };
}
export interface ByteDaemonFixture {
  binary: string; env: NodeJS.ProcessEnv;
  writeRemoteFile(path: string, bytes: Buffer): Promise<void>;
  readRemoteFile(path: string): Promise<Buffer>;
  configureRemote(value: Record<string, unknown>): Promise<void>;
  calls(): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }[]>;
  close(): Promise<void>;
}

export async function createByteDaemonFixture(): Promise<ByteDaemonFixture> {
  const fixture = await createClientFixture();
  const remoteRoot = join(fixture.root, 'remote');
  const remoteSocket = join(fixture.root, 'remote.sock');
  const children: { child: ChildProcess; ended: Promise<void> }[] = [];
  const stop = async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    for (const { child, ended } of children) {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      await ended; clearTimeout(timer);
    }
    await fixture.close();
  };
  const launch = async (env: NodeJS.ProcessEnv, socket: string) => {
    if (Buffer.byteLength(socket) > 103 || !socket.startsWith(fixture.root + '/')) throw new Error('Unfenced fake socket');
    const script = fileURLToPath(new URL('./fake-hc.mjs', import.meta.url));
    const child = spawn(process.execPath, [script, '--daemon'], { env, stdio: 'ignore' });
    const ended = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
    children.push({ child, ended });
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      const ready = await new Promise<boolean>(resolve => {
        const connection = connect(socket);
        connection.once('connect', () => { connection.destroy(); resolve(true); });
        connection.once('error', () => resolve(false));
      });
      if (ready) return;
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(10);
    }
    throw new Error('Fake daemon did not start');
  };
  try {
    await fixture.stopCore();
    await mkdir(remoteRoot, { recursive: true });
    for (const file of ['calls.jsonl', 'events.jsonl']) await writeFile(join(remoteRoot, file), '');
    await writeFile(join(remoteRoot, 'scenario.json'), '{}');
    await writeFile(join(remoteRoot, 'core.json'), JSON.stringify({ coreId: 'remote-core-1', terminals: [], machines: [] }));
    await writeFile(join(fixture.root, 'scenario.json'), '{}');
    await fixture.configure({ machines: [{ id: 'remote-core-1', name: 'box-1.invalid', host: 'box-1.invalid', target: 'box-1.invalid', session: 'remote', via: false, socket: remoteSocket }] });
    const base = { ...fixture.localEnv, HERDR_FAKE_DAEMON: '1', HERDR_TEST_ROOT: fixture.root, HERDR_TEST_OWNER_PID: String(process.pid) };
    const remoteEnv = { ...base, HERDR_FAKE_ROOT: remoteRoot, HC_SESSION: 'remote', HC_SOCKET: remoteSocket, HC_TERMINAL_SOCKET: remoteSocket };
    const env = { ...base, HERDR_FAKE_ROOT: fixture.root };
    await launch(remoteEnv, remoteSocket);
    await launch(env, fixture.localSocket);
    const remoteFile = (path: string) => join(remoteRoot, 'files', Buffer.from(path).toString('hex'));
    return {
      binary: fixture.hcBinary, env, calls: fixture.calls,
      writeRemoteFile: async (path, bytes) => { const file = remoteFile(path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes); },
      readRemoteFile: path => readFile(remoteFile(path)),
      configureRemote: value => writeFile(join(remoteRoot, 'scenario.json'), JSON.stringify(value)),
      close: stop,
    };
  } catch (error) { await stop(); throw error; }
}

export function terminal(address: string): Record<string, unknown> {
  // hc 0.1.16's public get JSON exposes pid, not the private HC_SCOPE token.
  // A simple client fixture models a terminal running this test's caller directly.
  return { address, parent: null, pid: process.pid, labels: {}, state: 'live', status: null, exit_code: null, reason: null, signal: null, finished_ms: null };
}

export { createHerdrHarness, proveSocketPaths, seedAppWindow } from './isolated.js';
export type { HerdrHarness, FakeScenario, FakeStep, OwnedResource } from './isolated.js';

export { runAcceptance } from './scenarios.js';
export type { AcceptanceScenario } from './scenarios.js';
