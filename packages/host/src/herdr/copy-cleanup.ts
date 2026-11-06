// SPDX-License-Identifier: MIT
import { constants as fileFlags } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, posix } from 'node:path';
import type { HcClient, MachineName } from '@spider/herdr';

const marker = (stage: string) => `${stage}.spider-settled`;
const machineKey = (on: MachineName) => createHash('sha256').update(on).digest('hex').slice(0, 32);
const stageId = (stage: string, remoteRoot: string): string | null => {
  const match = /^\.copy-([a-f0-9]{32})$/.exec(posix.basename(stage));
  return match && posix.isAbsolute(stage) && posix.normalize(stage) === stage && posix.dirname(stage) === posix.normalize(remoteRoot) ? match[1] : null;
};

async function privateQueue(root: string, create: boolean): Promise<void> {
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new Error('Copy cleanup queue must be a private owned directory');
}

async function remember(root: string, on: MachineName, remoteRoot: string, stage: string): Promise<string> {
  const id = stageId(stage, remoteRoot);
  if (!id) throw new Error('Invalid copy staging path');
  await privateQueue(root, true);
  const path = join(root, `${machineKey(on)}-${id}.json`), temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const file = await open(temporary, fileFlags.O_WRONLY | fileFlags.O_CREAT | fileFlags.O_EXCL | (fileFlags.O_NOFOLLOW ?? 0), 0o600);
    try { await file.writeFile(JSON.stringify({ version: 1, on, stage })); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    return path;
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

/** A verified, inactive stage is safe to mark; persist first so a transport failure can be retried. */
export async function deferCopyCleanup(hc: HcClient, on: MachineName, remoteRoot: string, stage: string, root: string): Promise<boolean> {
  const pending = await remember(root, on, remoteRoot, stage).catch(() => null);
  try {
    await hc.fileWrite(on, marker(stage), Buffer.from('settled'));
    if (pending) await unlink(pending).catch(() => {});
    return true;
  } catch { return pending !== null; }
}

/** Retry a bounded number of locally recorded markers before the next copy to this machine. */
export async function retryCopyCleanups(hc: HcClient, on: MachineName, remoteRoot: string, root: string): Promise<void> {
  try { await privateQueue(root, false); } catch { return; }
  const prefix = `${machineKey(on)}-`;
  const entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isFile() && new RegExp(`^${prefix}[a-f0-9]{32}\\.json$`).test(entry.name)).slice(0, 16);
  for (const entry of entries) {
    const path = join(root, entry.name);
    let value: unknown;
    try {
      const file = await open(path, fileFlags.O_RDONLY | (fileFlags.O_NOFOLLOW ?? 0));
      try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 4096) continue; value = JSON.parse(await file.readFile('utf8')); }
      finally { await file.close(); }
    } catch { continue; }
    if (!value || typeof value !== 'object') continue;
    const record = value as { version?: unknown; on?: unknown; stage?: unknown };
    if (record.version !== 1 || record.on !== on || typeof record.stage !== 'string' || stageId(record.stage, remoteRoot) !== entry.name.slice(prefix.length, -'.json'.length)) continue;
    try { await hc.fileWrite(on, marker(record.stage), Buffer.from('settled')); }
    catch { break; }
    await unlink(path).catch(() => {});
  }
}
