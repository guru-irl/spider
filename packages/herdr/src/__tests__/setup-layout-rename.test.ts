// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { parseHerdrConfig } from '../config.js';
import type { CoreId } from '../contracts.js';
import { doctorHerdr, type DoctorParts } from '../setup/doctor.js';
import { runHerdrCli } from '../setup/cli.js';
import { applyFiles, prepareBackups, readJournal, saveJournal, snapshot } from '../setup/backup.js';
import { setupHerdr, type SetupParts, type SetupRequest } from '../setup/installer.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const oldLook = Buffer.from('{"theme":"spider-glass","cell_background_opacity":0.42}\n');
const newLook = Buffer.from('{"theme":"spider-glass","cell_background_opacity":0.6}\n');
async function fixture() {
  const root = await mkdtemp(join(process.env.SPIDER_GLOBAL_ROOT!, 'layout-rename-')); roots.push(root);
  const app = join(root, 'app'), layouts = join(app, 'layouts'), globalRoot = join(root, 'global');
  const request: SetupRequest = { config: parseHerdrConfig({ app: { binary: '/usr/bin/false', home: app }, core: { binary: '/usr/bin/false', config: join(root, 'core.toml') },
    agentDirectory: join(root, 'agent'), globalRoot, shellRc: join(root, 'shellrc'), spaces: [], machines: [] }),
  configPath: join(globalRoot, 'herdr/config.json'), packageRoot: root, journalRoot: join(globalRoot, 'herdr/setup') };
  const legacy = join(layouts, 'spider-glass.json'), spider = join(layouts, 'Spider.json'), shared = join(app, 'shared.json');
  const checkpoint = join(request.journalRoot, 'checkpoint.json'), journalPath = join(request.journalRoot, 'journal.json');
  const owners = { terminals: [], identities: { fixture: 'owner' } };
  await mkdir(layouts, { recursive: true }); await mkdir(globalRoot);
  await writeFile(request.config.core.config, 'notes = false\n');
  const doctor: DoctorParts = { targets: async () => [], inspect: async () => ({ failures: [] }), launchHistory: async () => [], probeMachineNode: async () => { throw new Error('No remote probe expected'); } };
  const selections: string[] = [];
  const selectApp = async () => {
    await readFile(spider); // Herdr can only switch after the new layout exists.
    selections.push('Spider');
    const current = await readFile(shared, 'utf8').then(text => JSON.parse(text), error => {
      if (error.code !== 'ENOENT') throw error;
      return {};
    });
    await writeFile(shared, JSON.stringify({ ...current, layout: 'Spider' }));
  };
  const parts: SetupParts = {
    preflight: async () => ({ fingerprint: 'look', coreIdentity: { coreId: 'core' as CoreId, socket: join(root, 'core.sock'), sessionNamespace: 'fixture' },
      mods: [], targets: [], retiredTerminals: [], layoutExport: true, recoveredCutover: owners, cutoverActions: [] }),
    stageLook: async (_, context) => [{ path: spider, bytes: newLook, expected: context.installed[spider] ?? null, collision: 'clone' }],
    installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [],
    probeMachineNode: doctor.probeMachineNode, ensureRuntime: async () => [], bootstrapRuntime: async () => {},
    hc: { fileRead: async () => { throw new Error('No remote read expected'); }, fileWrite: async () => { throw new Error('No remote write expected'); } },
    cutover: async (_, context) => {
      await context.selectApp?.();
      return owners;
    },
    selectApp, verify: async req => doctorHerdr(req, doctor), rollback: async () => {}, warn: () => {},
  };
  const upgrade = async (choice: string, withBackup = false) => {
    const journal = await readJournal(request.journalRoot);
    if (withBackup) await writeFile(legacy, '{"layout":"before setup"}\n', { mode: 0o640 });
    const files = [{ path: legacy, expected: (await snapshot(legacy)).hash, bytes: oldLook, mode: 0o640 }];
    await prepareBackups(request.journalRoot, files, journal); await applyFiles(request.journalRoot, files, journal);
    journal.verified = true; journal.cutover = owners; await saveJournal(request.journalRoot, journal);
    await writeFile(shared, `{"layout":${JSON.stringify(choice)},"user.mod":"keep"}\n`);
  };
  const rollback = async (args: string[] = []) => {
    const errors: string[] = [];
    const result = await runHerdrCli(['rollback', ...args], {
      request: async () => request, setupParts: async () => parts, doctorParts: async () => doctor,
      stdout: () => {}, stderr: text => errors.push(text),
    });
    expect(result, errors.join('')).toBe(0);
  };
  return { request, parts, doctor, layouts, legacy, spider, shared, checkpoint, journalPath, selections, upgrade, rollback,
    undo: () => rollback(['--undo-upgrade']) };
}

test('fresh setup selects the installed Spider layout in Herdr shared state', async () => {
  const f = await fixture();
  await setupHerdr(f.request, f.parts);
  expect(await readdir(f.layouts)).toEqual(['Spider.json']);
  expect(JSON.parse(await readFile(f.shared, 'utf8')).layout).toBe('Spider');
  expect(f.selections).toEqual(['Spider']);
});

test('a dry run lists the layout rename without changing files or switching Herdr', async () => {
  const f = await fixture(); await f.upgrade('spider-glass');
  const before = await readFile(f.journalPath);
  const preview = await setupHerdr({ ...f.request, dryRun: true }, f.parts);
  expect(preview.plan?.files).toContainEqual({ path: f.legacy, action: 'remove' });
  expect(preview.plan?.files).toContainEqual({ path: f.spider, action: 'write' });
  expect(f.selections).toEqual([]);
  expect(await readdir(f.layouts)).toEqual(['spider-glass.json']);
  expect(await readFile(f.legacy)).toEqual(oldLook);
  expect(await readFile(f.journalPath)).toEqual(before);
  await expect(stat(f.checkpoint)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('upgrades the old selected layout once, keeps shared mod data, and does not rewrite on repeat', async () => {
  const f = await fixture(); await f.upgrade('spider-glass');
  await setupHerdr(f.request, f.parts);
  expect(await readdir(f.layouts)).toEqual(['Spider.json']);
  expect(await readFile(f.spider)).toEqual(newLook);
  expect(JSON.parse(await readFile(f.shared, 'utf8'))).toEqual({ layout: 'Spider', 'user.mod': 'keep' });
  const [checkpoint, journal, layout] = await Promise.all([readFile(f.checkpoint), readFile(f.journalPath), stat(f.spider)]);
  expect(await setupHerdr(f.request, f.parts)).toMatchObject({ writes: [], journalChanged: false });
  expect(await readFile(f.checkpoint)).toEqual(checkpoint);
  expect(await readFile(f.journalPath)).toEqual(journal);
  expect((await stat(f.spider)).ino).toBe(layout.ino);
  expect(f.selections).toEqual(['Spider']);
});

test('an unrelated shared-state write during setup does not block the migration', async () => {
  const f = await fixture(); await f.upgrade('spider-glass');
  const ensureRuntime = f.parts.ensureRuntime;
  f.parts.ensureRuntime = async (...args) => {
    await writeFile(f.shared, '{"layout":"spider-glass","user.mod":"changed during setup"}');
    return ensureRuntime(...args);
  };
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(f.shared, 'utf8'))).toEqual({ layout: 'Spider', 'user.mod': 'changed during setup' });
});

test('upgrade and its repeat keep a different layout selected', async () => {
  const f = await fixture(); await f.upgrade('personal');
  const before = await readFile(f.shared);
  await setupHerdr(f.request, f.parts);
  expect(await readdir(f.layouts)).toEqual(['Spider.json']);
  expect(await setupHerdr(f.request, f.parts)).toMatchObject({ writes: [], journalChanged: false });
  expect(f.selections).toEqual([]);
  expect(await readFile(f.shared)).toEqual(before);
});

test.each(['Spider.json', 'spider.json'])('refuses an unowned %s even with replacement and matching bytes', async (fileName) => {
  const f = await fixture(); const target = join(f.layouts, fileName);
  await writeFile(target, newLook);
  await expect(setupHerdr({ ...f.request, replaceChanged: true }, f.parts)).rejects.toMatchObject({ code: 'layout-name-conflict', message: expect.stringMatching(/Spider\.json.*(move|rename)/is) });
  expect(f.selections).toEqual([]);
  expect(await readdir(f.layouts)).toEqual([fileName]);
  expect(await readFile(target)).toEqual(newLook);
  await expect(stat(f.checkpoint)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('refuses both names even when the new layout belongs to setup', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const before = await readFile(f.checkpoint);
  await writeFile(f.legacy, oldLook);
  await expect(setupHerdr({ ...f.request, dryRun: true, replaceChanged: true }, f.parts)).rejects.toMatchObject({ code: 'layout-name-conflict', message: expect.stringContaining('spider-glass.json') });
  expect(await readFile(f.legacy)).toEqual(oldLook);
  expect(await readFile(f.spider)).toEqual(newLook);
  expect(await readFile(f.checkpoint)).toEqual(before);
});

test('rollback --undo-upgrade restores the old file, exact bytes and mode, and persisted selection', async () => {
  const f = await fixture(); await f.upgrade('spider-glass');
  const shared = await readFile(f.shared), journal = await readFile(f.journalPath);
  await chmod(f.legacy, 0o644);
  await setupHerdr(f.request, f.parts);
  expect(await readdir(f.layouts)).toEqual(['Spider.json']);
  // Another mod owns this key and may write it even between setup and undo.
  await writeFile(f.shared, JSON.stringify({ ...JSON.parse(await readFile(f.shared, 'utf8')), 'later.mod': 3 }));
  await f.undo();
  expect(await readdir(f.layouts)).toEqual(['spider-glass.json']);
  expect(await readFile(f.legacy)).toEqual(oldLook);
  expect((await stat(f.legacy)).mode & 0o777).toBe(0o644);
  expect(JSON.parse(await readFile(f.shared, 'utf8'))).toEqual({ ...JSON.parse(shared.toString()), 'later.mod': 3 });
  expect(await readFile(f.journalPath)).toEqual(journal);
});

test.each([
  { owned: true, withBackup: true, replaceChanged: false },
  { owned: true, withBackup: false, replaceChanged: true },
  { owned: false, withBackup: false, replaceChanged: true },
])('refuses edited or unowned legacy bytes before setup writes (%j)', async ({ owned, withBackup, replaceChanged }) => {
  const f = await fixture();
  if (owned) await f.upgrade('personal', withBackup);
  const old = 'broken layout\n'; await writeFile(f.legacy, old);
  const before = await snapshot(f.journalPath);
  await expect(setupHerdr({ ...f.request, replaceChanged }, f.parts)).rejects.toMatchObject({ code: 'unowned-clone-collision' });
  expect(await readdir(f.layouts)).toEqual(['spider-glass.json']);
  expect(await readFile(f.legacy, 'utf8')).toBe(old);
  expect(await snapshot(f.journalPath)).toEqual(before);
  await expect(stat(f.checkpoint)).rejects.toMatchObject({ code: 'ENOENT' });
  if (!owned) await expect(stat(f.request.journalRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.selections).toEqual([]);
});

test.each(['undo', 'rollback'] as const)('%s restores the exact edited layout after authorized replacement', async (command) => {
  const f = await fixture(); await f.upgrade('personal', true);
  const old = 'broken layout\n'; await writeFile(f.legacy, old); await chmod(f.legacy, 0o644);
  await setupHerdr({ ...f.request, replaceChanged: true }, f.parts);
  expect(await readdir(f.layouts)).toEqual(['Spider.json']);
  await f[command]();
  expect(await readdir(f.layouts)).toEqual(['spider-glass.json']);
  expect(await readFile(f.legacy, 'utf8')).toBe(old);
  expect((await stat(f.legacy)).mode & 0o777).toBe(0o644);
});

test('setup does not remove a differently cased legacy-looking user layout', async () => {
  const f = await fixture(), custom = join(f.layouts, 'SPIDER-GLASS.json');
  await writeFile(custom, '{"user":"keep"}');
  await setupHerdr(f.request, f.parts);
  expect((await readdir(f.layouts)).sort()).toEqual(['SPIDER-GLASS.json', 'Spider.json']);
  expect(await readFile(custom, 'utf8')).toBe('{"user":"keep"}');
});

test('interrupted migration retains the old file and can be undone if both names exist', async () => {
  const f = await fixture(); await f.upgrade('spider-glass');
  const select = f.parts.selectApp!;
  f.parts.selectApp = async (req, mode) => { await select(req, mode); throw new Error('selection interrupted'); };
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('selection interrupted');
  expect((await readdir(f.layouts)).sort()).toEqual(['Spider.json', 'spider-glass.json']);
  expect(await readFile(f.legacy)).toEqual(oldLook);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'layout-name-conflict', message: expect.stringContaining('--undo-upgrade') });
  await f.undo();
  expect(await readdir(f.layouts)).toEqual(['spider-glass.json']);
  expect(JSON.parse(await readFile(f.shared, 'utf8')).layout).toBe('spider-glass');
});

async function withLegacyKeys(f: Awaited<ReturnType<typeof fixture>>, current: object) {
  const path = join(f.request.config.app.home, 'keys.json');
  await writeFile(path, JSON.stringify(current));
  f.parts.installFiles = async () => [{ path, expected: (await snapshot(path)).hash, bytes: Buffer.alloc(0),
    keys: { 'layout:Spider': { 'cmd-shift-e': 'spider-pane.park' } }, collision: 'key' }];
  return path;
}

test('moves layout-scoped keys and restores their old section on upgrade undo', async () => {
  const f = await fixture(); await f.upgrade('spider-glass');
  const bindings = { 'cmd-shift-e': 'spider-pane.park', 'cmd-alt-x': { command: 'layout.show', args: { id: 'tools' } } };
  const path = await withLegacyKeys(f, { global: {}, 'layout:spider-glass': bindings });
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ global: {}, 'layout:Spider': bindings });
  expect(await setupHerdr(f.request, f.parts)).toMatchObject({ writes: [], journalChanged: false });
  await writeFile(path, JSON.stringify({ global: { 'cmd-alt-a': 'user.action' }, 'layout:Spider': bindings }));
  await f.undo();
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ global: { 'cmd-alt-a': 'user.action' }, 'layout:spider-glass': bindings });
});

test('refuses to merge competing user keys across the two layout sections', async () => {
  const f = await fixture(); await f.upgrade('spider-glass');
  const path = await withLegacyKeys(f, { 'layout:spider-glass': { 'cmd-k': 'old.action' }, 'layout:Spider': { 'cmd-k': 'new.action' } });
  const before = await readFile(path);
  await expect(setupHerdr({ ...f.request, overwriteUnownedKeys: true }, f.parts)).rejects.toMatchObject({ code: 'key-binding-conflict', message: expect.stringContaining('cmd-k') });
  expect(await readFile(path)).toEqual(before);
  expect(await readdir(f.layouts)).toEqual(['spider-glass.json']);
});

test('doctor reports both a leftover legacy file and the stale Herdr selection', async () => {
  const f = await fixture(); await f.upgrade('spider-glass');
  const { failures } = await doctorHerdr(f.request, f.doctor);
  expect(failures).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'legacy-layout-present', message: expect.stringContaining('spider-glass.json') }),
    expect.objectContaining({ code: 'legacy-layout-selected', message: expect.stringContaining('shared.json') }),
  ]));
  expect(await readFile(f.legacy)).toEqual(oldLook);
  expect(JSON.parse(await readFile(f.shared, 'utf8')).layout).toBe('spider-glass');
});
