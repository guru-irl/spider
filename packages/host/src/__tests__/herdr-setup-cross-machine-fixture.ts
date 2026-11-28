// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile, lstat, readdir, readlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { digest } from '../../../herdr/src/setup/backup.js';
import type { SetupFixture } from './herdr-setup-fixture.js';
import { releaseFixture } from './herdr-setup-release-fixture.js';
import { useStaticSetupApp } from './herdr-setup-focused-fixture.js';

type Release = Parameters<typeof releaseFixture>[0];
export const fastRelease = async (version: Release, localOnly = true): Promise<SetupFixture> =>
  useStaticSetupApp(await releaseFixture(version, { coreTransport: 'socket', localOnly }), version);
export const changingAppVersion = async (version: Release, coreTransport: 'process' | 'socket' = 'socket'): Promise<SetupFixture> =>
  useStaticSetupApp(await releaseFixture(version, { coreTransport, localOnly: true }), null);

export async function tree(root: string): Promise<string[]> {
  const rows: string[] = [];
  async function visit(path: string): Promise<void> {
    let info;
    try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { rows.push(`${relative(root, path)} missing`); return; } throw error; }
    const name = relative(root, path) || '.';
    if (info.isSymbolicLink()) { rows.push(`${name} link ${await readlink(path)}`); return; }
    if (info.isDirectory()) {
      rows.push(`${name} directory ${info.mode & 0o777}`);
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
    } else if (info.isFile()) rows.push(`${name} file ${info.mode & 0o777} ${digest(await readFile(path))}`);
    else rows.push(`${name} special ${info.mode}`);
  }
  await visit(root); return rows;
}
