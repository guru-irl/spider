// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { lstat, readFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HerdrError } from '../client/parse.js';
import type { ProcessIdentity, ProcessProbe } from './lease.js';
import { hash, privateDirectory, readPrivateJson, withProcessLock, writePrivateJson } from './registry.js';

interface IdLockRecord {
  version: 1;
  sessionId: string;
  identity: ProcessIdentity;
  bootId: string;
  adoptionPending: boolean;
  token: string;
}

const execFileAsync = promisify(execFile);

async function localBootId(): Promise<string> {
  try {
    if (process.platform === 'linux') return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (process.platform === 'darwin') return (await execFileAsync('sysctl', ['-n', 'kern.boottime'])).stdout.trim();
  } catch { /* Treat unavailable boot identity as unknown. */ }
  return '';
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

function parseRecord(value: unknown, sessionId: string): IdLockRecord {
  const record = value as IdLockRecord;
  if (!record || record.version !== 1 || record.sessionId !== sessionId || !validIdentity(record.identity) || typeof record.bootId !== 'string' || record.bootId !== record.bootId.trim() || typeof record.adoptionPending !== 'boolean' || typeof record.token !== 'string' || !/^[a-f0-9]{64}$/.test(record.token)) {
    throw new HerdrError('invalid-session-id-lock', 'Session ID ownership record is invalid');
  }
  return record;
}

export async function claimIdLock(root: string, sessionId: string, identity: ProcessIdentity, probe: (pid: number) => Promise<ProcessProbe>, options: { bootId?: () => Promise<string> } = {}): Promise<{release(): Promise<void>; transfer(next: ProcessIdentity): Promise<void>}> {
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
    if (previous) {
      if (!previous.bootId || !bootId) throw new HerdrError('session-id-owner', 'Cannot prove the session ID owner absent');
      const sameBoot = previous.bootId === bootId;
      const sameIdentity = previous.identity.pid === identity.pid && previous.identity.startIdentity === identity.startIdentity;
      if (sameBoot && sameIdentity) {
        if (!previous.adoptionPending) return previous.token;
        // After handoff, the launcher must not release the adopted owner's lock.
        const token = randomBytes(32).toString('hex');
        await writePrivateJson(file, { ...previous, adoptionPending: false, token });
        return token;
      }
      if (sameBoot && (await probe(previous.identity.pid)).kind !== 'absent') {
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
        if (current?.token === token) await unlink(file);
      });
    },
    async transfer(next) {
      if (!validIdentity(next)) throw new HerdrError('invalid-session-id-lock', 'Process identity is required');
      await locked(async () => {
        const current = await read();
        if (!current || current.token !== token) throw new HerdrError('session-id-owner', 'Session ID ownership transfer is unauthorized');
        const changedOwner = current.identity.pid !== next.pid || current.identity.startIdentity !== next.startIdentity;
        await writePrivateJson(file, { ...current, identity: { pid: next.pid, startIdentity: next.startIdentity }, adoptionPending: current.adoptionPending || changedOwner });
      });
    },
  };
}
