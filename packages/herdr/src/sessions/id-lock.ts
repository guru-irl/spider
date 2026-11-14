// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { lstat, readFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HerdrError } from '../client/parse.js';
import type { ProcessIdentity, ProcessProbe } from './lease.js';
import { hash, jsonFiles, privateDirectory, readPrivateJson, withProcessLock, writePrivateJson } from './registry.js';

export interface IdLockHandoff { operationId: string; nonce: string; file?: string; coreId?: string }
export interface IdLockObservation {
  identity: ProcessIdentity; bootId: string; pendingOperationId: string | null; pendingFile: string | null; pendingCoreId: string | null; operationId: string | null;
}
export interface IdLockHandle {
  release(): Promise<void>;
  transfer(next: ProcessIdentity): Promise<void>;
  prepareHandoff(operationId: string, file?: string, coreId?: string): Promise<IdLockHandoff>;
  clearHandoff(operationId: string): Promise<boolean>;
  cancelHandoff(operationId: string): Promise<boolean>;
}
interface IdLockRecord {
  version: 1;
  sessionId: string;
  identity: ProcessIdentity;
  bootId: string;
  adoptionPending: boolean;
  token: string;
  handoff?: IdLockHandoff;
  operationId?: string;
}

const execFileAsync = promisify(execFile);

export async function localBootId(readers: {
  platform?: NodeJS.Platform;
  readLinuxBootId?: () => Promise<string>;
  readSysctl?: (key: string) => Promise<string>;
} = {}): Promise<string> {
  try {
    const platform = readers.platform ?? process.platform;
    if (platform === 'linux') return (await (readers.readLinuxBootId ?? (() => readFile('/proc/sys/kernel/random/boot_id', 'utf8')))()).trim();
    if (platform === 'darwin') return (await (readers.readSysctl ?? (async key => (await execFileAsync('sysctl', ['-n', key])).stdout))('kern.bootsessionuuid')).trim();
  } catch { /* Treat unavailable boot identity as unknown. */ }
  return '';
}

const bootUuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export function bootIdChanged(previous: string, current: string): boolean {
  return !!previous && !!current && previous !== current && bootUuid.test(previous) === bootUuid.test(current);
}

function validIdentity(identity: ProcessIdentity): boolean {
  return !!identity && Number.isSafeInteger(identity.pid) && identity.pid > 0 && typeof identity.startIdentity === 'string' && identity.startIdentity.length > 0;
}

async function checkPrivate(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      process.platform !== 'win32' && ((info.mode & 0o777) !== (directory ? 0o700 : 0o600) || info.uid !== process.getuid?.())) {
    throw new HerdrError('unsafe-state-path', 'Session ownership requires private, locally owned state');
  }
}

const operationIdValid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const nonceValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const coreIdValid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

function parseRecord(value: unknown, sessionId: string): IdLockRecord {
  const record = value as IdLockRecord;
  if (!record || record.version !== 1 || record.sessionId !== sessionId || !validIdentity(record.identity) || typeof record.bootId !== 'string' || record.bootId !== record.bootId.trim() || typeof record.adoptionPending !== 'boolean' || typeof record.token !== 'string' || !/^[a-f0-9]{64}$/.test(record.token)) {
    throw new HerdrError('invalid-session-id-lock', 'Session ID ownership record is invalid');
  }
  if (record.handoff !== undefined && (!record.handoff || !operationIdValid(record.handoff.operationId) || !nonceValid(record.handoff.nonce) ||
      record.handoff.file !== undefined && (typeof record.handoff.file !== 'string' || !isAbsolute(record.handoff.file) || record.handoff.file.includes('\0')) ||
      record.handoff.coreId !== undefined && !coreIdValid(record.handoff.coreId)) ||
      record.operationId !== undefined && !operationIdValid(record.operationId)) throw new HerdrError('invalid-session-id-lock', 'Session ID handoff record is invalid');
  return record;
}

export async function inspectIdLock(root: string, sessionId: string): Promise<IdLockObservation | null> {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.includes('\0')) throw new HerdrError('invalid-session-id-lock', 'Session ID is required');
  const stateRoot = resolve(root), directory = join(stateRoot, 'id-locks'), file = join(directory, `${hash(sessionId)}.json`);
  try { await checkPrivate(stateRoot, true); await checkPrivate(directory, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const value = await readPrivateJson(file);
  if (value === null) return null;
  await checkPrivate(file, false);
  const record = parseRecord(value, sessionId);
  return { identity: { ...record.identity }, bootId: record.bootId, pendingOperationId: record.handoff?.operationId ?? null,
    pendingFile: record.handoff?.file ?? null, pendingCoreId: record.handoff?.coreId ?? null, operationId: record.operationId ?? null };
}

/** Inspect pending handoffs without returning their nonce, token, or file contents. */
export async function listPendingIdLocks(root: string): Promise<Array<{ sessionId: string; operationId: string; coreId: string | null }>> {
  const stateRoot = resolve(root), directory = join(stateRoot, 'id-locks');
  try { await checkPrivate(stateRoot, true); await checkPrivate(directory, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const pending: Array<{ sessionId: string; operationId: string; coreId: string | null }> = [];
  for (const file of await jsonFiles(directory)) {
    await checkPrivate(file, false);
    const value = await readPrivateJson(file) as { sessionId?: unknown } | null;
    if (!value || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.includes('\0') || file !== join(directory, `${hash(value.sessionId)}.json`)) {
      throw new HerdrError('invalid-session-id-lock', 'Session ID ownership record is invalid');
    }
    const record = parseRecord(value, value.sessionId);
    if (record.handoff) pending.push({ sessionId: record.sessionId, operationId: record.handoff.operationId, coreId: record.handoff.coreId ?? null });
  }
  return pending;
}

export async function claimIdLock(root: string, sessionId: string, identity: ProcessIdentity, probe: (pid: number) => Promise<ProcessProbe>, options: { bootId?: () => Promise<string>; handoff?: IdLockHandoff; exclusive?: boolean; recoverPending?: string } = {}): Promise<IdLockHandle> {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.includes('\0') || !validIdentity(identity)) throw new HerdrError('invalid-session-id-lock', 'Session ID and process identity are required');
  const bootId = await (options.bootId ?? localBootId)().then(value => value.trim()).catch(() => '');
  const stateRoot = resolve(root);
  await privateDirectory(stateRoot);
  await checkPrivate(stateRoot, true);
  const directory = join(stateRoot, 'id-locks');
  const file = join(directory, `${hash(sessionId)}.json`);
  const key = `session-id:${sessionId}`;

  async function locked<T>(operation: () => Promise<T>): Promise<T> {
    await checkPrivate(stateRoot, true);
    const lockRoot = join(stateRoot, 'locks');
    await privateDirectory(lockRoot);
    await checkPrivate(lockRoot, true);
    const lockDirectory = join(lockRoot, hash(key));
    await privateDirectory(lockDirectory);
    await checkPrivate(lockDirectory, true);
    return withProcessLock(stateRoot, key, async () => {
      await checkPrivate(stateRoot, true);
      await privateDirectory(directory);
      await checkPrivate(directory, true);
      return operation();
    });
  }
  async function read(): Promise<IdLockRecord | null> {
    const value = await readPrivateJson(file);
    if (value === null) return null;
    await checkPrivate(file, false);
    return parseRecord(value, sessionId);
  }
  const token = await locked(async () => {
    const previous = await read();
    if (options.handoff) {
      const handoff = options.handoff;
      if (!previous?.handoff || !operationIdValid(handoff.operationId) || !nonceValid(handoff.nonce) ||
          previous.handoff.operationId !== handoff.operationId || previous.handoff.file !== undefined && previous.handoff.file !== handoff.file ||
          !previous.bootId || previous.bootId !== bootId ||
          previous.identity.pid === identity.pid && previous.identity.startIdentity === identity.startIdentity ||
          !timingSafeEqual(Buffer.from(previous.handoff.nonce, 'hex'), Buffer.from(handoff.nonce, 'hex'))) {
        throw new HerdrError('session-id-owner', 'Cannot adopt the session ID handoff');
      }
      const { handoff: _handoff, ...record } = previous;
      const nextToken = randomBytes(32).toString('hex');
      await writePrivateJson(file, { ...record, identity: { pid: identity.pid, startIdentity: identity.startIdentity },
        operationId: handoff.operationId, adoptionPending: false, token: nextToken });
      return nextToken;
    }
    if (previous) {
      if (previous.handoff && (!options.exclusive || options.recoverPending !== previous.handoff.operationId)) {
        throw new HerdrError('session-id-owner', 'Session ID handoff has not been reconciled');
      }
      if (!previous.bootId || !bootId) throw new HerdrError('session-id-owner', 'Cannot prove the session ID owner absent');
      // Old macOS records contain formatted kern.boottime, not a UUID. A format
      // change alone is not evidence of a reboot; keep probing the prior owner.
      const sameOrUnknownBoot = !bootIdChanged(previous.bootId, bootId);
      const sameIdentity = previous.identity.pid === identity.pid && previous.identity.startIdentity === identity.startIdentity;
      if (sameOrUnknownBoot && sameIdentity) {
        if (previous.handoff && options.exclusive && options.recoverPending === previous.handoff.operationId && previous.bootId === bootId) return previous.token;
        if (previous.handoff || options.exclusive) throw new HerdrError('session-id-owner', 'Session ID is already owned');
        if (!previous.adoptionPending && previous.bootId === bootId) return previous.token;
        // After handoff, the launcher must not release the adopted owner's lock.
        const token = previous.adoptionPending ? randomBytes(32).toString('hex') : previous.token;
        await writePrivateJson(file, { ...previous, bootId, adoptionPending: false, token });
        return token;
      }
      if (sameOrUnknownBoot && (await probe(previous.identity.pid)).kind !== 'absent') {
        throw new HerdrError('session-id-owner', 'Cannot prove the session ID owner absent');
      }
    }
    const token = randomBytes(32).toString('hex');
    await writePrivateJson(file, { version: 1, sessionId, identity: { pid: identity.pid, startIdentity: identity.startIdentity }, bootId, adoptionPending: false, token } satisfies IdLockRecord);
    return token;
  });
  return {
    async release() {
      await locked(async () => {
        const current = await read();
        if (current?.token === token) {
          if (current.handoff) throw new HerdrError('session-id-owner', 'Session ID handoff is pending');
          await unlink(file);
        }
      });
    },
    async clearHandoff(operationId) {
      return locked(async () => {
        const current = await read();
        if (!current || current.token !== token || current.handoff?.operationId !== operationId) return false;
        const { handoff: _handoff, ...record } = current;
        await writePrivateJson(file, record);
        return true;
      });
    },
    async cancelHandoff(operationId) {
      return locked(async () => {
        const current = await read();
        if (!current || current.token !== token || current.handoff?.operationId !== operationId) return false;
        await unlink(file);
        return true;
      });
    },
    async prepareHandoff(operationId, sessionFile, coreId) {
      if (!operationIdValid(operationId) || sessionFile !== undefined && (!isAbsolute(sessionFile) || sessionFile.includes('\0')) ||
          coreId !== undefined && !coreIdValid(coreId)) throw new HerdrError('invalid-session-id-lock', 'Launch operation ID, file, or core is invalid');
      return locked(async () => {
        const current = await read();
        if (!current || current.token !== token || current.handoff || !current.bootId) throw new HerdrError('session-id-owner', 'Session ID handoff is unavailable');
        const handoff = { operationId, nonce: randomBytes(32).toString('hex'), ...(sessionFile === undefined ? {} : { file: sessionFile }),
          ...(coreId === undefined ? {} : { coreId }) };
        await writePrivateJson(file, { ...current, handoff });
        return handoff;
      });
    },
    async transfer(next) {
      if (!validIdentity(next)) throw new HerdrError('invalid-session-id-lock', 'Process identity is required');
      await locked(async () => {
        const current = await read();
        if (!current || current.token !== token || current.handoff) throw new HerdrError('session-id-owner', 'Session ID ownership transfer is unauthorized');
        const changedOwner = current.identity.pid !== next.pid || current.identity.startIdentity !== next.startIdentity;
        await writePrivateJson(file, { ...current, identity: { pid: next.pid, startIdentity: next.startIdentity }, adoptionPending: current.adoptionPending || changedOwner });
      });
    },
  };
}
