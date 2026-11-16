// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@spider/db-core';
import { expect, test } from 'vitest';
import { PANE_LEASE_WRITER } from '../herdr/pane-lease.js';
test('a stopped console lease removes its mirror and repeated removal is safe', async () => {
  const base = join(paths.scratch('worktree', process.cwd()), 'pane-lease-tests'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'r-'));
  try {
    const run = (state: string, expiresAt: number) => spawnSync(process.execPath, ['-e', PANE_LEASE_WRITER, root, 'lease-1'], { input: JSON.stringify({ version: 1, leaseId: 'lease-1', expiresAt, state }), encoding: 'utf8' });
    expect(run('active', Date.now() + 20000).status).toBe(0);
    expect(run('stopped', 0).status).toBe(0);
    await expect(stat(join(root, '.view-leases/lease-1.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(run('stopped', 0).status).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('qualified console lease mirror is private, atomic and refuses a symlink', async () => {
  const base = join(paths.scratch('worktree', process.cwd()), 'pane-lease-tests'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'r-'));
  try {
    const lease = { version: 1, leaseId: 'lease-1', expiresAt: Date.now() + 20000 };
    const run = () => spawnSync(process.execPath, ['-e', PANE_LEASE_WRITER, root, lease.leaseId], { input: JSON.stringify(lease), encoding: 'utf8' });
    expect(run().status).toBe(0); const file = join(root, '.view-leases/lease-1.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600); expect((await stat(join(root, '.view-leases'))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(lease);
    await rm(file); await symlink(join(root, 'outside'), file); expect(run().status).toBe(1); await expect(stat(join(root, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
