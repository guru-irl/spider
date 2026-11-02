// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, fixture } from './herdr-setup-fixture.js';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

test('setup owns and verifies the brand clone, repeats without writes and restores it on rollback', async () => {
  const f = await fixture();
  const path = join(f.h.directories.app, 'mods/spider-chrome/main.js');
  const staged = await f.parts.stageLook(f.request, f.context, 'export');
  expect(staged.some(file => file.path === path)).toBe(true);
  const original = await readFile(join(f.h.directories.app, 'mods/workspace-chrome/main.js'));
  const first = await setupHerdr(f.request, f.parts);
  expect(first.writes).toContain(path);
  const installed = await readFile(path, 'utf8');
  expect(JSON.parse(await readFile(join(f.h.directories.app, 'mods/spider-chrome/mod.json'), 'utf8')).clonedFrom).toEqual({ name: 'workspace-chrome', version: '0.1.12' });
  expect(installed).not.toContain('window()?.platform === "macos"');
  expect((installed.match(/false/g) ?? []).length).toBeGreaterThanOrEqual(3);
  expect(await readFile(join(f.h.directories.app, 'mods/workspace-chrome/main.js'))).toEqual(original);
  expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
  const doctor = await f.ports.doctorParts(f.request);
  const clones = await doctor.inspect('clones', f.request);
  expect(clones.failures).toEqual([]);
  expect(clones.warnings?.some(warning => warning.repair?.includes('/spider-chrome'))).toBe(true);
  expect((await doctor.inspect('patch-version', f.request)).failures).toEqual([]);
  await writeFile(path, installed + '\n// user edit\n');
  expect((await doctor.inspect('clones', f.request)).failures.length).toBeGreaterThan(0);
  await writeFile(path, installed);
  await rollbackHerdr(f.request, f.parts);
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(join(f.h.directories.app, 'layouts/spider-glass.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(f.h.directories.app, 'mods/workspace-chrome/main.js'))).toEqual(original);
}, 90000);
