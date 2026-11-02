// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { connect } from 'node:net';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { rejectSymlinks } from './publisher.js';
const cursors = new Map<string, string>();
export async function boundedEntries(directory: string, maxEntries: number): Promise<string[]> {
  await rejectSymlinks(directory);
  let entries: string[];
  try { entries = (await readdir(directory)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const after = cursors.get(directory) ?? '';
  const start = entries.findIndex(name => name > after);
  const selected = entries.slice(start < 0 ? 0 : start, (start < 0 ? 0 : start) + Math.max(1, Math.min(64, maxEntries)));
  if (selected.length) cursors.set(directory, selected.at(-1)!);
  return selected;
}
export function socketPresence(address: string): Promise<'live' | 'absent' | 'unknown'> {
  return new Promise(resolve => {
    const socket = connect(address);
    const done = (state: 'live' | 'absent' | 'unknown') => { socket.destroy(); resolve(state); };
    socket.once('connect', () => done('live'));
    socket.once('error', error => done(['ECONNREFUSED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'absent' : 'unknown'));
    socket.setTimeout(100, () => done('unknown'));
  });
}
async function privateIdentity(path: string) {
  await rejectSymlinks(path);
  const info = await lstat(path);
  if (info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) throw new Error('unsafe-ipc-file');
  return info;
}
export async function sweepSessionIpc(directory: string): Promise<void> {
  for (const name of await boundedEntries(directory, 64)) {
    if (!name.endsWith('.sock') && !name.endsWith('.cap')) continue;
    const path = join(directory, name); const socket = path.replace(/\.cap$/, '.sock');
    try {
      const before = await privateIdentity(path);
      if (name.endsWith('.cap') && Date.now() - before.mtimeMs < 60000) continue;
      if (name.endsWith('.sock') && !before.isSocket() || name.endsWith('.cap') && !before.isFile()) continue;
      if (await socketPresence(socket) !== 'absent') continue;
      const current = await privateIdentity(path);
      if (current.ino !== before.ino || current.dev !== before.dev) continue;
      await rm(path);
      if (name.endsWith('.sock')) {
        const capability = path.replace(/\.sock$/, '.cap');
        try { if ((await privateIdentity(capability)).isFile()) await rm(capability); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    } catch { /* Unverified files remain untouched; one bad entry cannot stop the bounded pass. */ }
  }
}
