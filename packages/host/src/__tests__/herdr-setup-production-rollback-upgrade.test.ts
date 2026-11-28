import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { verifiedHerdrFile } from '../herdr/ports.js';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { doctorHerdr } from '../../../herdr/src/setup/doctor.js';
import { readJournal, digest } from '../../../herdr/src/setup/backup.js';
import { cleanup, fixture } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';
import { editUnrelated } from './herdr-setup-production-helpers.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fastFixture = () => focusedSetupFixture();

test('production upgrade rollback removes newly installed artifacts and restores user originals', async () => {
  const f = await focusedSetupFixture({ coreTransport: 'process' });
  const settings = join(f.h.directories.agent, 'settings.json'), original = await readFile(settings);
  await setupHerdr(f.request, f.parts);
  const panel = join(f.h.directories.app, 'mods/spider-panel/main.js');
  const source = join(f.root, 'packages/herdr/assets/mods/spider/main.js');
  const before = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === panel)!;
  await writeFile(source, (await readFile(source, 'utf8')) + '\n// next version\n');
  await setupHerdr(f.request, f.parts);
  const after = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === panel)!;
  expect({ before: after.before, backup: after.backup, mode: after.mode }).toEqual({ before: before.before, backup: before.backup, mode: before.mode });
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(panel).then(() => true, () => false)).toBe(false);
  expect(await readFile(settings)).toEqual(original);
});

test('setup can follow a managed rollback that preserved unrelated edits', async () => {
  const f = await fastFixture(); await setupHerdr(f.request, f.parts); await editUnrelated(f);
  await rollbackHerdr(f.request, f.parts);
  expect((await setupHerdr(f.request, f.parts)).doctor.failures).toEqual([]);
  expect(JSON.parse(await readFile(join(f.h.directories.agent, 'settings.json'), 'utf8')).unrelated).toBe('edited');
});
