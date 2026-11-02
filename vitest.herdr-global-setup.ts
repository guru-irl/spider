// SPDX-License-Identifier: MIT
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, rm, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
let runId = '';

export function setup(): void {
  runId = randomUUID();
  process.env.SPIDER_HERDR_TEST_RUN_ID = runId;
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
async function listening(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return new Promise(resolve => {
    const socket = connect(path);
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function stopFixture(root: string, binary: string, fake: boolean): Promise<void> {
  const stop = async (side: 'l' | 'r') => {
    const socket = join(root, 'herdr-core', side, `${side}.sock`);
    if (!existsSync(socket)) return;
    if (!(await lstat(socket)).isSocket() || !(await realpath(socket)).startsWith((await realpath(root)) + '/')) throw new Error(`Not a fixture socket: ${socket}`);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('HC_') || key.startsWith('HERDR_')) delete env[key];
    delete env.XDG_RUNTIME_DIR;
    Object.assign(env, { HC_SESSION: side, HC_SOCKET: socket, XDG_STATE_HOME: root, XDG_CONFIG_HOME: join(root, side, 'c'), TMPDIR: join(root, 'tmp') });
    if (fake) Object.assign(env, { HERDR_TEST_ROOT: root, HERDR_FAKE_ROOT: join(root, side), HERDR_FAKE_DAEMON: '1', HERDR_FAKE_SCENARIO: join(root, side, 'scenario.json') });
    let pid: number | undefined, identity: string | null = null;
    try {
      const { stdout } = await exec(binary, ['server', 'status', '--json'], { env, timeout: 2500 });
      const result = JSON.parse(stdout); if (Number.isSafeInteger(result.pid) && result.pid > 0) { pid = result.pid; identity = processIdentity(pid!); }
    } catch { /* The core may already have stopped. */ }
    try { await exec(binary, ['server', 'stop', '--json'], { env, timeout: 2500 }); } catch { /* Fall back to the verified process identity. */ }
    if (pid && identity) {
      const until = Date.now() + 500;
      while (processIdentity(pid) === identity && Date.now() < until) await delay(50);
      if (processIdentity(pid) === identity) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    }
    const until = Date.now() + 3000;
    while (await listening(socket) && Date.now() < until) await delay(50);
    if (await listening(socket)) throw new Error(`Fixture core survived teardown: ${socket}`);
    if (existsSync(socket) && (await lstat(socket)).isSocket()) await unlink(socket);
  };
  await Promise.all([stop('l'), stop('r')]);
}

export async function teardown(): Promise<void> {
  const scratch = resolve('.spider/scratch/h');
  let entries: string[];
  try { entries = await readdir(scratch); } catch { return; }
  const errors: string[] = [];
  await Promise.all(entries.map(async entry => {
    const root = join(scratch, entry);
    try {
      if (!(await lstat(root)).isDirectory()) return;
      const owner = JSON.parse(await readFile(join(root, 'test-owner.json'), 'utf8'));
      if (!runId || owner.runId !== runId) return;
      const fake = owner.mode === 'fake';
      if (!['fake', 'hc', 'app'].includes(owner.mode) || typeof owner.binary !== 'string' || !isAbsolute(owner.binary) || (fake && owner.binary !== join(root, 'hc'))) throw new Error(`Invalid fixture owner: ${root}`);
      await stopFixture(root, owner.binary, fake);
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(String(error));
    }
  }));
  if (errors.length) throw new Error(`Herdr test teardown failed: ${errors.join('; ')}`);
}
