// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { HerdrError } from '../client/parse.js';
import { privateDirectory } from './registry.js';

export interface LaunchHandoffFile {
  version: 1; operationId: string; sessionId: string; sessionFile: string; nonce: string; leaseToken: string;
}
const operationPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const tokenPattern = /^[a-f0-9]{64}$/;
const MAX_HANDOFF_BYTES = 64 * 1024;

function invalid(): never { throw new HerdrError('invalid-launch-handoff', 'Exact session handoff is invalid'); }
function validate(value: unknown): LaunchHandoffFile {
  const data = value as LaunchHandoffFile;
  if (!data || data.version !== 1 || typeof data.operationId !== 'string' || !operationPattern.test(data.operationId) ||
      typeof data.sessionId !== 'string' || !data.sessionId || data.sessionId.includes('\0') || typeof data.sessionFile !== 'string' ||
      !isAbsolute(data.sessionFile) || resolve(data.sessionFile) !== data.sessionFile ||
      typeof data.nonce !== 'string' || !tokenPattern.test(data.nonce) ||
      typeof data.leaseToken !== 'string' || !tokenPattern.test(data.leaseToken)) invalid();
  return data;
}
async function checkDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' &&
      ((info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.())) {
    throw new HerdrError('unsafe-state-path', 'Handoff directories must be private and locally owned');
  }
}
function directory(root: string): string { return join(resolve(root), 'handoffs'); }
export function launchHandoffPath(root: string, operationId: string): string {
  if (typeof operationId !== 'string' || !operationPattern.test(operationId)) invalid();
  return join(directory(root), `${operationId}.json`);
}
async function checkRoot(root: string): Promise<void> {
  await checkDirectory(resolve(root));
  await checkDirectory(directory(root));
}
async function openPrivate(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_HANDOFF_BYTES || process.platform !== 'win32' &&
        ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.() || info.nlink !== 1)) invalid();
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

/** Write before spawning; exclusive creation prevents replacing another operation's handoff. */
export async function writeLaunchHandoff(root: string, value: LaunchHandoffFile): Promise<string> {
  const data = validate(value), path = launchHandoffPath(root, data.operationId), bytes = Buffer.from(JSON.stringify(data));
  if (bytes.length > MAX_HANDOFF_BYTES) invalid();
  await privateDirectory(directory(root));
  await checkRoot(root);
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    return path;
  } catch (error) {
    if (handle) await unlink(path).catch(() => {});
    throw error;
  } finally { await handle?.close(); }
}

/** Read the secret only from this operation's private file and bind it to the admitted session. */
export async function readLaunchHandoff(root: string, path: string, sessionId: string, sessionFile: string): Promise<LaunchHandoffFile> {
  const dir = directory(root);
  if (!isAbsolute(path) || resolve(path) !== path || dirname(path) !== dir || !basename(path).endsWith('.json')) invalid();
  const operationId = basename(path).slice(0, -5);
  if (launchHandoffPath(root, operationId) !== path) invalid();
  await checkRoot(root);
  let handle;
  try {
    handle = await openPrivate(path);
    const buffer = Buffer.alloc(MAX_HANDOFF_BYTES + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_HANDOFF_BYTES) invalid();
    const data = validate(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
    if (data.operationId !== operationId || data.sessionId !== sessionId || data.sessionFile !== sessionFile) invalid();
    return data;
  } catch (error) {
    if (error instanceof HerdrError) throw error;
    throw new HerdrError('invalid-launch-handoff', 'Exact session handoff is missing or invalid');
  } finally { await handle?.close(); }
}

/** Remove after adoption or a proved no-start; a missing file is already cleaned up. */
export async function removeLaunchHandoff(root: string, operationId: string): Promise<void> {
  const path = launchHandoffPath(root, operationId);
  let handle;
  try {
    await checkRoot(root);
    handle = await openPrivate(path);
    await handle.close(); handle = undefined;
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  } finally { await handle?.close(); }
}
