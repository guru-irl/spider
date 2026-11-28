import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJournal } from '../../../herdr/src/setup/backup.js';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { cleanup, fixture } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';

// These fixtures own no unrelated pi sessions on the host.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fastFixture = () => focusedSetupFixture({ coreTransport: 'socket' });

it('rollback keeps the remote runtime shared by installs with the same digest', async () => {
  const f = await fastFixture();
  const runtimeBytes = await readFile(join(f.root, 'dist/herdr/remote-runtime.mjs'));
  const digest = createHash('sha256').update(runtimeBytes).digest('hex');
  const runtimePath = join(f.h.directories.remote, `spider-remote-runtime-${digest.slice(0, 16)}.mjs`);
  const machine = f.request.config.machines[0].name;
  const uploads = vi.spyOn(f.parts.hc, 'fileWrite');
  const runtimeUploads = () => uploads.mock.calls.filter(([on, path]) => on === machine && path === runtimePath);

  await setupHerdr(f.request, f.parts);
  expect(runtimeUploads()).toHaveLength(1);
  expect(await f.parts.hc.fileRead(machine, runtimePath)).toEqual(runtimeBytes);
  const runtimeEntry = { machine, path: runtimePath, before: null, after: digest };
  const installedJournal = await readJournal(f.request.journalRoot);
  expect(installedJournal.entries.length).toBeGreaterThan(0);
  expect(installedJournal.runtimes).toEqual([runtimeEntry]);

  await rollbackHerdr(f.request, f.parts);
  expect(await f.parts.hc.fileRead(machine, runtimePath)).toEqual(runtimeBytes);
  const rolledBackJournal = await readJournal(f.request.journalRoot);
  expect(rolledBackJournal.entries).toEqual([]);
  expect(rolledBackJournal.runtimes).toEqual([runtimeEntry]);

  await setupHerdr(f.request, f.parts);
  expect(runtimeUploads()).toHaveLength(1);
  expect(await f.parts.hc.fileRead(machine, runtimePath)).toEqual(runtimeBytes);
});

it('rollback keeps a later rc edit after setup with a missing newline and an upgrade', async () => {
  const f = await fixture();
  await writeFile(f.request.config.shellRc, 'export BEFORE=1');
  await setupHerdr(f.request, f.parts);
  await writeFile(f.request.config.shellRc, (await readFile(f.request.config.shellRc, 'utf8')) + 'export AFTER=2\n');
  const mod = join(f.root, 'packages/herdr/assets/mods/spider/main.js');
  await writeFile(mod, (await readFile(mod, 'utf8')) + '\n// upgraded asset\n');
  await setupHerdr(f.request, f.parts);
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(f.request.config.shellRc, 'utf8')).toBe('export BEFORE=1\nexport AFTER=2\n');
});
