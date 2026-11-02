// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Durable resource ledger, idempotent cleanup, the out-of-group watchdog and next-run reconciliation.
// Self-contained (node: imports only, erasable types) so `node resources.ts watchdog|reconcile|cleanup ...`
// runs it directly with Node's type stripping, outside any Vitest process.
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, mkdirSync, openSync, closeSync, rmSync, unlinkSync, lstatSync, chmodSync, realpathSync, type Stats } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { join, dirname, basename, resolve, sep } from 'node:path';
import type { OwnedPath } from './environment.js';
import { fileURLToPath } from 'node:url';

export interface ProcessIdentity { pid: number; start: string }
export interface LedgerProcess extends ProcessIdentity { label: string; group: boolean; startsCores?: boolean }
export interface LedgerCore {
  side: string; namespace: string; socket: string; hcBinary: string;
  env: Record<string, string>; coreId?: string; pid?: number; start?: string;
}
export interface FileModeRestore { kind: 'file-mode'; path: OwnedPath; mode: number; dev: number; ino: number }
export interface Ledger {
  version: 1; id: string; root: string; createdAt: string; state: 'open' | 'closed' | 'cleanup-failed'; tearingDown?: boolean;
  owner: ProcessIdentity; watchdog?: ProcessIdentity;
  processes: LedgerProcess[]; cores: LedgerCore[];
  terminals: { side: string; address: string }[]; machines: { side: string; name: string }[];
  appHome?: string; remoteRoot?: string; viaDirectory?: string;
  modeRestores?: FileModeRestore[];
}
export interface CleanupProof {
  ledger: string; id: string; root: string; reason: string; repeated: boolean; at: string;
  signalled: { pid: number; label: string; signal: string }[]; refused: { pid: number; label: string; why: string }[];
  coreActions: { side: string; argv: string[]; exitCode: number | null }[];
  viaActions: { pid: number; start: string; action: string }[];
  phases: { phase: string; ok: boolean }[];
  verificationRounds: { side: string; round: number; listening: boolean; holders: number[]; quiet?: boolean }[];
  survivors: { kind: string; id: string }[]; clean: boolean;
  modeRestores: { path: string; mode: number; outcome: 'restored' | 'gone' | 'refused'; error?: string }[];
}

export function processStart(pid: number, options: { includeZombie?: boolean } = {}): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'stat=,lstart='], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } }).trim();
    if (!out || (out.startsWith('Z') && !options.includeZombie)) return null;
    return out.replace(/^\S+\s+/, '');
  } catch { return null; }
}
export function identityAlive(identity: ProcessIdentity): boolean { return processStart(identity.pid) === identity.start; }
export function identityOf(pid: number): ProcessIdentity {
  const start = processStart(pid); if (!start) throw new Error(`process-identity-unavailable: ${pid}`);
  return { pid, start };
}
/**
 * Identity of a child this process spawned in the same synchronous step. Node reaps children only when the event loop
 * runs, so a fast child that already exited is still an unreaped zombie whose pid and start time name it.
 */
export function spawnedIdentity(pid: number): ProcessIdentity {
  const start = processStart(pid, { includeZombie: true }); if (!start) throw new Error(`process-identity-unavailable: ${pid}`);
  return { pid, start };
}

export function readLedger(path: string): Ledger { return JSON.parse(readFileSync(path, 'utf8')) as Ledger; }
function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.new`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

export interface LedgerHandle {
  readonly path: string; readonly id: string;
  read(): Ledger;
  update(mutate: (ledger: Ledger) => void): Ledger;
}
/** Registers the root before anything is started in it. */
export function openLedger(directory: string, root: string): LedgerHandle {
  const id = basename(root), path = join(directory, `${id}.json`);
  if (existsSync(path)) throw new Error(`ledger-exists: ${path}`);
  const ledger: Ledger = { version: 1, id, root, createdAt: new Date().toISOString(), state: 'open', owner: identityOf(process.pid), processes: [], cores: [], terminals: [], machines: [] };
  writeAtomic(path, ledger);
  return {
    path, id, read: () => readLedger(path),
    update(mutate) { const next = readLedger(path); mutate(next); writeAtomic(path, next); return next; },
  };
}

function modeRestoreFile(root: string, path: string, missing = false): Stats | null {
  if (typeof path !== 'string' || resolve(path) !== path || !path.startsWith(root + sep)) throw new Error('mode-restore-path: not an owned path inside this suite root');
  try {
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('mode-restore-path: unsafe suite root');
    for (let at = path; at !== root; at = dirname(at)) if (lstatSync(at).isSymbolicLink()) throw new Error('mode-restore-path: symlink');
    const file = lstatSync(path);
    if ((!file.isFile() && !file.isDirectory()) || (file.isFile() && file.nlink !== 1) || (process.getuid && file.uid !== process.getuid())) throw new Error('mode-restore-file: not an owned regular file or directory');
    return file;
  } catch (error) { if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function restoreFileMode(root: string, resource: FileModeRestore): 'restored' | 'gone' {
  const file = modeRestoreFile(root, resource.path, true);
  if (!file) return 'gone';
  if (resource.kind !== 'file-mode' || !Number.isInteger(resource.mode) || resource.mode < 0 || resource.mode > 0o7777 || file.dev !== resource.dev || file.ino !== resource.ino) throw new Error('mode-restore-file: identity or recorded mode changed');
  chmodSync(resource.path, resource.mode);
  if ((lstatSync(resource.path).mode & 0o7777) !== resource.mode) throw new Error('mode-restore-file: mode was not restored');
  return 'restored';
}
/** Register before changing the mode. Re-registering preserves the first original mode, never the faulted one. */
export function registerModeRestore(handle: LedgerHandle, path: OwnedPath): { restore(): void } {
  const root = handle.read().root, file = modeRestoreFile(root, path)!;
  const ledger = handle.update(l => {
    const prior = l.modeRestores?.find(r => r.path === path);
    if (prior) {
      if (prior.dev !== file.dev || prior.ino !== file.ino) throw new Error('mode-restore-file: registered identity changed');
    } else (l.modeRestores ??= []).push({ kind: 'file-mode', path, mode: file.mode & 0o7777, dev: file.dev, ino: file.ino });
  });
  const resource = ledger.modeRestores!.find(r => r.path === path)!;
  return { restore: () => { restoreFileMode(root, resource); } };
}

function socketListening(path: string): Promise<boolean> {
  if (!existsSync(path)) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = connect(path);
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false));
    socket.setTimeout(2000, () => done(false));
  });
}
function hcJson(core: LedgerCore, argv: string[], actions: CleanupProof['coreActions']): unknown {
  const result = spawnSync(core.hcBinary, argv, { env: core.env, encoding: 'utf8', timeout: 15_000 });
  actions.push({ side: core.side, argv, exitCode: result.status });
  try { return JSON.parse(result.stdout); } catch { return null; }
}
async function observeUntil(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) { if (await check()) return true; if (Date.now() >= end) return false; await new Promise(r => setTimeout(r, 50)); }
}
function signal(identity: LedgerProcess, name: NodeJS.Signals, proof: CleanupProof): void {
  try { process.kill(identity.group ? -identity.pid : identity.pid, name); proof.signalled.push({ pid: identity.pid, label: identity.label, signal: name }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') proof.refused.push({ pid: identity.pid, label: identity.label, why: String(error) }); }
}
/** Processes whose command line names the fixture root, excluding this process and the ledger's watchdog. */
export function rootProcesses(root: string, exclude: readonly number[] = []): { pid: number; command: string }[] {
  const out = spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' } }).stdout ?? '';
  return out.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line); if (!m) return [];
    const pid = Number(m[1]); if (pid === process.pid || exclude.includes(pid) || !m[2].includes(root + '/') && !m[2].endsWith(root)) return [];
    return [{ pid, command: m[2] }];
  });
}

function isCoreStarter(process: LedgerProcess): boolean {
  // Older ledgers predate the explicit role flag.
  return process.startsCores === true || process.label === 'fake-app-daemon';
}

function coreStarterAlive(actor: LedgerProcess): boolean {
  const leader = processStart(actor.pid);
  if (leader && leader !== actor.start) return false;
  if (!actor.group) return leader === actor.start;
  const result = spawnSync('ps', ['-ax', '-o', 'pgid=,stat='], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' } });
  if (result.status !== 0) return true; // An uninspectable group cannot prove cleanup.
  return (result.stdout ?? '').split('\n').some(line => {
    const match = /^\s*(\d+)\s+(\S+)/.exec(line);
    return match && Number(match[1]) === actor.pid && !match[2].startsWith('Z');
  });
}

async function stopCoreStarters(ledger: Ledger, proof: CleanupProof): Promise<boolean> {
  const actors = ledger.processes.filter(isCoreStarter);
  for (const actor of actors) {
    const current = processStart(actor.pid);
    if (current && current !== actor.start) { proof.refused.push({ pid: actor.pid, label: actor.label, why: 'start identity changed; not ours' }); continue; }
    if (coreStarterAlive(actor)) signal(actor, 'SIGTERM', proof);
  }
  await observeUntil(() => actors.every(actor => !coreStarterAlive(actor)), 5000);
  for (const actor of actors) {
    const current = processStart(actor.pid);
    if (current && current !== actor.start) continue;
    if (coreStarterAlive(actor)) signal(actor, 'SIGKILL', proof);
  }
  await observeUntil(() => actors.every(actor => !coreStarterAlive(actor)), 3000);
  const survivors = actors.filter(coreStarterAlive);
  for (const actor of survivors) proof.survivors.push({ kind: 'core-starter', id: `${actor.label}:${actor.pid}` });
  return survivors.length === 0;
}

interface ViaRecord extends ProcessIdentity { child?: ProcessIdentity }

/** Each via writes its own atomic record, so concurrent dial attempts never rewrite the shared ledger. */
function viaRecords(ledger: Ledger): { records: ViaRecord[]; invalid: string[] } {
  const directory = ledger.viaDirectory;
  if (!directory) return { records: [], invalid: [] };
  if (directory !== join(resolve(ledger.root), 'via-processes') || !existsSync(directory)) return { records: [], invalid: [directory] };
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) return { records: [], invalid: [directory] };
  const records: ViaRecord[] = [], invalid: string[] = [];
  for (const name of readdirSync(directory).filter(name => /^\d+\.json$/.test(name))) {
    const file = join(directory, name);
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('invalid record');
      const value = JSON.parse(readFileSync(file, 'utf8')) as ViaRecord;
      if (!Number.isInteger(value.pid) || value.pid <= 0 || `${value.pid}.json` !== name || typeof value.start !== 'string' || !value.start ||
          (value.child && (!Number.isInteger(value.child.pid) || value.child.pid <= 0 || typeof value.child.start !== 'string' || !value.child.start))) throw new Error('invalid identity');
      records.push(value);
    } catch { invalid.push(file); }
  }
  return { records, invalid };
}

/** A via may have been forked just before teardown and not yet written its record. */
function pendingVia(ledger: Ledger): ProcessIdentity[] {
  return rootProcesses(ledger.root).filter(p => p.command.includes(join(ledger.root, 'via-d.json')) || p.command.includes(join(ledger.root, 'bin/via-d')))
    .flatMap(p => {
      const start = processStart(p.pid);
      const same = start && rootProcesses(ledger.root).some(current => current.pid === p.pid && current.command === p.command);
      return same ? [{ pid: p.pid, start }] : [];
    });
}

async function drainVia(ledger: Ledger, proof: CleanupProof): Promise<boolean> {
  const seen = new Set<string>();
  const collect = () => {
    const snapshot = viaRecords(ledger);
    const identities = [...snapshot.records.flatMap(record => [record, ...(record.child ? [record.child] : [])]), ...pendingVia(ledger)];
    const unique = [...new Map(identities.map(identity => [`${identity.pid}:${identity.start}`, identity])).values()];
    for (const identity of unique) {
      const key = `${identity.pid}:${identity.start}`;
      if (!seen.has(key)) { seen.add(key); proof.viaActions.push({ pid: identity.pid, start: identity.start, action: 'observed' }); }
    }
    return { ...snapshot, live: unique.filter(identityAlive) };
  };
  await observeUntil(() => collect().live.length === 0, 1500);
  for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
    for (const identity of collect().live) {
      if (!identityAlive(identity)) continue;
      signal({ ...identity, label: 'via', group: false }, sig, proof);
      proof.viaActions.push({ pid: identity.pid, start: identity.start, action: sig });
    }
    if (await observeUntil(() => collect().live.length === 0, 1500)) break;
  }
  const final = collect();
  for (const record of final.records) if (!identityAlive(record) && (!record.child || !identityAlive(record.child))) {
    const file = join(ledger.viaDirectory!, `${record.pid}.json`);
    try {
      const current = JSON.parse(readFileSync(file, 'utf8')) as ViaRecord;
      if (current.start === record.start) unlinkSync(file);
    } catch { /* the exiting via may have removed it */ }
  }
  for (const path of final.invalid) proof.survivors.push({ kind: 'via-record', id: path });
  for (const identity of final.live) proof.survivors.push({ kind: 'via-process', id: `${identity.pid}:${identity.start}` });
  return final.invalid.length === 0 && final.live.length === 0;
}

function coreHolders(ledger: Ledger, core: LedgerCore): { pid: number; command: string }[] {
  const prefix = join(dirname(core.socket), basename(core.socket).replace(/\.sock$/, '.holder.'));
  return rootProcesses(ledger.root).filter(p => p.command.includes(' hold --socket ') && p.command.includes(prefix));
}

async function coreStaysStopped(ledger: Ledger, core: LedgerCore): Promise<boolean> {
  const until = Date.now() + 500;
  for (;;) {
    if (await socketListening(core.socket) || coreHolders(ledger, core).length) return false;
    if (Date.now() >= until) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function stopCore(ledger: Ledger, core: LedgerCore, proof: CleanupProof): Promise<boolean> {
  const previous = proof.verificationRounds.filter(item => item.side === core.side).length;
  for (let round = previous + 1; round <= 3; round++) {
    const listening = await socketListening(core.socket), holders = coreHolders(ledger, core);
    const observation: CleanupProof['verificationRounds'][number] = { side: core.side, round, listening, holders: holders.map(holder => holder.pid) };
    proof.verificationRounds.push(observation);
    if (!listening && !holders.length) {
      observation.quiet = await coreStaysStopped(ledger, core);
      if (observation.quiet) return true;
      continue;
    }
    if (listening) {
      const listing = hcJson(core, ['ls', '--all', '--json'], proof.coreActions) as { terminals?: { address?: string; state?: string }[] } | null;
      for (const terminal of listing?.terminals ?? []) {
        if (!terminal.address || terminal.address.includes('/')) continue;
        if (terminal.state === 'live') hcJson(core, ['kill', terminal.address, '--json'], proof.coreActions);
        hcJson(core, ['rm', terminal.address, '--json'], proof.coreActions);
      }
      const machines = hcJson(core, ['machine', 'ls', '--json'], proof.coreActions) as { machines?: { name?: string }[] } | null;
      for (const machine of machines?.machines ?? []) if (machine.name) hcJson(core, ['machine', 'rm', machine.name, '--json'], proof.coreActions);
      if (await socketListening(core.socket)) hcJson(core, ['server', 'stop', '--json'], proof.coreActions);
    }
    for (const holder of holders) {
      const start = processStart(holder.pid);
      const same = start && coreHolders(ledger, core).some(current => current.pid === holder.pid && current.command === holder.command);
      if (same && identityAlive({ pid: holder.pid, start })) signal({ pid: holder.pid, start, label: `holder:${core.side}`, group: false }, round === 3 ? 'SIGKILL' : 'SIGTERM', proof);
    }
    await observeUntil(async () => !(await socketListening(core.socket)) && coreHolders(ledger, core).length === 0, 1500);
  }
  const stopped = await coreStaysStopped(ledger, core);
  if (!stopped) proof.survivors.push({ kind: 'core-stop', id: core.side });
  return stopped;
}

/** Idempotent and bounded. Signals only identities whose start time still matches. Writes the proof outside the root. */
export async function cleanupLedger(path: string, reason: string, options: { removeRoot?: boolean } = {}): Promise<CleanupProof> {
  const ledger = readLedger(path);
  const proof: CleanupProof = { ledger: path, id: ledger.id, root: ledger.root, reason, repeated: ledger.state !== 'open', at: new Date().toISOString(), signalled: [], refused: [], coreActions: [], viaActions: [], phases: [], verificationRounds: [], survivors: [], clean: false, modeRestores: [] };
  if (ledger.state !== 'closed') {
    // Publish the fence before touching either core. A killed owner leaves the ledger open for the watchdog.
    const fenced = readLedger(path); fenced.tearingDown = true; writeAtomic(path, fenced);
    // Apps can autostart hc on connect. Wait for their owned process groups before touching either core.
    const appsStopped = await stopCoreStarters(ledger, proof);
    proof.phases.push({ phase: 'app-stopped', ok: appsStopped });
    // Only the local core spawns via. Stop it, drain its already-started transports, then stop the destination.
    let localStopped = appsStopped;
    if (localStopped) for (const core of ledger.cores.filter(core => core.side === 'local')) localStopped = await stopCore(ledger, core, proof) && localStopped;
    proof.phases.push({ phase: 'local-stopped', ok: localStopped });
    const drained = await drainVia(ledger, proof);
    proof.phases.push({ phase: 'via-drained', ok: drained });
    let destinationStopped = localStopped && drained;
    if (destinationStopped) for (const core of ledger.cores.filter(core => core.side !== 'local')) destinationStopped = await stopCore(ledger, core, proof) && destinationStopped;
    proof.phases.push({ phase: 'destination-stopped', ok: destinationStopped });
    // 2. Owned processes, newest first: TERM, observe, then KILL.
    const owned: LedgerProcess[] = ledger.processes.filter(process => !isCoreStarter(process)).reverse();
    for (const core of ledger.cores) if (core.pid && core.start) owned.push({ pid: core.pid, start: core.start, label: `core:${core.side}`, group: false });
    for (const p of owned) {
      if (processStart(p.pid) === null) continue;
      if (!identityAlive(p)) { proof.refused.push({ pid: p.pid, label: p.label, why: 'start identity changed; not ours' }); continue; }
      signal(p, 'SIGTERM', proof);
    }
    for (const p of owned) if (!(await observeUntil(() => !identityAlive(p), 3000))) signal(p, 'SIGKILL', proof);
    // Use only the remaining rounds if a destination reappeared during owned-process cleanup.
    if (localStopped && drained) for (const core of ledger.cores.filter(core => core.side !== 'local')) {
      if (await socketListening(core.socket) || coreHolders(ledger, core).length) await stopCore(ledger, core, proof);
    }
  }
  // Restore parent directories before descendants, even on repeated cleanup, after writers have stopped.
  for (const resource of [...(ledger.modeRestores ?? [])].sort((a, b) => a.path.length - b.path.length)) {
    try { proof.modeRestores.push({ path: resource.path, mode: resource.mode, outcome: restoreFileMode(ledger.root, resource) }); }
    catch (error) { proof.modeRestores.push({ path: resource.path, mode: resource.mode, outcome: 'refused', error: String(error) }); proof.survivors.push({ kind: 'file-mode', id: resource.path }); }
  }
  // 3. Verify: sockets, identities, and anything still naming the root.
  for (const core of ledger.cores) if (await observeUntil(async () => !(await socketListening(core.socket)), 3000) === false) proof.survivors.push({ kind: 'socket', id: core.socket });
  for (const p of ledger.processes) if (identityAlive(p)) proof.survivors.push({ kind: 'process', id: `${p.label}:${p.pid}` });
  for (const core of ledger.cores) if (core.pid && core.start && identityAlive({ pid: core.pid, start: core.start })) proof.survivors.push({ kind: 'core-process', id: `${core.side}:${core.pid}` });
  const exclude = ledger.watchdog ? [ledger.watchdog.pid] : [];
  if (!(await observeUntil(() => rootProcesses(ledger.root, exclude).length === 0, 3000)))
    for (const p of rootProcesses(ledger.root, exclude)) proof.survivors.push({ kind: 'root-process', id: `${p.pid} ${p.command.slice(0, 200)}` });
  proof.clean = proof.survivors.length === 0;
  writeAtomic(path.replace(/\.json$/, '.cleanup.json'), proof);
  const next = readLedger(path); next.state = proof.clean ? 'closed' : 'cleanup-failed'; writeAtomic(path, next);
  if (proof.clean && options.removeRoot) rmSync(ledger.root, { recursive: true, force: true });
  return proof;
}

/** Startup reconciliation: finish every ledger whose owner and watchdog are both gone. */
export async function reconcileLedgers(directory: string): Promise<CleanupProof[]> {
  if (!existsSync(directory)) return [];
  const proofs: CleanupProof[] = [];
  for (const name of readdirSync(directory)) {
    if (!/^[a-z0-9]+\.json$/.test(name)) continue;
    const path = join(directory, name); let ledger: Ledger;
    try { ledger = readLedger(path); } catch { continue; }
    if (ledger.state === 'closed') continue;
    if (identityAlive(ledger.owner) || (ledger.watchdog && identityAlive(ledger.watchdog))) continue;
    proofs.push(await cleanupLedger(path, 'startup-reconciliation'));
  }
  return proofs;
}

/** Starts the watchdog in its own session (process group). It cleans up when the owner's pipe closes or the deadline passes. */
export function startWatchdog(handle: LedgerHandle, deadlineAt: number, logPath: string): { identity: ProcessIdentity; release(): void } {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'watchdog', handle.path, String(deadlineAt)], {
    detached: true, stdio: ['pipe', log, log], env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: join(handle.read().root, 't'), HOME: join(handle.read().root, 'h') },
  });
  closeSync(log);
  child.unref();
  const identity = spawnedIdentity(child.pid!);
  handle.update(l => { l.watchdog = identity; });
  (child.stdin as unknown as { unref?: () => void }).unref?.();
  return { identity, release: () => { child.stdin?.end(); } };
}

async function runWatchdog(path: string, deadlineAt: number): Promise<void> {
  const fire = async (why: string) => {
    let ledger: Ledger; try { ledger = readLedger(path); } catch { process.exit(0); }
    if (ledger.state === 'open') { const proof = await cleanupLedger(path, `watchdog:${why}`); process.stderr.write(JSON.stringify({ why, clean: proof.clean }) + '\n'); }
    process.exit(0);
  };
  process.stdin.on('end', () => void fire('owner-pipe-closed'));
  process.stdin.on('error', () => void fire('owner-pipe-error'));
  process.stdin.resume();
  setTimeout(() => void fire('deadline'), Math.max(0, deadlineAt - Date.now()));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => void fire(sig));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, target, extra] = process.argv.slice(2);
  if (command === 'watchdog') void runWatchdog(target, Number(extra));
  else if (command === 'reconcile') void reconcileLedgers(target).then(p => { process.stdout.write(JSON.stringify(p, null, 2) + '\n'); process.exit(p.every(x => x.clean) ? 0 : 1); });
  else if (command === 'cleanup') void cleanupLedger(target, 'cli').then(p => { process.stdout.write(JSON.stringify(p, null, 2) + '\n'); process.exit(p.clean ? 0 : 1); });
  else { process.stderr.write('usage: resources.ts watchdog <ledger> <deadline-ms> | reconcile <dir> | cleanup <ledger>\n'); process.exit(2); }
}
