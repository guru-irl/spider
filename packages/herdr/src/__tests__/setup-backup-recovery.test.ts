// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { HERDR_LABELS, HERDR_KINDS, type MachineName, panelIpcArgv, type IpcDescriptor, type SessionIpcRequest } from '../contracts.js';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { parseHerdrConfig } from '../config.js';
import { setupHerdr, rollbackHerdr, type SetupParts, type SetupRequest, type InstallFile, type CutoverResult } from '../setup/installer.js';
import { DOCTOR_ITEMS, doctorHerdr, type DoctorParts, type DoctorFailure } from '../setup/doctor.js';
import { runHerdrCli, type HerdrCliPorts } from '../setup/cli.js';
import { readJournal, withSetupLock } from '../setup/backup.js';
import { createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { writePrivateJson } from '../sessions/registry.js';
import { forgetCutoverTabs, readCutoverRecovery, recordSessionMove, type LayoutSnapshot } from '../spaces/setup.js';
import { fixture, hash, realFs, registerSetupCleanup } from './setup-fixture.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, chmod: vi.fn(actual.chmod), readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename), link: vi.fn(actual.link), open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});
registerSetupCleanup();

const publicationCases = Array.from({ length: 16 }, (_, index) => ['before', 'after'].map(timing => [timing, index] as const)).flat();

test.each(publicationCases)('verified backup recovery resumes %s installed file publication %i', async (timing, index) => {
  const f = await fixture();
  let writes = 0;
  let crashed = false;
  const publish = (operation: typeof realFs.rename) => async (from: Parameters<typeof realFs.rename>[0], to: Parameters<typeof realFs.rename>[1]) => {
    const target = String(to);
    const isInstalled = !target.startsWith(f.request.journalRoot + '/') && target.startsWith(f.h.root + '/');
    const fail = isInstalled && writes++ === index && !crashed;
    if (fail && timing === 'before') {
      crashed = true;
      throw new Error('crash before publication');
    }
    await operation(from, to);
    if (fail && timing === 'after') {
      crashed = true;
      throw new Error('crash after publication');
    }
  };
  vi.mocked(fs.rename).mockImplementation(publish(realFs.rename));
  vi.mocked(fs.link).mockImplementation(publish(realFs.link));
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow(`crash ${timing} publication`);
  vi.mocked(fs.rename).mockImplementation(realFs.rename);
  vi.mocked(fs.link).mockImplementation(realFs.link);
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(f.settings, 'utf8'))).toEqual({ theme: 'dracula-plus-glass', unrelated: 'keep' });
  const journal = await readJournal(f.request.journalRoot);
  const saved = journal.entries.find(e => e.path === f.settings)!;
  expect(await readFile(saved.backup!, 'utf8')).toBe('{"theme":"stock","unrelated":"keep"}\n');
  expect(f.cutovers()).toBe(1);
  expect(f.launches).toHaveLength(1);
  await f.h.close();
  expect(await f.h.remainingOwnedResources()).toEqual([]);
}, 30000);

test('B layout close ownership survives restart and preserves a later user close binding', async () => {
  const f = await fixture(), path = join(f.request.config.app.home, 'keys.json');
  const baseline = { global: { 'cmd-t': 'tab.new', 'cmd-d': 'pane.split:right', 'cmd-shift-d': 'pane.split:down', 'cmd-shift-w': 'pane.close' }, terminal: { 'ctrl-v': 'terminal.paste_image' } };
  await writeFile(path, JSON.stringify(baseline)); const keys = JSON.parse(await readFile(new URL('../../assets/keys.json', import.meta.url), 'utf8')), install = f.parts.installFiles;
  f.parts.installFiles = async (request, context) => [...await install(request, context), { path, expected: hash(await readFile(path)), bytes: Buffer.alloc(0), keys }];
  await setupHerdr(f.request, f.parts); const installed = JSON.parse(await readFile(path, 'utf8'));
  expect(installed['layout:spider-glass']['cmd-shift-w']).toBe('spider-pane.close'); installed['layout:spider-glass']['cmd-shift-w'] = 'my.close'; await writeFile(path, JSON.stringify(installed));
  await readJournal(f.request.journalRoot); await rollbackHerdr(f.request, f.parts);
  const restored = JSON.parse(await readFile(path, 'utf8')); expect(restored.global).toEqual(baseline.global); expect(restored.terminal).toEqual(baseline.terminal); expect(restored['layout:spider-glass']).toEqual({ 'cmd-shift-w': 'my.close' });
});

test('rollback preserves an unproved remote owner after the display disappears', async () => {
  const f = await fixture(), journalRoot = join(f.request.config.globalRoot, 'herdr', 'spaces');
  const file = join(f.h.root, 'session.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session', id: 'session-1', cwd: f.h.root }) + '\n');
  const target = { file, cwd: f.h.root, sessionId: 'session-1', name: 'Session', spaceName: 'Space', spaceOrder: 0, sessionOrder: 0, extensionArguments: [] };
  const result = { pid: 2147483000, startIdentity: 'old-start', sessionId: 'session-1', sessionFile: file, cwd: f.h.root, presentationTerminal: 'proxy-1' };
  const path = join(journalRoot, 'spaces.json');
  await writePrivateJson(path, { version: 1, focused: true, spaces: [{ name: 'Space', id: 'space-1', adopted: false }], tabs: [{ target, placement: { space: 'space-1', tab: 'tab-1', terminal: 'core-remote/t7' }, result, failure: null }] });
  const before = await readFile(path, 'utf8');
  const production = createProductionHerdrCliPorts(f.h.root, f.h.localEnv);
  try {
    const parts = await production.setupParts(f.request);
    await expect(parts.rollback({ terminals: ['core-remote/t7' as never], identities: { 'session-1': 'old-start' } })).rejects.toMatchObject({ code: 'cutover-owner-live' });
    expect(await readFile(path, 'utf8')).toBe(before);
    expect((await readCutoverRecovery(journalRoot)).entries[0]).toMatchObject({ placement: { terminal: 'core-remote/t7' }, result: { presentationTerminal: 'proxy-1' } });
  } finally { await production.dispose(); }
});

test('setup recovery preserves a moved remote presentation and its real owner', async () => {
  const f = await fixture(), journalRoot = join(f.request.config.globalRoot, 'herdr', 'spaces');
  const file = join(f.h.root, 'session.jsonl');
  const target = { file, cwd: f.h.root, sessionId: 'session-1', name: 'Session', spaceName: 'Space', spaceOrder: 0, sessionOrder: 0, extensionArguments: [] };
  const result = { pid: 101, startIdentity: 'start-101', sessionId: 'session-1', sessionFile: file, cwd: f.h.root, presentationTerminal: 'proxy-1' };
  await writePrivateJson(join(journalRoot, 'spaces.json'), { version: 1, focused: true, spaces: [{ name: 'Space', id: 'space-1', adopted: false }], tabs: [{ target, placement: { space: 'space-1', tab: 'tab-1', terminal: 'core-remote/t7' }, result, failure: null }] });
  const snapshot = { spaces: [{ id: 'other-space', name: 'Other', tabs: [{ id: 'other-tab', name: 'User tab', terminal: 'proxy-1', ownerSessionId: 'session-1' }] }] } as LayoutSnapshot;
  expect(await recordSessionMove(journalRoot, { sessionId: 'session-1', terminal: 'core-remote/t7' as never }, snapshot)).toBe(true);
  const recovered = await readCutoverRecovery(journalRoot);
  expect(recovered.entries[0]).toMatchObject({ placement: { space: 'other-space', tab: 'other-tab', terminal: 'core-remote/t7' }, result: { presentationTerminal: 'proxy-1' }, manuallyMoved: true });
  await expect(forgetCutoverTabs(journalRoot, recovered.createdTabs, snapshot)).rejects.toMatchObject({ code: 'cutover-tab-still-exists' });
  const bytes = await readFile(join(journalRoot, 'spaces.json'), 'utf8');
  expect(await recordSessionMove(journalRoot, { sessionId: 'session-1', terminal: 'core-remote/t7' as never }, snapshot)).toBe(true);
  expect(await readFile(join(journalRoot, 'spaces.json'), 'utf8')).toBe(bytes);
  expect((await readCutoverRecovery(journalRoot)).entries[0].placement.terminal).toBe('core-remote/t7');
});


const bookkeepingCases = ['checkpoint', 'journal', 'blob'].flatMap(kind => ['before', 'after'].map(timing => [kind, timing] as const));
test.each(bookkeepingCases)('setup resumes after %s publication fails %s its persisted boundary', async (kind, timing) => {
  const f = await fixture();
  let crashed = false;
  const publish = (operation: typeof realFs.rename) => async (from: Parameters<typeof realFs.rename>[0], to: Parameters<typeof realFs.rename>[1]) => {
    const path = String(to), name = path.slice(f.request.journalRoot.length + 1);
    const selected = path.startsWith(f.request.journalRoot + '/') && (kind === 'checkpoint' ? name === 'checkpoint.json' : kind === 'journal' ? name === 'journal.json' : name.startsWith('backups/checkpoint-'));
    if (crashed) throw new Error('persisted boundary crash');
    if (selected && timing === 'before') { crashed = true; throw new Error('persisted boundary crash'); }
    await operation(from, to);
    if (selected) { crashed = true; throw new Error('persisted boundary crash'); }
  };
  vi.mocked(fs.rename).mockImplementation(publish(realFs.rename)); vi.mocked(fs.link).mockImplementation(publish(realFs.link));
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('persisted boundary crash');
  expect(crashed).toBe(true);
  vi.mocked(fs.rename).mockImplementation(realFs.rename); vi.mocked(fs.link).mockImplementation(realFs.link);
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(f.settings, 'utf8'))).toEqual({ theme: 'dracula-plus-glass', unrelated: 'keep' });
  expect((await readJournal(f.request.journalRoot)).verified).toBe(true);
  expect(f.cutovers()).toBe(1);
  const checkpoint = JSON.parse(await readFile(join(f.request.journalRoot, 'checkpoint.json'), 'utf8'));
  const references = new Set(checkpoint.runs.flatMap((run: { before: { hash: string }[]; after: { hash: string }[]; written: { hash: string }[]; planned: { hash: string }[] }) => [...run.before, ...run.after, ...run.written, ...run.planned].map(file => file.hash)));
  expect((await fs.readdir(join(f.request.journalRoot, 'backups'))).filter(name => name.startsWith('checkpoint-')).every(name => references.has(name.slice('checkpoint-'.length)))).toBe(true);
});
