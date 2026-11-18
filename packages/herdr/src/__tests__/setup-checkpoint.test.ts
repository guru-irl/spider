// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import * as fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { HerdrError } from '../client/parse.js';
import { parseHerdrConfig } from '../config.js';
import { applyFiles, digest, mergeTerminalKeys, prepareBackups, readJournal, saveJournal, snapshot } from '../setup/backup.js';
import * as installer from '../setup/installer.js';
import { undoHerdrUpgrade, rollbackHerdr, setupHerdr, type InstallFile, type SetupParts, type SetupRequest } from '../setup/installer.js';
import { runHerdrCli } from '../setup/cli.js';
import { doctorHerdr } from '../setup/doctor.js';
import { beginRunCheckpoint, recordCheckpointWrites, readCheckpoint, finishRunCheckpoint } from '../setup/checkpoint.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});
const real = await vi.importActual<typeof fs>('node:fs/promises');
import { roots, oldKeys, installedLayout, nativeLayout, put, values, fixture, metadataRepeat } from './setup-checkpoint-fixture.js';
afterEach(async () => { vi.mocked(fs.rename).mockImplementation(real.rename); vi.mocked(fs.unlink).mockImplementation(real.unlink); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

test('undo restores the first failed-attempt checkpoint after a successful retry, including legacy files and registry', async () => {
  const f = await fixture(); f.fail(true);
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('injected cutover interruption');
  expect(await fs.readFile(f.paths.layout, 'utf8')).toBe(nativeLayout);
  f.fail(false); await setupHerdr({ ...f.request, replaceChanged: true }, f.parts);
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await values(f.all)).toEqual(f.undoExpected);
});

test('undo restores upgrade bytes and modes while retaining owner-updated runtime state', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts); await undoHerdrUpgrade(f.request, f.parts);
  expect(await values(f.all)).toEqual(f.undoExpected);
});

test('undo refuses a later user edit before touching any path unless replacement is explicit', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts); await put(f.paths.main, 'user edit', 0o664);
  const edited = await values(f.all);
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toMatchObject({ code: 'upgrade-checkpoint-changed' });
  expect(await values(f.all)).toEqual(edited);
  await undoHerdrUpgrade({ ...f.request, replaceChanged: true }, f.parts);
  expect(await values(f.all)).toEqual(f.undoExpected);
});

test('a retry does not claim user edits to a file it leaves unchanged', async () => {
  const f = await fixture(); f.fail(true);
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('injected cutover interruption');
  await put(f.paths.settings, '{ "theme": "dracula-plus-glass", "keep": "user edit between attempts" }\n', 0o640);
  f.fail(false); await setupHerdr({ ...f.request, replaceChanged: true }, f.parts);
  const edited = await values(f.all);
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toMatchObject({ code: 'upgrade-checkpoint-changed' });
  expect(await values(f.all)).toEqual(edited);
});

test('full rollback removes historically installed files and the endpoint registry', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts); await rollbackHerdr(f.request, f.parts);
  expect((await snapshot(f.paths.font)).bytes).toBeNull();
  expect((await snapshot(f.paths.theme)).bytes).toBeNull();
  expect(JSON.parse(await fs.readFile(f.paths.keys, 'utf8')).terminal).toEqual({ 'ctrl-v': 'terminal.paste_image' });
  expect((await snapshot(f.paths.registry)).bytes).toBeNull();
});

test('full rollback retains a changed registry and reports incomplete restoration until repaired', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const installed = await fs.readFile(f.paths.registry), output: string[] = [];
  await put(f.paths.registry, '{"user":"changed registry"}\n');
  const ports = { request: async () => f.request, setupParts: async () => f.parts, doctorParts: async () => { throw new Error('unused'); }, stdout: (text: string) => output.push(text), stderr: (text: string) => output.push(text) };
  expect(await runHerdrCli(['rollback'], ports)).toBe(3);
  expect(await fs.readFile(f.paths.registry, 'utf8')).toBe('{"user":"changed registry"}\n');
  expect((await readJournal(f.request.journalRoot)).entries.map(entry => entry.path)).toEqual([f.paths.registry]);
  await fs.writeFile(f.paths.registry, installed);
  expect(await runHerdrCli(['rollback'], ports)).toBe(0);
  expect((await snapshot(f.paths.registry)).bytes).toBeNull();
});

test('a failed attempt is undoable before any successful retry', async () => {
  const f = await fixture(); f.fail(true); await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('injected cutover interruption');
  const runtime = (await values([f.paths.spaces]))[0]!;
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await values(f.all)).toEqual(f.undoExpected.map(file => file.path === f.paths.spaces ? runtime : file));
});

test('an interrupted undo resumes without replacing a later user edit silently', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  vi.mocked(fs.rename).mockImplementation(async (from, to) => { if (to === f.paths.layout) throw new Error('interrupted undo'); return real.rename(from, to); });
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toThrow('interrupted undo');
  vi.mocked(fs.rename).mockImplementation(real.rename);
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await values(f.all)).toEqual(f.undoExpected);
});

test('setup reports journal changes and an unchanged repeat does not rewrite it', async () => {
  const f = await fixture(), output: string[] = [];
  const ports = { request: async () => f.request, setupParts: async () => f.parts, doctorParts: async () => { throw new Error('unused'); }, stdout: (text: string) => output.push(text), stderr: (text: string) => output.push(text) };
  expect(await runHerdrCli(['setup'], ports)).toBe(0);
  expect(output.join('')).toMatch(/setup journal updated/i);
  const before = await fs.stat(f.paths.journal), bytes = await fs.readFile(f.paths.journal);
  const repeat = await setupHerdr(f.request, f.parts);
  expect(repeat.writes).toEqual([]);
  expect(await fs.readFile(f.paths.journal)).toEqual(bytes);
  expect((await fs.stat(f.paths.journal)).ino).toBe(before.ino);
});

test('undo refuses a setup-journal edit racing the file restoration phase', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    await real.rename(from, to);
    if (to === f.paths.main) await real.writeFile(f.paths.journal, '{"user":"changed during undo"}\n');
  });
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toMatchObject({ code: 'upgrade-checkpoint-changed' });
  expect(await real.readFile(f.paths.journal, 'utf8')).toBe('{"user":"changed during undo"}\n');
});

test('an endpoint-only upgrade is checkpointed before its first registry write', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const before = await values(f.all), next = '{"version":1,"packageRoot":"/home/fixture","endpoint":{"protocol":1,"generation":3}}\n';
  f.parts.paneEndpointPlan = async () => ({ paths: [f.paths.registry], changed: (await fs.readFile(f.paths.registry, 'utf8')) !== next });
  f.parts.stagePaneEndpoint = async () => { await put(f.paths.registry, next); return [f.paths.registry]; };
  await setupHerdr(f.request, f.parts);
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await values(f.all)).toEqual(before);
});

test('undo returns and prints remote files from every recorded run without contacting the machine', async () => {
  const f = await fixture(), machine = 'box-1.invalid' as import('../contracts.js').MachineName, path = '/home/fixture/runtime-v2.mjs';
  const remote = { bytes: null as Buffer | null };
  f.parts.ensureRuntime = async () => [{ machine, path, bytes: Buffer.from('runtime-v2'), sha256: digest(Buffer.from('runtime-v2')) }];
  f.parts.hc = {
    fileRead: async () => { if (remote.bytes === null) throw new HerdrError('file-not-found', 'absent'); return remote.bytes; },
    fileWrite: async (_machine, _path, bytes) => { remote.bytes = bytes; },
  };
  f.fail(true); await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('injected cutover interruption');
  f.fail(false); await setupHerdr({ ...f.request, replaceChanged: true }, f.parts);
  f.parts.hc = { fileRead: async () => { throw new Error('undo contacted machine'); }, fileWrite: async () => { throw new Error('undo contacted machine'); } };
  const result = await installer.undoHerdrUpgrade?.(f.request, f.parts);
  expect(result?.remoteNotRestored).toEqual([{ machine: 'box-1.invalid', path: '/home/fixture/runtime-v2.mjs' }]);
  expect(remote.bytes?.toString()).toBe('runtime-v2');
  expect(await values(f.all)).toEqual(f.undoExpected);

  const g = await fixture(), output: string[] = [];
  let uploaded = false;
  g.parts.ensureRuntime = async () => [{ machine, path, bytes: Buffer.from('runtime-v2'), sha256: digest(Buffer.from('runtime-v2')) }];
  g.parts.hc = { fileRead: async () => { if (!uploaded) throw new HerdrError('file-not-found', 'absent'); return Buffer.from('runtime-v2'); }, fileWrite: async () => { uploaded = true; } };
  await setupHerdr(g.request, g.parts);
  g.parts.hc = { fileRead: async () => { throw new Error('undo contacted machine'); }, fileWrite: async () => { throw new Error('undo contacted machine'); } };
  expect(await runHerdrCli(['rollback', '--undo-upgrade'], { request: async () => g.request, setupParts: async () => g.parts,
    doctorParts: async () => { throw new Error('unused'); }, stdout: text => output.push(text), stderr: text => output.push(text) })).toBe(0);
  expect(output.join('')).toContain('Remote file not restored: box-1.invalid /home/fixture/runtime-v2.mjs');
});

test('the CLI exposes undo-upgrade and retains liveness refusals even with replacement', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts); f.live(true);
  const before = await values(f.all), output: string[] = [];
  const code = await runHerdrCli(['rollback', '--undo-upgrade', '--replace-changed'], { request: async () => f.request, setupParts: async () => f.parts,
    doctorParts: async () => { throw new Error('unused'); }, stdout: text => output.push(text), stderr: text => output.push(text) });
  expect(code).toBe(1);
  expect(output.join('')).toContain('cutover-owner-live');
  expect(await values(f.all)).toEqual(before);
});



test('a metadata-only repeat retains the completed upgrade baseline', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  await metadataRepeat(f);
  expect((await readCheckpoint(f.request.journalRoot))?.state).toBe('complete');
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await values([f.paths.main, f.paths.registry])).toEqual(f.before.filter(file => [f.paths.main, f.paths.registry].includes(file.path)));
});

test('a bookkeeping-only sequence refuses undo rather than claiming success', async () => {
  const f = await fixture(), checkpoint = await beginRunCheckpoint(f.request.journalRoot, [f.paths.journal]);
  await fs.appendFile(f.paths.journal, '\n');
  await recordCheckpointWrites(f.request.journalRoot, checkpoint, [f.paths.journal]);
  await finishRunCheckpoint(f.request.journalRoot, checkpoint, true);
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toMatchObject({ code: 'upgrade-checkpoint-bookkeeping-only' });
});

test('a metadata-only repeat without an upgrade checkpoint does not create one', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  await fs.unlink(join(f.request.journalRoot, 'checkpoint.json'));
  await metadataRepeat(f);
  expect(await readCheckpoint(f.request.journalRoot)).toBeNull();
});

test.each([false, true])('undo preserves later shared-file edits with replacement=%s', async replaceChanged => {
  const f = await fixture();
  const shell = f.request.config.shellRc;
  await put(shell, 'alias old=true\n');
  f.parts.installResume = async () => [{ path: shell, expected: (await snapshot(shell)).hash, bytes: Buffer.from('alias old=true\n# spider:resume:start\nnew hook\n# spider:resume:end\n'), managed: { kind: 'resume' } }];
  await setupHerdr(f.request, f.parts);
  await fs.appendFile(shell, 'alias later=true\n');
  await put(f.paths.settings, '{"theme":"dracula-plus-glass","keep":"later"}\n');
  const keys = JSON.parse(await fs.readFile(f.paths.keys, 'utf8')); keys.global['ctrl-z'] = 'user.action';
  await put(f.paths.keys, JSON.stringify(keys));
  await undoHerdrUpgrade({ ...f.request, replaceChanged }, f.parts);
  expect(await fs.readFile(shell, 'utf8')).toBe('alias old=true\nalias later=true\n');
  expect(JSON.parse(await fs.readFile(f.paths.settings, 'utf8'))).toEqual({ theme: 'dracula-plus-glass', keep: 'later' });
  expect(JSON.parse(await fs.readFile(f.paths.keys, 'utf8')).global).toEqual({ 'ctrl-z': 'user.action' });
});

test('the upgrade runbook preserves runtime moves and pre-existing tabs without replacement', async () => {
  const f = await fixture();
  const old = 'terminal-old' as import('../contracts.js').TerminalAddress, fresh = 'terminal-new' as import('../contracts.js').TerminalAddress;
  const journal = await readJournal(f.request.journalRoot); journal.cutover = { terminals: [old], identities: { old: 'owner-1' } }; await saveJournal(f.request.journalRoot, journal);
  const open = new Set([old]);
  f.parts.cutover = async () => { open.add(fresh); await put(f.paths.spaces, '{"placements":["new"]}\n'); return { terminals: [old, fresh], identities: { old: 'owner-1', new: 'owner-2' } }; };
  f.parts.rollback = async (result, ...args: unknown[]) => {
    const preserve = (args[0] as { preserve?: { terminals: readonly string[] } } | undefined)?.preserve;
    for (const address of result.terminals) if (!preserve?.terminals.includes(address)) open.delete(address);
  };
  await setupHerdr({ ...f.request, replaceChanged: true }, f.parts);
  const doctor = await doctorHerdr(f.request, {
    targets: async () => [], inspect: async () => ({ failures: [] }), launchHistory: async () => [], probeMachineNode: async () => 'v22.19.0',
  });
  expect(doctor.failures).toEqual([]);
  await metadataRepeat(f);
  await put(f.paths.spaces, '{"placements":["moved-after-upgrade"]}\n');
  await put(f.paths.settings, '{"theme":"dracula-plus-glass","keep":"runtime"}\n');
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.readFile(f.paths.main, 'utf8')).toBe('old-main');
  expect((await fs.stat(f.paths.main)).mode & 0o777).toBe(0o664);
  expect(JSON.parse(await fs.readFile(f.paths.keys, 'utf8')).global).toEqual({});
  expect(JSON.parse(await fs.readFile(f.paths.settings, 'utf8')).keep).toBe('runtime');
  expect(await fs.readFile(f.paths.spaces, 'utf8')).toBe('{"placements":["moved-after-upgrade"]}\n');
  expect([...open]).toEqual([old]);
});

test('a transient owner failure leaves undo retryable without replacement', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const rollback = f.parts.rollback;
  f.parts.rollback = async () => { throw new Error('connection lost before close'); };
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toThrow('connection lost before close');
  f.parts.rollback = rollback;
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.readFile(f.paths.main, 'utf8')).toBe('old-main');
});

test('a crashed run closes on a no-op repeat and does not merge the next upgrade', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const path = join(f.request.journalRoot, 'checkpoint.json'), checkpoint = JSON.parse(await fs.readFile(path, 'utf8'));
  checkpoint.state = 'running'; checkpoint.runs.at(-1).after = null; checkpoint.runs.at(-1).outcome = 'running';
  await put(path, JSON.stringify(checkpoint));
  await setupHerdr(f.request, f.parts);
  expect((await readCheckpoint(f.request.journalRoot))?.state).toBe('complete');
  f.parts.installFiles = async (_, context) => [{ path: f.paths.main, expected: context.installed[f.paths.main]!, bytes: Buffer.from('third-main') }];
  await setupHerdr(f.request, f.parts); await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.readFile(f.paths.main, 'utf8')).toBe('new-main');
});

test('a crashed run can be undone from its durable written states', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const path = join(f.request.journalRoot, 'checkpoint.json'), checkpoint = JSON.parse(await fs.readFile(path, 'utf8'));
  checkpoint.state = 'running'; checkpoint.runs.at(-1).after = null; checkpoint.runs.at(-1).outcome = 'running';
  await put(path, JSON.stringify(checkpoint));
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.readFile(f.paths.main, 'utf8')).toBe('old-main');
});

test('undo refuses an edit between attempts even when the retry rewrites the key map', async () => {
  const f = await fixture(); f.fail(true);
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('injected cutover interruption');
  const keys = JSON.parse(await fs.readFile(f.paths.keys, 'utf8')); keys.global['ctrl-z'] = 'user.action'; await put(f.paths.keys, JSON.stringify(keys));
  const install = f.parts.installFiles;
  f.parts.installFiles = async (request, context) => (await install(request, context)).map(file => file.path === f.paths.keys ? { ...file, keys: { ...file.keys, global: { ...file.keys?.global, 'cmd-y': 'new.action' } } } : file);
  f.fail(false); await setupHerdr({ ...f.request, replaceChanged: true }, f.parts);
  const before = await values(f.all);
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toMatchObject({ code: 'upgrade-checkpoint-changed' });
  expect(await values(f.all)).toEqual(before);
});

test('setup failure points at upgrade undo and full rollback retires the sequence', async () => {
  const f = await fixture(); f.fail(true);
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow(/rollback.*--undo-upgrade/);
  await rollbackHerdr(f.request, f.parts);
  expect((await readCheckpoint(f.request.journalRoot))?.state).toBe('superseded');
  f.fail(false);
  await setupHerdr({ ...f.request, replaceChanged: true }, f.parts);
  await undoHerdrUpgrade(f.request, f.parts);
  expect((await snapshot(f.paths.main)).bytes).toBeNull();
});

test.each(['before', 'after'] as const)('a mod publish interrupted %s its rename resumes through setup and remains undoable', async timing => {
  const f = await fixture(), directory = dirname(f.paths.main);
  await fs.rm(directory, { recursive: true });
  const journal = await readJournal(f.request.journalRoot); journal.entries = journal.entries.filter(entry => !entry.path.startsWith(directory + '/')); await saveJournal(f.request.journalRoot, journal);
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (to === directory && timing === 'before') throw new Error('publish stopped');
    await real.rename(from, to);
    if (to === directory && timing === 'after') throw new Error('publish stopped');
  });
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow(/publish stopped[\s\S]*rollback.*--undo-upgrade/);
  vi.mocked(fs.rename).mockImplementation(real.rename);
  await setupHerdr(f.request, f.parts); await undoHerdrUpgrade(f.request, f.parts);
  expect((await snapshot(f.paths.main)).bytes).toBeNull();
  expect(await fs.readdir(join(f.request.config.app.home, 'mods'))).toEqual([]);
});

test('undo unpublishes a new mod before deleting any of its files', async () => {
  const f = await fixture(), directory = dirname(f.paths.main);
  const install = f.parts.installFiles;
  f.parts.installFiles = async (request, context) => [...await install(request, context)].sort((a, b) => Number(b.path === f.paths.manifest) - Number(a.path === f.paths.manifest));
  await fs.rm(directory, { recursive: true });
  const journal = await readJournal(f.request.journalRoot); journal.entries = journal.entries.filter(entry => !entry.path.startsWith(directory + '/')); await saveJournal(f.request.journalRoot, journal);
  await setupHerdr(f.request, f.parts);
  await put(join(directory, 'jsconfig.json'), '{}'); await put(join(directory, 'types.d.ts'), 'export {};');
  const broken: string[] = [];
  vi.mocked(fs.unlink).mockImplementation(async path => {
    await real.unlink(path);
    const files = await real.readdir(directory).catch((): string[] => []);
    if (files.includes('main.js') && !files.includes('mod.json')) broken.push(String(path));
  });
  await undoHerdrUpgrade(f.request, f.parts);
  expect(broken).toEqual([]);
  expect(await fs.readdir(join(f.request.config.app.home, 'mods'))).toEqual([]);
});

test('checkpoint JSON stays bounded and contains no copied file contents', async () => {
  const f = await fixture(); await put(f.paths.font, 'F'.repeat(4_000_000));
  const checkpoint = await beginRunCheckpoint(f.request.journalRoot, [f.paths.font]);
  await recordCheckpointWrites(f.request.journalRoot, checkpoint, [f.paths.font]);
  const bytes = await fs.readFile(join(f.request.journalRoot, 'checkpoint.json'));
  expect(bytes.length).toBeLessThan(12_000);
  expect(JSON.parse(bytes.toString()).runs[0].before[0]).not.toHaveProperty('bytes');
  expect((await fs.readdir(join(f.request.journalRoot, 'backups'))).filter(name => name === 'checkpoint-' + digest(Buffer.from('F'.repeat(4_000_000))))).toHaveLength(1);
});

test('malformed checkpoints provide a named recovery error', async () => {
  const f = await fixture(); await put(join(f.request.journalRoot, 'checkpoint.json'), '{broken');
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'upgrade-checkpoint-invalid' });
});


test('undo resumes after observing a layout outside the install plan', async () => {
  const f = await fixture(), stage = f.parts.stageLook;
  f.parts.stageLook = async (request, context, mode) => (await stage(request, context, mode)).filter(file => file.path !== f.paths.layout);
  const cutover = f.parts.cutover;
  f.parts.cutover = async (request, context) => { await put(f.paths.layout, installedLayout); return cutover(request, context); };
  await setupHerdr(f.request, f.parts);
  vi.mocked(fs.rename).mockImplementation(async (from, to) => { if (to === f.paths.main) throw new Error('restore stopped'); return real.rename(from, to); });
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toThrow('restore stopped');
  vi.mocked(fs.rename).mockImplementation(real.rename);
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.readFile(f.paths.layout, 'utf8')).toBe('{"content":[],"generation":1}\n');
});


test('setup keeps its original error when checkpoint finalization also fails', async () => {
  const f = await fixture(), warnings: string[] = [];
  f.parts.warn = message => warnings.push(message);
  f.parts.cutover = async () => {
    vi.mocked(fs.rename).mockImplementation(async (from, to) => { if (to === join(f.request.journalRoot, 'checkpoint.json')) throw new Error('checkpoint storage failed'); return real.rename(from, to); });
    throw new Error('original cutover error');
  };
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('original cutover error');
  expect(warnings.join(' ')).toContain('checkpoint storage failed');
});

test('undo resumes after unpublication is interrupted after its rename', async () => {
  const f = await fixture(), directory = dirname(f.paths.main);
  await fs.rm(directory, { recursive: true });
  const journal = await readJournal(f.request.journalRoot); journal.entries = journal.entries.filter(entry => !entry.path.startsWith(directory + '/')); await saveJournal(f.request.journalRoot, journal);
  await setupHerdr(f.request, f.parts);
  vi.mocked(fs.rename).mockImplementation(async (from, to) => { await real.rename(from, to); if (from === directory) throw new Error('unpublish interrupted'); });
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toThrow('unpublish interrupted');
  vi.mocked(fs.rename).mockImplementation(real.rename);
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.readdir(join(f.request.config.app.home, 'mods'))).toEqual([]);
});

test('undo removes directories created only by the upgrade', async () => {
  const f = await fixture();
  await fs.rm(dirname(f.paths.font), { recursive: true });
  const journal = await readJournal(f.request.journalRoot); journal.entries = journal.entries.filter(entry => entry.path !== f.paths.font); await saveJournal(f.request.journalRoot, journal);
  await setupHerdr(f.request, f.parts); await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.stat(dirname(f.paths.font)).then(() => true, () => false)).toBe(false);
  expect(await fs.stat(dirname(f.paths.added)).then(() => true, () => false)).toBe(false);
});

test('undo refuses when runtime changes leave only bookkeeping to restore', async () => {
  const f = await fixture();
  await setupHerdr(f.request, f.parts);
  const stage = f.parts.stageLook;
  f.parts.stageLook = async (request, context, mode) => (await stage(request, context, mode)).map(file => file.path === f.paths.layout ? { ...file, bytes: Buffer.from('{"content":[],"generation":3}\n') } : file);
  await setupHerdr(f.request, f.parts);
  await put(f.paths.layout, '{"content":[],"generation":4,"user":true}\n');
  await expect(undoHerdrUpgrade(f.request, f.parts)).rejects.toMatchObject({ code: 'upgrade-checkpoint-bookkeeping-only' });
});


test('a killed file batch can undo completed write intents without the replacement flag', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const path = join(f.request.journalRoot, 'checkpoint.json'), checkpoint = JSON.parse(await fs.readFile(path, 'utf8'));
  checkpoint.state = 'running'; checkpoint.runs.at(-1).after = null; checkpoint.runs.at(-1).outcome = 'running';
  checkpoint.runs.at(-1).written = checkpoint.runs.at(-1).written.filter((file: { path: string }) => file.path !== f.paths.main);
  await put(path, JSON.stringify(checkpoint));
  await undoHerdrUpgrade(f.request, f.parts);
  expect(await fs.readFile(f.paths.main, 'utf8')).toBe('old-main');
});


test('full rollback removes a valid endpoint registry from an installation without a checkpoint', async () => {
  const f = await fixture();
  expect((await snapshot(f.paths.registry)).hash).not.toBeNull();
  await rollbackHerdr(f.request, f.parts);
  expect((await snapshot(f.paths.registry)).hash).toBeNull();
});


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
