// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildHandle } from './runner';
import type { ChildSpawnSpec, SupervisorLaunch } from './pi-args';
import type { ExitInfo } from './child-registry';
import { attachRpcReader, type SteerAck } from './rpc-child';
import { isProcessAlive } from './kill-process';
import { checkProcessIdentity } from './process-identity';
import { HERDR_NOTICES } from '@spider/herdr/notices';

export interface SupervisorState extends SupervisorLaunch {
  version: 1;
  token: string;
  socket: string | { host: '127.0.0.1'; port: number };
  supervisorPid: number;
  supervisorStartTime?: string | null;
  childPid?: number;
  childStartTime?: string | null;
  ownerPid?: number | null;
  herdrTerminal?: string;
}
export function readSupervisorState(directory: string): SupervisorState | undefined {
  try {
    const state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
    if (state.version === 1 && state.directory === directory && typeof state.token === 'string'
      && (typeof state.socket === 'string' || state.socket?.host === '127.0.0.1' && Number.isInteger(state.socket.port) && state.socket.port > 0 && state.socket.port <= 65535)
      && typeof state.runId === 'string' && typeof state.dbPath === 'string'
      && typeof state.sessionId === 'string' && Number.isInteger(state.supervisorPid)) return state;
  } catch { /* not ready, removed, or inaccessible */ }
  return undefined;
}
interface SupervisorStarting { version: 1; supervisorPid: number; supervisorStartTime?: string | null; startedAt: number }
function readSupervisorStarting(directory: string): SupervisorStarting | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, 'starting.json'), 'utf8'));
    if (value.version === 1 && Number.isSafeInteger(value.supervisorPid) && value.supervisorPid > 1
      && Number.isFinite(value.startedAt) && value.startedAt > 0) return value;
  } catch { /* the supervisor has not reached its first heartbeat */ }
  return undefined;
}
export function supervisorIsAlive(state: Pick<SupervisorState, 'supervisorPid' | 'supervisorStartTime'>): boolean {
  return isProcessAlive(state.supervisorPid) && (!state.supervisorStartTime || checkProcessIdentity(state.supervisorPid, state.supervisorStartTime).matches);
}
export function supervisorEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'herdr/subagent-supervisor.mjs'), join(here, 'subagent-supervisor.mjs'), resolve(here, '../../../dist/herdr/subagent-supervisor.mjs')];
  const entry = candidates.find(existsSync);
  if (!entry) throw new Error('Subagent supervisor is not built. Run npm run build.');
  return entry;
}
function receipt(directory: string): ExitInfo | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, 'exit.json'), 'utf8'));
    if (Number.isInteger(value.exitCode) && (value.result === undefined || typeof value.result === 'string')) return value;
  } catch { /* no saved outcome yet */ }
  return undefined;
}

/** No process-global ownership. A socket can go away without affecting the child. */
export function connectDurableChild(directory: string, initialSink?: (event: Record<string, any>) => void): ChildHandle {
  let socket: Socket | undefined, sink = initialSink, detached = false, done = false, available = false, released = false;
  let unavailableReason = 'Supervisor is reconnecting.';
  let readyResolve!: () => void;
  let ready = new Promise<void>(r => { readyResolve = r; });
  let finish!: (exit: ExitInfo) => void;
  const exit = new Promise<ExitInfo>(r => { finish = r; });
  const pending = new Map<string, { resolve(value: any): void; timer: ReturnType<typeof setTimeout> }>();
  const settle = (value: ExitInfo) => {
    if (done) return; done = true; readyResolve(); clearTimeout(retry);
    for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ accepted: false, error: 'Run has finished.', delivery: 'refused' }); }
    pending.clear(); socket?.destroy(); finish(value);
  };
  let retry: ReturnType<typeof setTimeout>;
  const connect = () => {
    if (done) return;
    const saved = receipt(directory); if (saved) return settle(saved);
    if (released) { retry = setTimeout(connect, 30); retry.unref(); return; }
    const state = readSupervisorState(directory);
    if (!state) {
      const starting = readSupervisorStarting(directory);
      if (starting && Date.now() - starting.startedAt > 10000) {
        if (supervisorIsAlive(starting)) {
          try { process.kill(starting.supervisorPid, 'SIGTERM'); } catch { /* already stopped */ }
        }
        return settle({ exitCode: 1, result: HERDR_NOTICES.supervisorStartTimeout.text });
      }
      retry = setTimeout(connect, 30); if (detached) retry.unref(); return;
    }
    if (!supervisorIsAlive(state)) return settle({ exitCode: 1, result: 'Subagent supervisor exited without a saved outcome.' });
    const connection = createConnection(typeof state.socket === 'string' ? { path: state.socket } : state.socket); socket = connection;
    if (detached) connection.unref();
    let connected = false;
    connection.on('connect', () => {
      connection.write(JSON.stringify({ token: state.token, op: 'attach', ownerPid: process.pid }) + '\n');
    });
    attachRpcReader(connection, message => {
      if (message.type === 'attached') { connected = true; available = true; readyResolve(); }
      else if (message.type === 'unavailable') { unavailableReason = message.reason; available = false; readyResolve(); connection.destroy(); }
      else if (message.type === 'event') { try { sink?.(message.event); } catch { /* event observers do not own transport */ } }
      else if (message.type === 'exit') settle(message.exit);
      else if (message.type === 'reply' && typeof message.id === 'string') {
        const request = pending.get(message.id); if (!request) return;
        clearTimeout(request.timer); pending.delete(message.id); request.resolve(message.value);
      }
    }, () => connection.destroy());
    connection.on('error', () => { /* close handles reconnection */ });
    connection.on('close', () => {
      if (done || released || socket !== connection) return;
      available = false;
      // A sent steer must never be resent after a lost reply. Its delivery is unknown.
      for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ accepted: false, delivered: false, delivery: 'no reply yet, delivery unknown', error: 'Supervisor connection closed before its reply.' }); }
      pending.clear();
      // A live supervisor may still belong to an earlier parent. That is not a child failure.
      retry = setTimeout(connect, connected ? 30 : 250); if (detached) retry.unref();
    });
  };
  connect();
  const request = async (op: string, args: Record<string, unknown> = {}): Promise<any> => {
    await ready;
    const saved = receipt(directory); if (saved) settle(saved);
    if (done || !available || !socket?.writable) return { accepted: false, delivered: false, delivery: 'refused', error: done ? 'Run has finished.' : unavailableReason };
    const state = readSupervisorState(directory);
    if (!state) return { accepted: false, delivery: 'refused', error: 'Supervisor identity is unavailable.' };
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ accepted: false, delivered: false, delivery: 'no reply yet, delivery unknown', error: 'No supervisor reply. Do not resend.' }); }, 15000);
      if (detached) timer.unref(); pending.set(id, { resolve, timer });
      socket!.write(JSON.stringify({ token: state.token, id, op, ...args }) + '\n');
    });
  };
  return {
    durable: true,
    wait: () => exit,
    steer: (message: string): Promise<SteerAck> => request('steer', { message }),
    kill(reason = 'Explicit stop') { void request('stop', { reason }); },
    async killAsync(graceMs = 250, reason = 'Explicit stop') {
      const ack = await request('stop', { reason, graceMs });
      if (ack.error && !done) throw new Error(ack.error);
      await exit;
    },
    bindEvents(next) {
      sink = next;
      if (released && !done) {
        released = false; clearTimeout(retry);
        ready = new Promise<void>(r => { readyResolve = r; });
        connect();
      }
    },
    unbindEvents() { sink = undefined; },
    release() {
      released = true; available = false; sink = undefined;
      unavailableReason = 'The parent released this subagent.';
      clearTimeout(retry); socket?.destroy(); readyResolve();
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.resolve({ accepted: false, delivered: false, delivery: 'no reply yet, delivery unknown', error: unavailableReason });
      }
      pending.clear();
      if (!done) { retry = setTimeout(connect, 30); retry.unref(); }
    },
    detach() { detached = true; socket?.unref(); retry?.unref(); },
  };
}

export function spawnDurableChild(spec: ChildSpawnSpec): ChildHandle {
  const launch = spec.supervisor!;
  mkdirSync(launch.directory, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  const request = join(launch.directory, 'request.json');
  writeFileSync(request, JSON.stringify({ ...spec, onRpcEvent: undefined, supervisor: { ...launch, token } }), { mode: 0o600, flag: 'wx' });
  const logPath = join(launch.directory, 'supervisor.log');
  const log = openSync(logPath, 'a', 0o600);
  try {
    const launcherSource = `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,[process.argv[1],process.argv[2],String(process.pid)],{detached:true,stdio:'inherit',windowsHide:true});
child.on('error',error=>{console.error(error);process.exitCode=1});child.unref();`;
    const hostedSource = `import {spawn} from 'node:child_process';import{openSync,closeSync}from'node:fs';import{dirname}from'node:path';
const log=openSync(process.argv[3],'a',0o600);
const child=spawn(process.execPath,[process.argv[1],process.argv[2]],{detached:true,stdio:['ignore',log,log],windowsHide:true,env:{...process.env,TMPDIR:dirname(process.argv[2])}});closeSync(log);
child.on('error',error=>{console.error(error);process.exitCode=1});child.on('close',code=>{process.exitCode=code??1});`;
    const entry = launch.entry ?? supervisorEntry();
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: launch.directory };
    // Herdr also signals processes carrying the closing terminal's HC_SCOPE, even after setsid.
    // A core-owned holder supplies a new identity and remains alive for caller attestation.
    // Outside Herdr, a short-lived launcher reparents the supervisor and carries no terminal identity.
    if (!launch.hcBinary) { delete env.HC_TERMINAL_ID; delete env.HC_TERMINAL_SOCKET; delete env.HC_SCOPE; }
    const argv = launch.hcBinary
      ? ['run', '--bg', '--no-notify', '--outlive-parent', '--no-parent', '--rm', '--json', '--cwd', spec.cwd, '--', process.execPath, '--input-type=module', '-e', hostedSource, entry, request, logPath]
      : ['--input-type=module', '-e', launcherSource, entry, request];
    const launcher = spawn(launch.hcBinary ?? process.execPath, argv, {
      cwd: spec.cwd, env, stdio: ['ignore', log, log], detached: true, windowsHide: true,
    });
    launcher.on('error', () => { /* the client reports missing state and outcome */ }); launcher.unref();
  } finally { closeSync(log); }
  return connectDurableChild(launch.directory, spec.onRpcEvent);
}
