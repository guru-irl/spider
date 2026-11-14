import { afterAll, afterEach, it } from 'vitest';
import type { EventEmitter } from 'node:events';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnOptionsWithStdioTuple, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, basename } from 'node:path';
const base = resolve('.spider/scratch');
const scratch = resolve(process.env.SPIDER_TEST_RUN_ROOT || join(base, 'i'));
const relativeRoot = relative(base, scratch);
if (!relativeRoot || relativeRoot.startsWith('..') || isAbsolute(relativeRoot)) throw new Error('Test run requires a scratch-owned root');
mkdirSync(scratch, { recursive: true });
fixturePath(scratch);
const agent = mkdtempSync(join(scratch, 'a-'));
const records = join(scratch, 'p');
mkdirSync(records, { recursive: true, mode: 0o700 });
const prior = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agent;
interface Ownership { pid: number; startIdentity: string; lifetime: 'test' | 'suite'; record: string; name: string }
const brokers = new Map<ChildProcess, Ownership>();
/** Native process birth identity, never command-line matching or a signal-0 probe. */
export function readTestProcessStart(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process identity');
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const started = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
      if (!started || !/^\d+$/.test(started)) throw new Error('Invalid native process start identity');
      return `linux:${started}`;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  const query = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `try { [Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks } catch { exit 1 }`], { encoding: 'utf8', timeout: 1000 })
    : spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  if (query.error) throw query.error;
  if (query.status === 1 && !query.stdout.trim()) return null;
  if (query.status !== 0 || !query.stdout.trim()) throw new Error('Cannot read native process start identity');
  return `${process.platform === 'win32' ? 'windows' : 'ps'}:${query.stdout.trim()}`;
}
export function getTestBrokerOwnership(child: ChildProcess): Readonly<Pick<Ownership, 'pid' | 'startIdentity'>> | null {
  const owned = brokers.get(child);
  return owned ? Object.freeze({ pid: owned.pid, startIdentity: owned.startIdentity }) : null;
}
function isAlive(child: ChildProcess): boolean {
  const owned = brokers.get(child);
  return Boolean(owned && child.pid === owned.pid && child.exitCode === null && child.signalCode === null && readTestProcessStart(owned.pid) === owned.startIdentity);
}
function save(owned: Ownership, state: 'spawned' | 'exited'): void {
  const { record, ...metadata } = owned;
  writeFileSync(record, JSON.stringify({ ...metadata, state }), { mode: 0o600 });
}
function fixturePath(value: string | undefined): void {
  if (!value) throw new Error('Test broker requires explicit fixture roots');
  const path = relative(base, resolve(value));
  if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error('Test broker refuses non-fixture roots');
  let cursor = base;
  for (const component of ['.', ...path.split(/[\\/]/)]) {
    cursor = join(cursor, component);
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) throw new Error('Test broker refuses symlinked or unowned fixture roots');
  }
}
export function startTestBroker(command: string, args: readonly string[], options: SpawnOptionsWithStdioTuple<'pipe', 'pipe', 'pipe'>, lifetime?: 'test' | 'suite'): ChildProcessWithoutNullStreams;
export function startTestBroker(command: string, args: readonly string[], options: SpawnOptions, lifetime?: 'test' | 'suite'): ChildProcess;
export function startTestBroker(command: string, args: readonly string[], options: SpawnOptions, lifetime: 'test' | 'suite' = 'test'): ChildProcess {
  fixturePath(options.env?.PI_CODING_AGENT_DIR);
  fixturePath(options.env?.HOME);
  // Fail before spawn if this host cannot establish native process identities.
  if (!readTestProcessStart(process.pid)) throw new Error('Cannot establish test process ownership');
  const child = spawn(command, args, { ...options, detached: false });
  if (!child.pid) { child.once('error', () => {}); throw new Error('Test broker did not start'); }
  const startIdentity = readTestProcessStart(child.pid);
  if (!startIdentity) throw new Error('Test broker exited before ownership was recorded');
  const owned: Ownership = { pid: child.pid, startIdentity, lifetime, record: join(records, `${child.pid}-${randomUUID()}.json`), name: basename(command) };
  brokers.set(child, owned);
  save(owned, 'spawned');
  child.once('exit', () => save(owned, 'exited'));
  return child;
}
export async function stopTestBroker(child: ChildProcess): Promise<void> {
  if (!brokers.has(child)) throw new Error('Refusing to signal an unowned broker');
  if (isAlive(child)) {
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => { clearTimeout(timer); child.off('exit', finish); child.off('error', fail); resolve(); };
      const fail = (error: Error) => { clearTimeout(timer); child.off('exit', finish); reject(error); };
      child.once('exit', finish); child.once('error', fail);
      timer = setTimeout(() => {
        if (isAlive(child)) child.kill('SIGKILL');
        timer = setTimeout(() => fail(new Error(`test broker survived teardown: ${child.pid}`)), 500);
      }, 500);
      child.kill('SIGTERM');
    });
  }
  if (isAlive(child)) throw new Error(`test broker survived teardown: ${child.pid}`);
}
export function assertNoTestBrokers(lifetime?: 'test' | 'suite'): void {
  for (const [child, owned] of brokers) {
    if ((!lifetime || owned.lifetime === lifetime) && isAlive(child)) throw new Error(`test broker survived teardown: ${child.pid}`);
  }
}
async function stopOwned(lifetime?: 'test' | 'suite'): Promise<void> {
  for (const [child, owned] of brokers) if (!lifetime || owned.lifetime === lifetime) await stopTestBroker(child);
  assertNoTestBrokers(lifetime);
}
// Ownership is a recorded child handle plus its native birth identity, never argv.
process.once('exit', () => {
  for (const child of brokers.keys()) {
    try { if (isAlive(child)) child.kill('SIGKILL'); } catch { /* No identity proof means no signal. */ }
  }
});
afterEach(async () => { await stopOwned('test'); });
afterAll(async () => {
  await stopOwned();
  if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prior;
  rmSync(agent, { recursive: true, force: true });
});
export function testTmpDir(): string { return scratch; }
export function waitForSocketClose(socket: EventEmitter): Promise<void> {
  return new Promise(resolve => socket.once('close', () => resolve()));
}
export default function test(name: string, optionsOrBody: { concurrency?: boolean; timeout?: number; skip?: boolean } | (() => unknown), body?: () => unknown): void {
  const run = typeof optionsOrBody === 'object' && optionsOrBody.skip ? it.skip : it;
  run(name, body ?? optionsOrBody as () => unknown, 5000);
}
