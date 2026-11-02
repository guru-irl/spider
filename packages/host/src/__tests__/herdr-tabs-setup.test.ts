// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, cleanup } from './herdr-setup-fixture.js';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function realTabsFixture() {
  const f = await fixture();
  await cp(join(process.env.SPIDER_HERDR_MOD_FIXTURE!, 'tabs'), join(f.h.directories.app, 'mods/tabs'), { recursive: true });
  return f;
}

test.skipIf(!process.env.SPIDER_HERDR_MOD_FIXTURE)('production setup installs tabs, doctor detects edits, and rollback removes the clone but keeps stock tabs', async () => {
  const f = await realTabsFixture(), app = f.h.directories.app;
  const stock = await readFile(join(app, 'mods/tabs/main.js'), 'utf8');
  const result = await setupHerdr(f.request, f.parts);
  expect(result.writes).toContain(join(app, 'mods/spider-tabs/main.js'));
  const source = await readFile(join(app, 'mods/spider-tabs/main.js'), 'utf8');
  expect(source).toContain('panelButton("spider", "Spider", "mods/spider-tabs/spider.svg")');
  expect(await readFile(join(app, 'mods/spider-tabs/spider.svg'), 'utf8')).toContain('stroke-width="1.5"');
  expect(JSON.parse(await readFile(join(app, 'layouts/spider-glass.json'), 'utf8')).children.find((node: { id: string }) => node.id === 'tabs').content.mod).toBe('spider-tabs');
  const manifest = JSON.parse(await readFile(join(app, 'mods/spider-tabs/mod.json'), 'utf8'));
  expect(manifest.clonedFrom).toEqual({ name: 'tabs', version: '0.1.11' });
  const doctor = await f.ports.doctorParts(f.request);
  for (const item of ['clones', 'patch-version', 'layout-theme'] as const) expect((await doctor.inspect(item, f.request)).failures).toEqual([]);
  await writeFile(join(app, 'mods/spider-tabs/main.js'), source.replace('"Spider"', '"Changed"'));
  expect((await doctor.inspect('clones', f.request)).failures).toEqual([expect.objectContaining({ code: 'installed-artifact-changed' })]);
  expect((await doctor.inspect('patch-version', f.request)).failures).toEqual([expect.objectContaining({ code: 'patch-marker-mismatch' })]);
  await writeFile(join(app, 'mods/spider-tabs/main.js'), source);
  await rollbackHerdr(f.request, f.parts);
  await expect(readFile(join(app, 'mods/spider-tabs/main.js'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(app, 'mods/spider-tabs/spider.svg'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(app, 'mods/tabs/main.js'), 'utf8')).toBe(stock);
}, 120000);

test.skipIf(!process.env.SPIDER_HERDR_MOD_FIXTURE)('a changed upstream tabs anchor refuses production setup before any clone or settings write', async () => {
  const f = await realTabsFixture(), app = f.h.directories.app;
  const settings = await readFile(join(app, 'settings.json'));
  const path = join(app, 'mods/tabs/main.js');
  await writeFile(path, (await readFile(path, 'utf8')).replace('const enabled =', 'const allowed ='));
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'patch-anchor-mismatch', message: expect.stringContaining('tabs:') });
  expect((await readdir(join(app, 'mods'))).filter(name => name.startsWith('spider-'))).toEqual([]);
  expect(await readFile(join(app, 'settings.json'))).toEqual(settings);
}, 120000);
