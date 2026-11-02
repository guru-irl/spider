// SPDX-License-Identifier: MIT
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HerdrHarness } from './isolated.js';
import type { TerminalAddress, TerminalId } from '../contracts.js';

export class TerminalChild extends EventEmitter {
  pid = 0;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin: PassThrough = new PassThrough();
  readonly stdout: PassThrough = new PassThrough();
  readonly stderr: PassThrough = new PassThrough();
  constructor(private readonly socket: Socket) {
    super();
    this.stdin.on('data', data => this.send({ type: 'stdin', data: data.toString('base64') }));
  }
  send(value: unknown): void { this.socket.write(JSON.stringify(value) + '\n'); }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean { this.send({ type: 'kill', signal }); return true; }
}

// The supervisor is the terminal's actual public pid. Its Node child inherits the
// terminal's HC_* values, just as a subagent spawned by pi does. No ps double runs
// in either process; the socket only carries test commands and child stdio.
export async function startTerminalChild(h: HerdrHarness, entry: string, env: NodeJS.ProcessEnv): Promise<TerminalChild> {
  const path = join(h.root, 'child.sock'), supervisor = join(h.root, 'child-parent.mjs');
  await writeFile(supervisor, `
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const socket = connect(${JSON.stringify(path)});
const send = value => socket.write(JSON.stringify(value) + '\\n');
let child;
const stop = () => { child?.kill('SIGKILL'); socket.destroy(); };
socket.on('error', stop);
socket.on('close', () => { if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL'); });
process.on('SIGTERM', stop);
for await (const line of createInterface({ input: socket })) {
  const request = JSON.parse(line);
  if (request.type === 'launch') {
    child = spawn(process.execPath, [request.entry], { env: { ...process.env, ...request.env,
      HC_TERMINAL_ID: process.env.HC_TERMINAL_ID, HC_TERMINAL_SOCKET: process.env.HC_TERMINAL_SOCKET,
      HC_SCOPE: process.env.HC_SCOPE }, stdio: ['pipe', 'pipe', 'pipe'] });
    send({ type: 'spawn', pid: child.pid, parentPid: process.pid,
      terminal: process.env.HC_TERMINAL_ID, environment: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('HC_'))) });
    child.stdout.on('data', data => send({ type: 'stdout', data: data.toString('base64') }));
    child.stderr.on('data', data => send({ type: 'stderr', data: data.toString('base64') }));
    child.on('error', error => send({ type: 'error', error: String(error) }));
    child.on('close', (code, signal) => { send({ type: 'exit', code, signal }); socket.end(); });
  } else if (request.type === 'stdin') child.stdin.write(Buffer.from(request.data, 'base64'));
  else if (request.type === 'kill') child.kill(request.signal);
}
`);
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  let child: TerminalChild | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connected = new Promise<TerminalChild>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Terminal child did not connect')), 15000);
    server.once('connection', socket => {
      child = new TerminalChild(socket);
      socket.on('error', reject);
      createInterface({ input: socket }).on('line', line => {
        const message = JSON.parse(line);
        if (message.type === 'spawn') {
          child!.pid = message.pid;
          h.owner = { ...h.owner!, terminal: { ...h.owner!.terminal, address: message.terminal as TerminalAddress, terminalId: message.terminal as TerminalId } };
          void Promise.all([h.cli(['server', 'status', '--json']), h.cli(['get', message.terminal, '--json'])]).then(async ([status, terminal]) => {
            const processes = execFileSync('ps', ['-p', `${message.pid},${message.parentPid}`, '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
            await writeFile(join(h.root, '../../', `child-topology-${h.mode}.json`), JSON.stringify({ ...message, status, terminal, processes }, null, 2));
            resolve(child!);
          }, reject).catch(reject);
        } else if (message.type === 'stdout' || message.type === 'stderr') (message.type === 'stdout' ? child!.stdout : child!.stderr).write(Buffer.from(message.data, 'base64'));
        else if (message.type === 'error') reject(new Error(message.error));
        else if (message.type === 'exit') {
          child!.exitCode = message.code; child!.signalCode = message.signal;
          child!.stdout.end(); child!.stderr.end(); child!.emit('exit', message.code, message.signal);
          socket.end();
        }
      });
      socket.on('close', () => server.close());
      child.send({ type: 'launch', entry, env });
    });
  });
  try {
    await h.hc.run({ argv: [process.execPath, supervisor], cwd: h.root, labels: {}, parent: null, outliveParent: true, background: true, noNotify: true });
    return await connected;
  } catch (error) {
    child?.kill('SIGKILL'); server.close();
    throw error;
  } finally { clearTimeout(timer); }
}
