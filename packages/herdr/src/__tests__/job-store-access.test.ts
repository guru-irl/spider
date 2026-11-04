// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { createJobStore } from '../jobs/store.js';
import { cleanup, monitorFixture } from './herdr-monitor-fixture.js';

const calls = vi.hoisted(() => ({ mkdir: 0, chmod: 0, lstat: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs,
    mkdir: (...args: Parameters<typeof fs.mkdir>) => { calls.mkdir++; return fs.mkdir(...args); },
    chmod: (...args: Parameters<typeof fs.chmod>) => { calls.chmod++; return fs.chmod(...args); },
    lstat: (...args: Parameters<typeof fs.lstat>) => { calls.lstat++; return fs.lstat(...args); },
  };
});
function reset() { calls.mkdir = 0; calls.chmod = 0; calls.lstat = 0; }

it('reads existing and missing journals without changing directories', async () => {
  const h = await monitorFixture(), root = join(h.f.root, 'one', 'two', 'three', 'four');
  const store = createJobStore(root, h.owner.sessionId, 'present' as never);
  const journal = await store.read(); await store.write(journal);
  const reader = createJobStore(root, h.owner.sessionId, 'present' as never);
  reset();
  expect(await reader.read()).toEqual(journal);
  expect({ mkdir: calls.mkdir, chmod: calls.chmod }).toEqual({ mkdir: 0, chmod: 0 });
  const initialChecks = calls.lstat;
  reset();
  expect(await reader.read()).toEqual(journal);
  expect({ mkdir: calls.mkdir, chmod: calls.chmod }).toEqual({ mkdir: 0, chmod: 0 });
  expect(calls.lstat).toBeLessThan(initialChecks);
  const missing = createJobStore(root, h.owner.sessionId, 'absent' as never);
  reset();
  expect((await missing.read()).jobs).toEqual([]);
  expect({ mkdir: calls.mkdir, chmod: calls.chmod }).toEqual({ mkdir: 0, chmod: 0 });
  expect(calls.lstat).toBeGreaterThan(0);
  const { access } = await import('node:fs/promises');
  await expect(access(missing.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  await mkdir(missing.directory, { recursive: true }); reset();
  expect((await missing.read()).jobs).toEqual([]);
  expect({ mkdir: calls.mkdir, chmod: calls.chmod }).toEqual({ mkdir: 0, chmod: 0 });
  const missingRoot = createJobStore(join(root, 'absent-root'), h.owner.sessionId);
  reset(); expect((await missingRoot.read()).jobs).toEqual([]);
  expect({ mkdir: calls.mkdir, chmod: calls.chmod }).toEqual({ mkdir: 0, chmod: 0 });
  await expect(access(missingRoot.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  cleanup(() => reset());
});

it('rechecks descendant directories and refuses links and non-directories', async () => {
  const h = await monitorFixture(), store = createJobStore(h.f.root, h.owner.sessionId, 'guarded' as never);
  const journal = await store.read(); await store.write(journal); await store.read();
  const moved = `${store.directory}-moved`;
  await rename(store.directory, moved); await symlink(moved, store.directory);
  await expect(store.read()).rejects.toMatchObject({ code: 'unsafe-journal-path' });
  await expect(store.write(journal)).rejects.toMatchObject({ code: 'unsafe-journal-path' });
  const linkRoot = join(h.f.root, 'link-root'); await symlink(h.f.root, linkRoot);
  await expect(createJobStore(linkRoot, h.owner.sessionId).read()).rejects.toMatchObject({ code: 'unsafe-journal-path' });
  const badRoot = join(h.f.root, 'file-root'); await writeFile(badRoot, 'not a directory');
  await expect(createJobStore(badRoot, h.owner.sessionId).read()).rejects.toMatchObject({ code: 'unsafe-journal-path' });
});

it('does not walk above a verified root on repeated writes', async () => {
  const h = await monitorFixture(), root = join(h.f.root, 'deep', 'root');
  await mkdir(root, { recursive: true });
  const store = createJobStore(root, h.owner.sessionId), journal = await store.read();
  await store.write(journal); reset(); await store.write(journal);
  expect(calls.lstat).toBeLessThan(8);
});
