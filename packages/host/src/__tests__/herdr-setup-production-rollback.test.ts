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

test.skipIf(process.env.SPIDER_HERDR_E2E !== '1')('real isolated production setup preserves edits upgrades and repeats doctor probes without an app window', async () => {
  const f = await fixture('hc', true);
  const first = await setupHerdr(f.request, f.parts);
  expect(first.probes).toHaveLength(1); expect(first.probes[0].version).toBe(process.version);
  const before = await readFile(join(f.request.journalRoot, 'journal.json'));
  expect((await setupHerdr(f.request, f.parts)).probes).toEqual([]);
  expect(await readFile(join(f.request.journalRoot, 'journal.json'))).toEqual(before);
  await editUnrelated(f); await setupHerdr(f.request, f.parts);
  const source = join(f.root, 'packages/herdr/assets/mods/spider/main.js'); await writeFile(source, (await readFile(source, 'utf8')) + '\n// updated artifact\n');
  await writeFile(join(f.root, 'dist/herdr/remote-runtime.mjs'), (await readFile(join(f.root, 'dist/herdr/remote-runtime.mjs'), 'utf8')) + '\n// runtime update\n');
  const upgraded = await setupHerdr(f.request, f.parts);
  expect(upgraded.writes).toContain(join(f.h.directories.app, 'mods/spider-panel/main.js'));
  expect(upgraded.probes).toHaveLength(1);
  const runtime = (await f.parts.ensureRuntime(f.request, f.context))[0];
  expect(await f.parts.hc.fileRead(runtime.machine, runtime.path)).toEqual(runtime.bytes);
  const doctor = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
  expect(doctor.failures).toEqual([]); expect(doctor.probes).toHaveLength(1);
  expect(JSON.parse(await readFile(join(f.h.directories.agent, 'settings.json'), 'utf8')).unrelated).toBe('edited');
  await writeFile(resolve('.spider/scratch/production-real-evidence.json'), JSON.stringify({ localSocket: f.h.localSocket, remoteSocket: f.h.remoteSocket, appHome: f.request.config.app.home, appBinary: f.request.config.app.binary, probes: [first.probes, upgraded.probes, doctor.probes], warnings: doctor.warnings, runtimePath: runtime.path }, null, 2));
  await f.ports.dispose(); await f.h.cli(['machine', 'rm', 'remote.invalid', '--json']);
  await f.h.close();
  cleanup.splice(0);
  expect(await f.h.remainingOwnedResources()).toEqual([]);
  expect(f.h.cleanupProof).toMatchObject({ mode: 'hc', defaultCoreUnchanged: true, remaining: [] });
  await writeFile(resolve('.spider/scratch/production-real-cleanup.json'), JSON.stringify(f.h.cleanupProof, null, 2));
}, 60_000);

test('doctor rejects an older runtime when the current package requires new bytes', async () => {
  const f = await focusedSetupFixture({ coreTransport: 'socket' }); await setupHerdr(f.request, f.parts);
  const path = join(f.root, 'dist/herdr/remote-runtime.mjs'); await writeFile(path, (await readFile(path, 'utf8')) + '\n// new runtime\n');
  expect((await (await f.ports.doctorParts(f.request)).inspect('runtime-digest', f.request)).failures.length).toBeGreaterThan(0);
});

test('a pi save then replan never replaces the original settings backup', async () => {
  const f = await fastFixture(); await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.agent, 'settings.json');
  const original = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === path)!;
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), defaultModel: 'user-choice' }, null, 2));
  await setupHerdr(f.request, f.parts);
  const replanned = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === path)!;
  expect(replanned.before).toBe(original.before);
  expect(replanned.backup).toBe(original.backup);
  await rollbackHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(path, 'utf8')).theme).toBe('stock');
});

test('production rollback reverses only managed parts after unrelated shared edits', async () => {
  const f = await fastFixture();
  await writeFile(f.request.config.shellRc, 'export ORIGINAL=kept\n');
  await writeFile(f.request.config.core.config, 'notes = true\n[custom]\noriginal = 1\n');
  const keys = join(f.h.directories.app, 'keys.json');
  await writeFile(keys, JSON.stringify({ terminal: { 'cmd-shift-o': 'user.original', 'ctrl-x': 'user.keep' } }));
  f.request.overwriteUnownedKeys = true;
  await setupHerdr(f.request, f.parts); await editUnrelated(f);
  const appSettings = join(f.h.directories.app, 'settings.json');
  await writeFile(appSettings, JSON.stringify({ ...JSON.parse(await readFile(appSettings, 'utf8')), zoom: 2 }));
  const global = join(f.h.directories.global, 'config.json');
  await writeFile(global, JSON.stringify({ ...JSON.parse(await readFile(global, 'utf8')), userChoice: 'keep' }));
  const restored = await rollbackHerdr(f.request, f.parts);
  expect(restored).toContain(f.request.config.shellRc);
  expect(await readFile(f.request.config.shellRc, 'utf8')).toBe('export ORIGINAL=kept\nexport USER_CHOICE=kept\n');
  expect(JSON.parse(await readFile(join(f.h.directories.agent, 'settings.json'), 'utf8'))).toEqual({ theme: 'stock', unrelated: 'edited' });
  expect(JSON.parse(await readFile(appSettings, 'utf8'))).toEqual({ zoom: 2, theme: 'stock' });
  expect(JSON.parse(await readFile(keys, 'utf8'))).toEqual({ terminal: { 'cmd-shift-o': 'user.original', 'ctrl-x': 'user.keep' }, global: { 'ctrl-q': 'user.action' } });
  expect(JSON.parse(await readFile(global, 'utf8'))).toMatchObject({ userChoice: 'keep' });
  expect(JSON.parse(await readFile(global, 'utf8'))['herdr.config']).toBeUndefined();
  expect(await readFile(f.request.config.core.config, 'utf8')).toContain('notes = true');
  expect(await readFile(f.request.config.core.config, 'utf8')).toContain('value = 42');
  expect(await readFile(join(f.h.directories.global, 'herdr/resume.sh')).then(() => true, () => false)).toBe(false);
});
