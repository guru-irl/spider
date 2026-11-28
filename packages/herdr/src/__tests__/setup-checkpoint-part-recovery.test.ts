// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { HerdrError } from '../client/parse.js';
import { digest, readJournal, saveJournal, snapshot } from '../setup/backup.js';
import * as installer from '../setup/installer.js';
import { undoHerdrUpgrade, rollbackHerdr, setupHerdr } from '../setup/installer.js';
import { runHerdrCli } from '../setup/cli.js';
import { doctorHerdr } from '../setup/doctor.js';
import { beginRunCheckpoint, recordCheckpointWrites, readCheckpoint, finishRunCheckpoint } from '../setup/checkpoint.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename), link: vi.fn(actual.link), unlink: vi.fn(actual.unlink) };
});
const real = await vi.importActual<typeof fs>('node:fs/promises');
import { roots, installedLayout, nativeLayout, put, values, fixture, metadataRepeat } from './setup-checkpoint-fixture.js';
afterEach(async () => { vi.mocked(fs.rename).mockImplementation(real.rename); vi.mocked(fs.link).mockImplementation(real.link); vi.mocked(fs.unlink).mockImplementation(real.unlink); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

test('N3 layout undo removes new mod references while retaining unrelated layout edits', async () => {
  const f = await fixture(), stage = f.parts.stageLook;
  f.parts.stageLook = async (...args) => (await stage(...args)).map(file => file.path === f.paths.layout ? { ...file, bytes: Buffer.from('{"content":[],"generation":2,"toast":"spider-toast"}') } : file);
  await setupHerdr(f.request, f.parts);
  await put(f.paths.layout, '{"content":[],"generation":2,"toast":"spider-toast","userSize":321}');
  await undoHerdrUpgrade(f.request, f.parts);
  expect(JSON.parse(await fs.readFile(f.paths.layout, 'utf8'))).toEqual({ content: [], generation: 1, userSize: 321 });
});

test('N3 runtime store copies do not block undo or lose runtime edits', async () => {
 for (const changed of [false, true]) {
  const f = await fixture();
  const { modStoreFileName } = await import('../setup/mod-storage.js');
  const oldLayout = JSON.stringify({ content: [{ mod: 'spider-example', props: { version: 1 } }], generation: 1 });
  const newLayout = JSON.stringify({ content: [{ mod: 'spider-example', props: { version: 2 } }], generation: 2 });
  await put(f.paths.layout, oldLayout);
  const journal = await readJournal(f.request.journalRoot); journal.entries.find(entry => entry.path === f.paths.layout)!.after = digest(Buffer.from(oldLayout)); await saveJournal(f.request.journalRoot, journal);
  const source = join(f.request.config.app.home, 'data/spider-example', modStoreFileName({ version: 1 }));
  const copied = join(f.request.config.app.home, 'data/spider-example', modStoreFileName({ version: 2 }));
  await put(source, '{"selection":"old"}');
  const stage = f.parts.stageLook;
  f.parts.stageLook = async (...args) => (await stage(...args)).map(file => file.path === f.paths.layout ? { ...file, bytes: Buffer.from(newLayout) } : file);
  const warnings: string[] = []; f.parts.warn = message => warnings.push(message);
  await setupHerdr(f.request, f.parts);
  if (changed) await put(copied, '{"selection":"runtime"}');
  await undoHerdrUpgrade(f.request, f.parts);
  expect((await snapshot(copied)).bytes?.toString() ?? null).toBe(changed ? '{"selection":"runtime"}' : null);
  expect(await fs.readFile(source, 'utf8')).toBe('{"selection":"old"}');
  if (changed) expect(warnings.join(' ')).toContain(copied);
 }
});

test('N4 a journal save before its checkpoint observation cannot wedge undo', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  vi.mocked(fs.rename).mockImplementation(async (from, to) => { if (to === f.paths.main) throw new Error('stop restore'); return real.rename(from, to); });
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toThrow('stop restore');
  vi.mocked(fs.rename).mockImplementation(real.rename);
  await fs.appendFile(f.paths.journal, '\n');
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.readFile(f.paths.main, 'utf8')).toBe('old-main');
});

test('N4 runtime instructions rewritten during interrupted undo survive its retry', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  vi.mocked(fs.rename).mockImplementation(async (from, to) => { if (to === f.paths.main) throw new Error('stop restore'); return real.rename(from, to); });
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toThrow('stop restore');
  vi.mocked(fs.rename).mockImplementation(real.rename);
  await put(f.paths.added, 'runtime instructions');
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.readFile(f.paths.added, 'utf8')).toBe('runtime instructions');
});

test('N5 superseded and completed undo checkpoints discard their blobs', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const backup = join(f.request.journalRoot, 'backups');
  const names = async () => (await fs.readdir(backup)).filter(name => name.startsWith('checkpoint-'));
  const previous = await names(); expect(previous.length).toBeGreaterThan(0);
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await names()).toEqual([]);
  await setupHerdr(f.request, f.parts); await rollbackHerdr(f.request, f.parts);
  expect(await names()).toEqual([]);
});

test('N5 checkpoint blobs stay private under permissive existing backup permissions', async () => {
  const f = await fixture(), backup = join(f.request.journalRoot, 'backups');
  await fs.chmod(backup, 0o755);
  await setupHerdr(f.request, f.parts);
  expect((await fs.stat(backup)).mode & 0o777).toBe(0o700);
  for (const name of (await fs.readdir(backup)).filter(name => name.startsWith('checkpoint-'))) expect((await fs.stat(join(backup, name))).mode & 0o777).toBe(0o600);
});

test('I4 endpoint and cutover side effects have durable intents before writing', async () => {
  const f = await fixture(), endpoint = f.parts.stagePaneEndpoint!, cutover = f.parts.cutover;
  f.parts.stagePaneEndpoint = async request => {
    const run = (await fs.readFile(join(request.journalRoot, 'checkpoint.json'), 'utf8'));
    expect(JSON.parse(run).runs.at(-1).effects).toContain(f.paths.registry);
    return endpoint(request);
  };
  f.parts.cutover = async (request, context) => {
    const run = JSON.parse(await fs.readFile(join(request.journalRoot, 'checkpoint.json'), 'utf8')).runs.at(-1);
    for (const path of [f.paths.layout, f.paths.appSettings, f.paths.spaces]) expect(run.effects).toContain(path);
    return cutover(request, context);
  };
  await setupHerdr(f.request, f.parts);
});


test('N3 keyed layout nodes retain resize edits and remove only upgrade entries', async () => {
  const f = await fixture(), stage = f.parts.stageLook;
  const before = { generation: 1, children: [{ id: 'existing', content: { mod: 'spider-example' }, size: 200 }] };
  await put(f.paths.layout, JSON.stringify(before));
  const journal = await readJournal(f.request.journalRoot); journal.entries.find(entry => entry.path === f.paths.layout)!.after = (await snapshot(f.paths.layout)).hash!; await saveJournal(f.request.journalRoot, journal);
  const after = { generation: 2, children: [...before.children, { id: 'toast', content: { mod: 'spider-toast' }, size: 20 }] };
  f.parts.stageLook = async (...args) => (await stage(...args)).map(file => file.path === f.paths.layout ? { ...file, bytes: Buffer.from(JSON.stringify(after)) } : file);
  await setupHerdr(f.request, f.parts);
  await put(f.paths.layout, JSON.stringify({ ...after, children: [{ ...after.children[0], size: 300 }, after.children[1], { id: 'user', size: 400 }] }));
  await undoHerdrUpgrade(f.request, f.parts);
  expect(JSON.parse(await fs.readFile(f.paths.layout, 'utf8'))).toEqual({ generation: 1, children: [{ ...before.children[0], size: 300 }, { id: 'user', size: 400 }] });
});


test('N2 a layout-only repeat retains runtime edits captured before the repeat', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  await put(f.paths.layout, '{"content":[],"generation":2,"userSize":321}');
  const stage = f.parts.stageLook;
  f.parts.stageLook = async (...args) => (await stage(...args)).map(file => file.path === f.paths.layout ? { ...file, bytes: Buffer.from('{"content":[],"generation":3}') } : file);
  await setupHerdr({ ...f.request, replaceChanged: true }, f.parts);
  await undoHerdrUpgrade(f.request, f.parts);
  expect(JSON.parse(await fs.readFile(f.paths.layout, 'utf8'))).toEqual({ content: [], generation: 1, userSize: 321 });
  expect(await fs.readFile(f.paths.main, 'utf8')).toBe('old-main');
});


test('N5 failed checkpoint publication discards unreferenced captured blobs', async () => {
  const f = await fixture();
  const fail = (operation: typeof real.rename) => async (from: Parameters<typeof real.rename>[0], to: Parameters<typeof real.rename>[1]) => { if (to === join(f.request.journalRoot, 'checkpoint.json')) throw new Error('checkpoint unavailable'); return operation(from, to); };
  vi.mocked(fs.rename).mockImplementation(fail(real.rename)); vi.mocked(fs.link).mockImplementation(fail(real.link));
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('checkpoint unavailable');
  vi.mocked(fs.rename).mockImplementation(real.rename); vi.mocked(fs.link).mockImplementation(real.link);
  expect((await fs.readdir(join(f.request.journalRoot, 'backups'))).filter(name => name.startsWith('checkpoint-'))).toEqual([]);
});


test('N3 undo refuses custom references to a new mod until the mod is retained under another name', async () => {
  const f = await fixture(), directory = dirname(f.paths.main);
  await fs.rm(directory, { recursive: true });
  const journal = await readJournal(f.request.journalRoot); journal.entries = journal.entries.filter(entry => !entry.path.startsWith(directory + '/')); await saveJournal(f.request.journalRoot, journal);
  await setupHerdr(f.request, f.parts);
  await put(f.paths.layout, '{"content":[],"generation":2,"toast":"spider-example","userSize":321}');
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toMatchObject({ code: 'upgrade-layout-reference' });
  expect(await fs.readFile(f.paths.main, 'utf8')).toBe('new-main');
  await fs.cp(directory, join(dirname(directory), 'custom-example'), { recursive: true });
  await put(f.paths.layout, '{"content":[],"generation":2,"toast":"custom-example","userSize":321}');
  await undoHerdrUpgrade(f.request, f.parts);
  expect((await snapshot(f.paths.main)).hash).toBeNull();
  expect(await fs.readFile(join(dirname(directory), 'custom-example/main.js'), 'utf8')).toBe('new-main');
  expect(JSON.parse(await fs.readFile(f.paths.layout, 'utf8'))).toEqual({ content: [], generation: 1, toast: 'custom-example', userSize: 321 });
});


test('N4 runtime instructions survive a crash after the baseline journal was restored', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  vi.mocked(fs.rename).mockImplementation(async (from, to) => { await real.rename(from, to); if (to === f.paths.journal && (await snapshot(f.paths.main)).bytes?.toString() === 'old-main') throw new Error('stop after journal restore'); });
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toThrow('stop after journal restore');
  vi.mocked(fs.rename).mockImplementation(real.rename);
  await put(f.paths.added, 'runtime instructions');
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.readFile(f.paths.added, 'utf8')).toBe('runtime instructions');
  expect((await readCheckpoint(f.request.journalRoot))?.state).toBe('undone');
});

test('I4 endpoint intent survives a kill after publication but before any observation', async () => {
  const f = await fixture(), endpoint = f.parts.stagePaneEndpoint!;
  const next = '{"version":1,"packageRoot":"/home/fixture","endpoint":{"protocol":1}}\n';
  f.parts.paneEndpointPlan = async () => ({ paths: [f.paths.registry], changed: true, files: [{ path: f.paths.registry, bytes: Buffer.from(next), expected: (await snapshot(f.paths.registry)).hash }] });
  f.parts.stagePaneEndpoint = async request => {
    await endpoint(request);
    const fail = async () => { throw new Error('kill before observation'); };
    vi.mocked(fs.rename).mockImplementation(fail); vi.mocked(fs.link).mockImplementation(fail);
    throw new Error('kill before observation');
  };
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('kill before observation');
  vi.mocked(fs.rename).mockImplementation(real.rename); vi.mocked(fs.link).mockImplementation(real.link);
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await values([f.paths.main, f.paths.registry])).toEqual(f.before.filter(file => [f.paths.registry, f.paths.main].includes(file.path)));
});


test.each([
  ['{"content":[{"size":100}],"generation":1}', '{"content":[{"size":200},{"size":300}],"generation":2}', '{"content":[{"size":201},{"user":400},{"size":300}],"generation":2}'],
  ['{"content":[{"mod":"native-a"},{"mod":"native-b"}],"generation":1}', '{"content":[{"mod":"spider-a"},{"mod":"spider-b"}],"generation":2}', '{"content":[{"mod":"spider-b","size":300},{"mod":"spider-a","size":200}],"generation":2}'],
])('N3 ambiguous layout arrays have a lossless move-aside recovery: %s', async (before, after, edited) => {
  const f = await fixture(), stage = f.parts.stageLook;
  await put(f.paths.layout, before);
  const journal = await readJournal(f.request.journalRoot); journal.entries.find(entry => entry.path === f.paths.layout)!.after = (await snapshot(f.paths.layout)).hash!; await saveJournal(f.request.journalRoot, journal);
  f.parts.stageLook = async (...args) => (await stage(...args)).map(file => file.path === f.paths.layout ? { ...file, bytes: Buffer.from(after) } : file);
  await setupHerdr(f.request, f.parts);
  await put(f.paths.layout, edited);
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toMatchObject({ code: 'upgrade-layout-ambiguous' });
  await fs.rename(f.paths.layout, f.paths.layout + '.kept');
  await undoHerdrUpgrade({ ...f.request, replaceChanged: true }, f.parts);
  expect(await fs.readFile(f.paths.layout + '.kept', 'utf8')).toBe(edited);
  expect(await fs.readFile(f.paths.layout, 'utf8')).toBe(before);
});

test('N5 the next setup collects private blob temporaries left by a crash', async () => {
  const f = await fixture(), backup = join(f.request.journalRoot, 'backups');
  const abandoned = join(backup, 'checkpoint-' + 'a'.repeat(64) + '.spider-00000000-0000-4000-8000-000000000000');
  await put(abandoned, 'interrupted secret copy');
  await setupHerdr(f.request, f.parts);
  expect((await snapshot(abandoned)).hash).toBeNull();
});


test('N2 a failed batch retry preserves layout edits made between attempts', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const install = f.parts.installFiles;
  f.parts.installFiles = async (...args) => (await install(...args)).map(file => file.path === f.paths.main ? { ...file, bytes: Buffer.from('third-main') } : file);
  let killed = false;
  const publish = (operation: typeof real.rename) => async (from: Parameters<typeof real.rename>[0], to: Parameters<typeof real.rename>[1]) => {
    if (killed) throw new Error('batch killed');
    await operation(from, to);
    if (to === f.paths.main) { killed = true; throw new Error('batch killed'); }
  };
  vi.mocked(fs.rename).mockImplementation(publish(real.rename)); vi.mocked(fs.link).mockImplementation(publish(real.link));
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('batch killed');
  vi.mocked(fs.rename).mockImplementation(real.rename); vi.mocked(fs.link).mockImplementation(real.link);
  await put(f.paths.layout, '{"content":[],"generation":2,"userSize":321}');
  await setupHerdr({ ...f.request, replaceChanged: true }, f.parts);
  await undoHerdrUpgrade(f.request, f.parts);
  expect(JSON.parse(await fs.readFile(f.paths.layout, 'utf8'))).toEqual({ content: [], generation: 2, userSize: 321 });
  expect(await fs.readFile(f.paths.main, 'utf8')).toBe('new-main');
});


test('N2 a failed completed-sequence join retains its baseline through a substantive retry', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const journal = await readJournal(f.request.journalRoot); journal.verified = false; await saveJournal(f.request.journalRoot, journal);
  f.fail(true); await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('injected cutover interruption'); f.fail(false);
  const interrupted = await readCheckpoint(f.request.journalRoot);
  expect(interrupted?.state).toBe('complete');
  expect(interrupted?.runs.at(-1)?.outcome).toBe('failed');
  const install = f.parts.installFiles;
  f.parts.installFiles = async (...args) => (await install(...args)).map(file => file.path === f.paths.main ? { ...file, bytes: Buffer.from('third-main') } : file);
  await setupHerdr({ ...f.request, replaceChanged: true }, f.parts);
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.readFile(f.paths.main, 'utf8')).toBe('old-main');
  expect(await fs.readFile(f.paths.layout, 'utf8')).toBe('{"content":[],"generation":1}\n');
  await rollbackHerdr(f.request, f.parts);
  expect((await snapshot(f.paths.registry)).hash).toBeNull();
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
});


test('N2 a no-op retry closes an interrupted completed-sequence join before another upgrade', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts); await metadataRepeat(f);
  const path = join(f.request.journalRoot, 'checkpoint.json'), checkpoint = JSON.parse(await fs.readFile(path, 'utf8'));
  checkpoint.runs.at(-1).after = null; checkpoint.runs.at(-1).outcome = 'running'; await put(path, JSON.stringify(checkpoint));
  await setupHerdr(f.request, f.parts);
  expect((await readCheckpoint(f.request.journalRoot))?.runs.at(-1)?.outcome).toBe('complete');
  const install = f.parts.installFiles;
  f.parts.installFiles = async (...args) => (await install(...args)).map(file => file.path === f.paths.main ? { ...file, bytes: Buffer.from('third-main') } : file);
  await setupHerdr(f.request, f.parts); await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.readFile(f.paths.main, 'utf8')).toBe('new-main');
});


test.each(['layout', 'settings', 'keys', 'main'] as const)('N4 an interrupted undo safely reconciles a later %s edit', async kind => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  vi.mocked(fs.rename).mockImplementation(async (from, to) => { if (to === f.paths.main) throw new Error('restore paused'); return real.rename(from, to); });
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toThrow('restore paused');
  vi.mocked(fs.rename).mockImplementation(real.rename);
  const path = f.paths[kind], current = await snapshot(path);
  if (kind === 'main') await put(path, 'changed during undo', current.mode);
  else {
    const value = JSON.parse(current.bytes!.toString());
    if (kind === 'keys') value.global['ctrl-z'] = 'user.action';
    else value.user = 'kept';
    await put(path, JSON.stringify(value), current.mode);
  }
  if (kind === 'main') {
    await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toMatchObject({ code: 'upgrade-checkpoint-changed' });
    await undoHerdrUpgrade({ ...f.request, replaceChanged: true }, f.parts);
  } else await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.readFile(f.paths.main, 'utf8')).toBe('old-main');
  if (kind === 'keys') expect(JSON.parse(await fs.readFile(path, 'utf8')).global).toEqual({ 'ctrl-z': 'user.action' });
  else if (kind !== 'main') expect(JSON.parse(await fs.readFile(path, 'utf8')).user).toBe('kept');
});


test('I4 a selected app preference intent survives a kill before cutover observation', async () => {
  const f = await fixture(), stage = f.parts.stageLook;
  await put(f.paths.appSettings, '{"layout":"legacy","theme":"legacy","zoom":1}', 0o644);
  f.parts.stageLook = async (...args) => [...await stage(...args), { path: f.paths.appSettings, bytes: (await snapshot(f.paths.appSettings)).bytes!, expected: (await snapshot(f.paths.appSettings)).hash, snapshotOnly: true, managed: { kind: 'json', fields: ['layout', 'theme'] } }];
  f.parts.cutover = async () => {
    await put(f.paths.appSettings, '{"layout":"spider-glass","theme":"spider-glass","zoom":2}', 0o644);
    const fail = async () => { throw new Error('kill before cutover observation'); };
    vi.mocked(fs.rename).mockImplementation(fail); vi.mocked(fs.link).mockImplementation(fail);
    throw new Error('kill before cutover observation');
  };
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('kill before cutover observation');
  vi.mocked(fs.rename).mockImplementation(real.rename); vi.mocked(fs.link).mockImplementation(real.link);
  await undoHerdrUpgrade(f.request, f.parts);
  expect(JSON.parse(await fs.readFile(f.paths.appSettings, 'utf8'))).toEqual({ layout: 'legacy', theme: 'legacy', zoom: 2 });
});


test('N3 an unrelated layout label is not a mod reference', async () => {
  const f = await fixture(), directory = dirname(f.paths.main);
  await fs.rm(directory, { recursive: true });
  const journal = await readJournal(f.request.journalRoot); journal.entries = journal.entries.filter(entry => !entry.path.startsWith(directory + '/')); await saveJournal(f.request.journalRoot, journal);
  await setupHerdr(f.request, f.parts);
  await put(f.paths.layout, '{"content":[],"generation":2,"label":"spider-example"}');
  await undoHerdrUpgrade(f.request, f.parts);
  expect(JSON.parse(await fs.readFile(f.paths.layout, 'utf8'))).toEqual({ content: [], generation: 1, label: 'spider-example' });
  expect((await snapshot(f.paths.main)).hash).toBeNull();
});


test('N3 an array added by setup retains custom nodes outside its entries', async () => {
  const f = await fixture(), stage = f.parts.stageLook;
  await put(f.paths.layout, '{"generation":1}');
  const journal = await readJournal(f.request.journalRoot); journal.entries.find(entry => entry.path === f.paths.layout)!.after = (await snapshot(f.paths.layout)).hash!; await saveJournal(f.request.journalRoot, journal);
  f.parts.stageLook = async (...args) => (await stage(...args)).map(file => file.path === f.paths.layout ? { ...file, bytes: Buffer.from('{"generation":2,"content":[{"id":"owned","mod":"spider-toast"}]}') } : file);
  await setupHerdr(f.request, f.parts);
  await put(f.paths.layout, '{"generation":2,"content":[{"id":"owned","mod":"spider-toast"},{"id":"custom","size":321}]}');
  await undoHerdrUpgrade(f.request, f.parts);
  expect(JSON.parse(await fs.readFile(f.paths.layout, 'utf8'))).toEqual({ generation: 1, content: [{ id: 'custom', size: 321 }] });
});


test('N3 a late layout reference refusal remains recoverable by moving the layout aside', async () => {
  const f = await fixture(), directory = dirname(f.paths.main);
  await fs.rm(directory, { recursive: true });
  const journal = await readJournal(f.request.journalRoot); journal.entries = journal.entries.filter(entry => !entry.path.startsWith(directory + '/')); await saveJournal(f.request.journalRoot, journal);
  await setupHerdr(f.request, f.parts);
  const pause = (operation: typeof real.rename) => async (from: Parameters<typeof real.rename>[0], to: Parameters<typeof real.rename>[1]) => { if (to === f.paths.layout) throw new Error('paused layout restore'); await operation(from, to); };
  vi.mocked(fs.rename).mockImplementation(pause(real.rename)); vi.mocked(fs.link).mockImplementation(pause(real.link));
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toThrow('paused layout restore');
  vi.mocked(fs.rename).mockImplementation(real.rename); vi.mocked(fs.link).mockImplementation(real.link);
  const edited = '{"content":[],"generation":2,"toast":"spider-example","userSize":321}';
  await put(f.paths.layout, edited);
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toMatchObject({ code: 'upgrade-layout-reference' });
  await fs.rename(f.paths.layout, f.paths.layout + '.kept');
  await undoHerdrUpgrade({ ...f.request, replaceChanged: true }, f.parts);
  expect(await fs.readFile(f.paths.layout + '.kept', 'utf8')).toBe(edited);
  expect(await fs.readFile(f.paths.layout, 'utf8')).toBe(Buffer.from(f.before.find(file => file.path === f.paths.layout)!.bytes!, 'base64').toString());
  expect((await snapshot(f.paths.main)).hash).toBeNull();
  expect((await readCheckpoint(f.request.journalRoot))?.state).toBe('undone');
});


test('N5 collection repairs permissions of a retained baseline blob', async () => {
  const f = await fixture(), original = await fs.readFile(f.paths.main);
  await setupHerdr(f.request, f.parts);
  const blob = join(f.request.journalRoot, 'backups', 'checkpoint-' + digest(original));
  await fs.chmod(blob, 0o644);
  await metadataRepeat(f);
  expect((await fs.stat(blob)).mode & 0o777).toBe(0o600);
  expect(await fs.readFile(blob)).toEqual(original);
});


test('a role-template-only repeat joins the completed upgrade after pi rewrites it', async () => {
  const f = await fixture();
  await setupHerdr(f.request, f.parts);
  const sequence = (await readCheckpoint(f.request.journalRoot))!.runs[0]!.before;
  const generate = f.parts.generateTemplates;
  f.parts.generateTemplates = async (...args) => (await generate(...args)).map(file => file.path === f.paths.roleTemplate ? { ...file, bytes: Buffer.from('resolved role template') } : file);
  await put(f.paths.roleTemplate, 'pi role template');
  const journal = await readJournal(f.request.journalRoot);
  journal.entries.find(entry => entry.path === f.paths.roleTemplate)!.after = digest(Buffer.from('pi role template'));
  await saveJournal(f.request.journalRoot, journal);
  await setupHerdr(f.request, f.parts);
  expect((await readCheckpoint(f.request.journalRoot))!.runs[0]!.before).toEqual(sequence);
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.readFile(f.paths.main, 'utf8')).toBe('old-main');
  expect(await values(f.all)).toEqual(f.undoExpected);
});

test('undo accepts a pi role-template rewrite without replacement', async () => {
  const f = await fixture();
  await setupHerdr(f.request, f.parts);
  await put(f.paths.roleTemplate, 'pi role template');
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.readFile(f.paths.roleTemplate, 'utf8')).toBe('pi role template');
  expect(await fs.readFile(f.paths.main, 'utf8')).toBe('old-main');
});
