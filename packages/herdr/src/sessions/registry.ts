// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { constants } from 'node:fs';
import { mkdir, realpath, lstat, open, rename, unlink, readdir } from 'node:fs/promises';
import { dirname, basename, join, isAbsolute, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Owner, TerminalIdentity } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { setTimeout as delay } from 'node:timers/promises';
import { processStartTime } from '../../../subagents/src/process-identity.js';
import type { ProcessIdentity, ProcessProbe } from './lease.js';
export interface LaunchEnvironment { agentDirectory: string; extensionArguments: readonly string[] }
export interface TerminalAssociation { version: 1; owner: Owner; recordedAt: number; coreStartedAt: number; environment: LaunchEnvironment }
export interface TerminalRegistry {
  record(record: Omit<TerminalAssociation, 'version'>): Promise<void>;
  get(identity: TerminalIdentity): Promise<TerminalAssociation | null>;
  list(onInvalid?: (file: string, error: unknown) => void): Promise<TerminalAssociation[]>;
  remove(identity: TerminalIdentity, provedRemoved: boolean): Promise<void>;
}
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export async function canonicalSessionFile(file: string): Promise<string> {
  if (!isAbsolute(file)) throw new HerdrError('session-file-invalid', 'Session path must be absolute');
  try { return await realpath(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // An allocated persistent path may not have been flushed yet. Resolve the closest existing parent, without creating it.
    const parent = dirname(file); if (parent === file) throw error;
    return join(await canonicalSessionFile(parent), basename(file));
  }
}
export async function privateDirectory(path: string): Promise<void> {
  const parent = dirname(path); if (parent !== path) await privateDirectory(parent);
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new HerdrError('unsafe-state-path', 'State directories cannot be symlinks');
}
export async function readPrivateJson(path: string): Promise<unknown | null> {
  let parent = dirname(path);
  for (;;) {
    try { const info = await lstat(parent); if (!info.isDirectory() || info.isSymbolicLink()) throw new HerdrError('unsafe-state-path', 'State readers cannot traverse symlinked directories'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size > 1024 * 1024 || process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new HerdrError('invalid-state-file', 'State must be a private regular file of at most 1 MiB');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally { await handle.close(); }
}
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path));
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new HerdrError('unsafe-state-path', 'Refusing a non-regular state destination'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const bytes = JSON.stringify(value); if (Buffer.byteLength(bytes) > 1024 * 1024) throw new HerdrError('state-too-large', 'State exceeds 1 MiB');
  const temporary = `${path}.${randomBytes(8).toString('hex')}.new`;
  try { const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}
export async function jsonFiles(directory: string): Promise<string[]> {
  try {
    if (await realpath(directory) !== resolve(directory)) throw new HerdrError('unsafe-state-path', 'State readers cannot traverse symlinked directories');
    return (await readdir(directory)).filter(f => f.endsWith('.json')).sort().map(f => join(directory, f));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export function recordedExtensionArguments(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v || v.includes('\0'))) throw new HerdrError('launch-environment-invalid', 'Recorded extension arguments are invalid');
  for (let i = 0; i < value.length; i++) {
    const argument = value[i];
    if (argument === '--no-extensions') continue;
    if (argument === '--extension' || argument === '-e') { if (!value[++i] || value[i].startsWith('-')) throw new HerdrError('launch-environment-invalid', 'An explicit extension argument has no path'); continue; }
    if (/^(?:--extension|-e)=.+/.test(argument)) continue;
    throw new HerdrError('launch-environment-invalid', 'Only explicit extension arguments may be recorded');
  }
  return [...value];
}
export function refuseExplicitExtensions(session: string, arguments_: readonly string[]): void {
  if (arguments_.length) throw new HerdrError('session-explicit-extensions', `Session ${JSON.stringify(session)} used explicit extension arguments ${JSON.stringify(arguments_)}. Relaunch it by hand; automatic resume and cutover never replay extension arguments.`);
}
export function launchEnvironment(value: LaunchEnvironment): LaunchEnvironment {
  if (!isAbsolute(value.agentDirectory)) throw new HerdrError('launch-environment-invalid', 'Agent directory must be absolute');
  return { agentDirectory: value.agentDirectory, extensionArguments: recordedExtensionArguments(value.extensionArguments) };
}

const identityKey = (identity: TerminalIdentity) => hash(JSON.stringify([identity.coreId, identity.terminalId, identity.socket, identity.sessionNamespace]));
function association(value: unknown): TerminalAssociation {
  const r = value as TerminalAssociation;
  if (!r || r.version !== 1 || !r.owner || typeof r.owner.sessionId !== 'string' || typeof r.owner.generation !== 'string' || !r.owner.terminal || typeof r.owner.terminal.coreId !== 'string' || typeof r.owner.terminal.terminalId !== 'string' || typeof r.owner.terminal.socket !== 'string' || typeof r.owner.terminal.address !== 'string' || typeof r.owner.terminal.sessionNamespace !== 'string' || !isAbsolute(r.owner.cwd) || !(r.owner.sessionFile === null || typeof r.owner.sessionFile === 'string' && isAbsolute(r.owner.sessionFile)) || !(r.owner.name === null || typeof r.owner.name === 'string') || !Number.isFinite(r.recordedAt) || !Number.isFinite(r.coreStartedAt)) throw new HerdrError('invalid-terminal-mapping', 'Terminal association shape is invalid');
  launchEnvironment(r.environment); return r;
}
export function createTerminalRegistry(root: string): TerminalRegistry {
  const directory = join(root, 'terminals'); const path = (id: TerminalIdentity) => join(directory, `${identityKey(id)}.json`);
  return {
    async record(r) {
      const owner: Owner = { sessionId: r.owner.sessionId, generation: r.owner.generation, terminal: { coreId: r.owner.terminal.coreId, terminalId: r.owner.terminal.terminalId, address: r.owner.terminal.address, socket: r.owner.terminal.socket, sessionNamespace: r.owner.terminal.sessionNamespace }, cwd: r.owner.cwd, name: r.owner.name, sessionFile: r.owner.sessionFile === null ? null : await canonicalSessionFile(r.owner.sessionFile) };
      await writePrivateJson(path(owner.terminal), association({ version: 1, owner, recordedAt: r.recordedAt, coreStartedAt: r.coreStartedAt, environment: launchEnvironment(r.environment) }));
    },
    async get(id) { const r = await readPrivateJson(path(id)); if (r === null) return null; const a = association(r); if (identityKey(a.owner.terminal) !== identityKey(id)) throw new HerdrError('terminal-identity-mismatch', 'Mapping belongs to another terminal'); return a; },
    async list(onInvalid) {
      const records = [];
      for (const p of await jsonFiles(directory)) {
        try { const r = await readPrivateJson(p); if (r !== null) records.push(association(r)); }
        catch (error) { if (!onInvalid) throw error; onInvalid(p, error); }
      }
      return records;
    },
    async remove(id, provedRemoved) { if (!provedRemoved) throw new HerdrError('terminal-may-exist', 'Mapping cleanup requires proof of terminal removal'); await unlink(path(id)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); },
  };
}

interface LockTicket extends ProcessIdentity { version: 1; number: number | null }
export interface ProcessLockOptions { signal?: AbortSignal; identity?: ProcessIdentity; probe?(pid: number): Promise<ProcessProbe>; timeoutMs?: number }
const localLocks = new Map<string, Promise<void>>();
/** Local contenders queue before entering the cross-process bakery lock. */
export async function withProcessLock<T>(root: string, key: string, operation: () => Promise<T>, options: ProcessLockOptions = {}): Promise<T> {
  const queueKey = join(resolve(root), 'locks', hash(key));
  const previous = localLocks.get(queueKey);
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  let release!: () => void;
  const turn = new Promise<void>(resolveTurn => { release = resolveTurn; });
  const tail = (previous ?? Promise.resolve()).then(() => turn); localLocks.set(queueKey, tail);
  const { signal } = options;
  let onAbort: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (signal?.aborted) throw new HerdrError('aborted', 'Lock acquisition aborted');
    if (previous) {
      if (Date.now() >= deadline) throw new HerdrError('lock-occupied', 'The operation lock is busy');
      await Promise.race([previous, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new HerdrError('lock-occupied', 'The operation lock is busy')), Math.max(0, deadline - Date.now()));
        if (signal) {
          onAbort = () => reject(new HerdrError('aborted', 'Lock acquisition aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
        }
      })]);
      if (Date.now() >= deadline) throw new HerdrError('lock-occupied', 'The operation lock is busy');
    }
    if (signal?.aborted) throw new HerdrError('aborted', 'Lock acquisition aborted');
    clearTimeout(timer);
    return await acquireProcessLock(root, key, operation, options, deadline);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    release(); void tail.then(() => { if (localLocks.get(queueKey) === tail) localLocks.delete(queueKey); });
  }
}
/** Each contender owns a unique ticket, so reclamation cannot unlink a new owner's ticket. */
async function acquireProcessLock<T>(root: string, key: string, operation: () => Promise<T>, options: ProcessLockOptions, deadline: number): Promise<T> {
  const identity = options.identity ?? { pid: process.pid, startIdentity: processStartTime(process.pid) ?? '' };
  if (!identity.startIdentity) throw new HerdrError('process-identity-unavailable', 'Cannot acquire a lock without a process start identity');
  const verified = new Map<string, string>();
  const probe = async (pid: number, file: string): Promise<ProcessProbe> => {
    if (options.probe) return options.probe(pid);
    try { process.kill(pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? { kind: 'absent' } : { kind: 'unknown' }; }
    // New ticket names always get a fresh foreign identity, even after PID reuse.
    const startIdentity = verified.get(file) ?? processStartTime(pid);
    if (!startIdentity) return { kind: 'unknown' };
    verified.set(file, startIdentity); return { kind: 'live', startIdentity };
  };
  const directory = join(root, 'locks', hash(key)); await privateDirectory(directory);
  const name = `${identity.pid}-${hash(identity.startIdentity)}-${randomBytes(16).toString('hex')}.json`; const path = join(directory, name);
  async function tickets(): Promise<{ name: string; ticket: LockTicket }[]> {
    const rows: { name: string; ticket: LockTicket }[] = [];
    for (const file of await jsonFiles(directory)) {
      const raw = await readPrivateJson(file); if (raw === null) continue; const ticket = raw as LockTicket;
      if (ticket.version !== 1 || !Number.isInteger(ticket.pid) || ticket.pid <= 0 || typeof ticket.startIdentity !== 'string' || !ticket.startIdentity || !(ticket.number === null || Number.isSafeInteger(ticket.number) && ticket.number > 0)) throw new HerdrError('invalid-lock-ticket', 'Lock ticket is malformed');
      const observed = await probe(ticket.pid, file);
      if (observed.kind === 'absent') {
        // Ticket names are never reused, so reclaiming this absent actor cannot remove a new contender's file.
        await unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
        continue;
      }
      if (observed.kind !== 'live' || observed.startIdentity !== ticket.startIdentity) throw new HerdrError('lock-owner-uncertain', 'Cannot prove the previous lock owner absent');
      rows.push({ name: basename(file), ticket });
    }
    return rows;
  }
  try {
    await writePrivateJson(path, { version: 1, ...identity, number: null });
    const number = Math.max(0, ...(await tickets()).map(r => r.ticket.number ?? 0)) + 1;
    if (!Number.isSafeInteger(number)) throw new HerdrError('invalid-lock-ticket', 'Lock ticket sequence is exhausted');
    await writePrivateJson(path, { version: 1, ...identity, number });
    for (;;) {
      if (options.signal?.aborted) throw new HerdrError('aborted', 'Lock acquisition aborted');
      const rows = await tickets();
      const blocked = rows.some(r => r.name !== name && (r.ticket.number === null || r.ticket.number < number || r.ticket.number === number && r.name < name));
      if (!blocked) return await operation();
      if (Date.now() >= deadline) throw new HerdrError('lock-occupied', 'The operation lock is busy');
      await delay(10, undefined, { signal: options.signal });
    }
  } finally { await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}
