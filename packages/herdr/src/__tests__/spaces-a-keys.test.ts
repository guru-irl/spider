// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr, type InstallFile } from '../setup/installer.js';
import * as backup from '../setup/backup.js';
import * as doctor from '../setup/doctor.js';
import { HerdrLabelContract } from '../contracts.js';
import { parkFocusedTerminal } from '../../assets/pane/park.js';
import type { AgentTerminal } from '../../assets/agents/children.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});

const desired = {
  global: {
    'cmd-p': 'mod.open:spider-picker',
    'cmd-n': { command: 'space.new', args: { machine: '' } },
  },
  terminal: { 'cmd-shift-a': 'send:\u001b[97;6u' },
  'layout:Spider': { 'cmd-shift-e': 'spider-pane.park' },
} as const;

test('ships picker and local new-space bindings with layout-scoped send back', async () => {
  const keys = JSON.parse(await readFile(new URL('../../assets/keys.json', import.meta.url), 'utf8'));
  expect(keys.global['cmd-p']).toBe('mod.open:spider-picker');
  expect(keys.global['cmd-n']).toEqual({ command: 'space.new', args: { machine: '' } });
  expect(keys.global['cmd-t']).toBe('mod.open:spider-machine-picker');
  expect(keys.global['cmd-d']).toBe('mod.open:spider-machine-picker-right');
  expect(keys.global['cmd-shift-d']).toBe('mod.open:spider-machine-picker-down');
  expect(keys['layout:Spider']['cmd-shift-w']).toBe('spider-pane.close');
  expect(keys['layout:Spider']['cmd-shift-e']).toBe('spider-pane.park');
  expect(keys.global['cmd-shift-e']).toBeUndefined();
  expect(Object.keys(keys.terminal)).toEqual(['cmd-shift-a', 'cmd-shift-o', 'cmd-shift-u', 'cmd-shift-m', 'cmd-shift-k']);
});

test('doctor reports conflicting pane-close and competing send-back bindings without repair', () => {
  const installed = { ...desired, global: { ...desired.global, 'cmd-shift-w': 'terminal.park', 'cmd-shift-e': 'other.action' } };
  const before = JSON.stringify(installed);
  const report = doctor.checkManagedKeyBindings(Buffer.from(before), desired);
  expect(report.failures.map(failure => failure.code)).toContain('key-binding-conflict');
  expect(report.failures.map(failure => failure.message).join(' ')).toContain('cmd-shift-w');
  expect(report.failures.map(failure => failure.message).join(' ')).toContain('cmd-shift-e');
  expect(JSON.stringify(installed)).toBe(before);
});

test('refuses an absent native key map and gives the same actionable doctor reason', () => {
  const message = 'Open Herdr once so it creates its default key map, then rerun setup.';
  expect(() => backup.mergeKeys(null, desired, {}, false)).toThrowError(expect.objectContaining({ code: 'keys-defaults-missing', message }));
  expect(doctor.checkManagedKeyBindings(null, desired).failures).toContainEqual(expect.objectContaining({ code: 'keys-defaults-missing', message }));
});

test('production refuses missing native keys before staging and doctor reports the same reason', async () => {
  const { cleanup, fixture } = await import('../../../host/src/__tests__/herdr-setup-fixture.js');
  const f = await fixture();
  const path = join(f.h.directories.app, 'keys.json'), settings = join(f.h.directories.app, 'settings.json');
  const before = await readFile(settings);
  await unlink(path);
  const stage = vi.spyOn(f.parts, 'stageLook').mockImplementation(async () => { throw new Error('Unexpected staging'); });
  const expected = { code: 'keys-defaults-missing', message: 'Open Herdr once so it creates its default key map, then rerun setup.' };
  try {
    await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject(expected);
    expect(stage).not.toHaveBeenCalled();
    expect(await readFile(settings)).toEqual(before);
    expect((await backup.readJournal(f.request.journalRoot)).entries).toEqual([]);
    expect((await (await f.ports.doctorParts(f.request)).inspect('keys', f.request)).failures).toContainEqual(expect.objectContaining(expected));
    expect(await readFile(path).then(() => true, () => false)).toBe(false);
  } finally { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); }
});

test('doctor reports a more-specific pane-close override', () => {
  const installed = { ...desired, global: { ...desired.global, 'cmd-shift-w': 'pane.close' }, terminal: { ...desired.terminal, 'cmd-shift-w': 'other.action' } };
  const report = doctor.checkManagedKeyBindings(Buffer.from(JSON.stringify(installed)), desired);
  expect(report.failures.map(failure => failure.message).join(' ')).toContain('terminal.cmd-shift-w');
});

test('migrates stock keys in separate sections without changing close or image paste', () => {
  const original = Buffer.from(JSON.stringify({
    global: { 'cmd-p': 'mod.open:picker', 'cmd-n': 'space.new', 'cmd-shift-w': 'pane.close' },
    terminal: { 'ctrl-v': 'terminal.paste_image' },
  }));
  const result = JSON.parse(backup.mergeKeys(original, desired, {}, false).toString());
  expect(result.global).toEqual({ 'cmd-p': 'mod.open:spider-picker', 'cmd-n': { command: 'space.new', args: { machine: '' } }, 'cmd-shift-w': 'pane.close' });
  expect(result.terminal).toEqual({ 'ctrl-v': 'terminal.paste_image', 'cmd-shift-a': 'send:\u001b[97;6u' });
  expect(result['layout:Spider']['cmd-shift-e']).toBe('spider-pane.park');
  expect(result.global['cmd-shift-e']).toBeUndefined();
});

test.each([
  ['cmd-p', 'other.action'],
  ['cmd-p', { command: 'mod.open', args: { name: 'other' } }],
  ['cmd-n', 'tab.new'],
  ['cmd-n', { command: 'space.new', args: { machine: 'box-1.invalid' } }],
])('refuses an unowned global %s binding', (key, value) => {
  const bytes = Buffer.from(JSON.stringify({ global: { [key]: value } }));
  expect(() => backup.mergeKeys(bytes, desired, {}, false)).toThrowError(expect.objectContaining({ code: 'key-binding-conflict' }));
});

test.each(['global', 'terminal'])('refuses a competing send-back key in %s', section => {
  const bytes = Buffer.from(JSON.stringify({ [section]: { 'cmd-shift-e': 'other.action' } }));
  expect(() => backup.mergeKeys(bytes, desired, {}, false)).toThrowError(expect.objectContaining({ code: 'key-binding-conflict' }));
  expect(() => backup.mergeKeys(bytes, desired, {}, true)).toThrowError(expect.objectContaining({ code: 'key-binding-conflict' }));
});

test('requires a changed pane-close key to be repaired without taking ownership', () => {
  const bytes = Buffer.from(JSON.stringify({ global: { 'cmd-shift-w': 'terminal.park' } }));
  expect(() => backup.mergeKeys(bytes, desired, {}, false)).toThrowError(expect.objectContaining({ code: 'key-binding-conflict' }));
  expect(() => backup.mergeKeys(bytes, desired, {}, true)).toThrowError(expect.objectContaining({ code: 'key-binding-conflict' }));
});

test.each([
  ['global', 'cmd-shift-e'],
  ['terminal', 'cmd-shift-e'],
  ['global', 'cmd-shift-w'],
  ['terminal', 'cmd-shift-w'],
  ['layout:Spider', 'cmd-shift-w'],
])('setup and dry-run refuse %s.%s even with overwrite permission', async (section, key) => {
  const { cleanup, fixture } = await import('../../../host/src/__tests__/herdr-setup-fixture.js');
  const f = await fixture(), path = join(f.h.directories.app, 'keys.json');
  try {
    const keys = JSON.parse(await readFile(path, 'utf8'));
    keys[section] ??= {};
    keys[section][key] = 'foreign.action';
    const original = JSON.stringify(keys);
    await writeFile(path, original);
    const request = { ...f.request, overwriteUnownedKeys: true, replaceChanged: true };
    const plan = await setupHerdr({ ...request, dryRun: true }, f.parts);
    const refusal = plan.plan!.files.find(file => file.path === path)?.refusal;
    expect(refusal).toMatchObject({ code: 'key-binding-conflict' });
    expect(refusal?.message).toContain(path);
    expect(refusal?.message).toContain(`${section}.${key}`);
    await expect(setupHerdr(request, f.parts)).rejects.toMatchObject({ code: 'key-binding-conflict', message: expect.stringContaining(`${section}.${key}`) });
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await backup.readJournal(f.request.journalRoot)).entries).toEqual([]);
  } finally { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); }
}, 60_000);

test('reports the required binding even alongside a changed managed key', async () => {
  const { cleanup, fixture } = await import('../../../host/src/__tests__/herdr-setup-fixture.js');
  const f = await fixture(), path = join(f.h.directories.app, 'keys.json');
  try {
    await setupHerdr(f.request, f.parts);
    const keys = JSON.parse(await readFile(path, 'utf8'));
    keys.global['cmd-p'] = 'foreign.action';
    keys.global['cmd-shift-e'] = 'foreign.action';
    await writeFile(path, JSON.stringify(keys));
    const result = await setupHerdr({ ...f.request, dryRun: true, overwriteUnownedKeys: true, replaceChanged: true }, f.parts);
    expect(result.plan!.files.find(file => file.path === path)?.refusal).toMatchObject({ message: expect.stringContaining('global.cmd-shift-e') });
    await expect(setupHerdr({ ...f.request, overwriteUnownedKeys: true, replaceChanged: true }, f.parts)).rejects.toMatchObject({ message: expect.stringContaining('global.cmd-shift-e') });
  } finally { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); }
}, 60_000);

test('treats a native object without args as an unowned binding', () => {
  const bytes = Buffer.from(JSON.stringify({ global: { 'cmd-p': { command: 'tab.new' } } }));
  expect(() => backup.mergeKeys(bytes, desired, {}, false)).toThrowError(expect.objectContaining({ code: 'key-binding-conflict' }));
  const result = JSON.parse(backup.mergeKeys(bytes, desired, {}, true).toString());
  expect(result.global['cmd-p']).toBe('mod.open:spider-picker');
});

test.each(['terminal', 'layout:Spider'])('refuses a more-specific pane-close override in %s', section => {
  const bytes = Buffer.from(JSON.stringify({ global: { 'cmd-shift-w': 'pane.close' }, [section]: { 'cmd-shift-w': 'other.action' } }));
  expect(() => backup.mergeKeys(bytes, desired, {}, false)).toThrowError(expect.objectContaining({ code: 'key-binding-conflict' }));
  expect(() => backup.mergeKeys(bytes, desired, {}, true)).toThrowError(expect.objectContaining({ code: 'key-binding-conflict' }));
});

test.each([null, [], 'invalid'])('rejects a malformed key section without replacing it', section => {
  const bytes = Buffer.from(JSON.stringify({ global: section }));
  expect(() => backup.mergeKeys(bytes, desired, {}, false)).toThrowError(expect.objectContaining({ code: 'key-binding-conflict' }));
  expect(() => backup.mergeKeys(bytes, desired, {}, true)).toThrowError(expect.objectContaining({ code: 'key-binding-conflict' }));
});

test.each([
  { command: 'mod.open', args: [] },
  { command: '', args: {} },
  42,
])('rejects a malformed key binding rather than treating it as owned', value => {
  const bytes = Buffer.from(JSON.stringify({ global: { 'cmd-p': value } }));
  expect(() => backup.mergeKeys(bytes, desired, {}, false)).toThrowError(expect.objectContaining({ code: 'key-binding-conflict' }));
  expect(() => backup.mergeKeys(bytes, desired, {}, true)).toThrowError(expect.objectContaining({ code: 'key-binding-conflict' }));
});

const ordinary: AgentTerminal = { address: 't1', parent: null, state: 'live', status: null, labels: {} };
const focused = { pane: 'pane-1', terminal: 't1' };
test('parks the focused ordinary terminal exactly once', () => {
  const calls: [string, Record<string, unknown>][] = [];
  const run = (name: string, args: Record<string, unknown>): null => { calls.push([name, args]); return null; };
  expect(parkFocusedTerminal(focused, [ordinary], HerdrLabelContract, run)).toBe(true);
  expect(calls).toEqual([['terminal.park', { terminal: 't1' }]]);
});

test('quietly refuses missing focus, mod panes, unknown terminals, and payloads', () => {
  const calls: [string, Record<string, unknown>][] = [];
  const run = (name: string, args: Record<string, unknown>): null => { calls.push([name, args]); return null; };
  expect(parkFocusedTerminal(null, [ordinary], HerdrLabelContract, run)).toBe(false);
  expect(parkFocusedTerminal({ pane: 'mod-pane', terminal: null }, [ordinary], HerdrLabelContract, run)).toBe(false);
  expect(parkFocusedTerminal({ pane: null, terminal: 't1' }, [ordinary], HerdrLabelContract, run)).toBe(false);
  expect(parkFocusedTerminal(focused, [], HerdrLabelContract, run)).toBe(false);
  expect(parkFocusedTerminal(focused, [{ ...ordinary, state: 'finished' }], HerdrLabelContract, run)).toBe(false);
  for (const kind of ['exec', 'exec-file', 'batch']) {
    expect(parkFocusedTerminal(focused, [{ ...ordinary, labels: { 'spider.kind': kind } }], HerdrLabelContract, run)).toBe(false);
  }
  expect(calls).toEqual([]);
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function keyFixture() {
  const parent = join(process.env.SPIDER_GLOBAL_ROOT!, 'spaces-keys');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  roots.push(root);
  return { root, path: join(root, 'keys.json'), journal: await backup.readJournal(root) };
}
const sections = {
  global: ['cmd-p', 'cmd-n'],
  terminal: ['cmd-shift-a'],
  'layout:Spider': ['cmd-shift-e'],
} as const;
async function publishKeys(root: string, file: InstallFile, journal: backup.SetupJournal) {
  await backup.validateFiles([file], journal);
  await backup.prepareBackups(root, [file], journal);
  return backup.applyFiles(root, [file], journal);
}

test('records all managed key sections across a restart and preserves unrelated edits', async () => {
  const { root, path, journal } = await keyFixture();
  const original = Buffer.from(JSON.stringify({ global: { 'cmd-p': 'mod.open:picker', 'cmd-n': 'space.new', 'cmd-shift-w': 'pane.close' }, terminal: { 'ctrl-v': 'terminal.paste_image' } }));
  await writeFile(path, original);
  const part = { kind: 'keys', sections } as const;
  const file = { path, expected: backup.digest(original), bytes: backup.mergeKeys(original, desired, {}, false), keys: desired, managed: part } as unknown as InstallFile;
  expect(await publishKeys(root, file, journal)).toEqual([path]);
  const reopened = await backup.readJournal(root);
  expect(reopened.entries[0]).toMatchObject({ keys: desired, managed: part });
  const edited = JSON.parse(await readFile(path, 'utf8'));
  edited.global['cmd-t'] = 'tab.new';
  await writeFile(path, JSON.stringify(edited));
  expect(await backup.rollbackFiles(root, reopened)).toEqual([path]);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ global: { 'cmd-p': 'mod.open:picker', 'cmd-n': 'space.new', 'cmd-shift-w': 'pane.close', 'cmd-t': 'tab.new' }, terminal: { 'ctrl-v': 'terminal.paste_image' } });
});

test('rolls back unchanged owned fields without erasing a later key edit', async () => {
  const { root, path, journal } = await keyFixture();
  const original = Buffer.from(JSON.stringify({ global: { 'cmd-p': 'mod.open:picker', 'cmd-n': 'space.new', 'cmd-shift-w': 'pane.close' }, terminal: { 'ctrl-v': 'terminal.paste_image' } }));
  await writeFile(path, original);
  const file = { path, expected: backup.digest(original), bytes: backup.mergeKeys(original, desired, {}, false), keys: desired, managed: { kind: 'keys', sections } } as unknown as InstallFile;
  await publishKeys(root, file, journal);
  const edited = JSON.parse(await readFile(path, 'utf8'));
  edited.global['cmd-p'] = 'my.picker';
  edited.terminal['ctrl-v'] = 'my.paste';
  await writeFile(path, JSON.stringify(edited));
  const warnings: string[] = [];
  await backup.rollbackFiles(root, await backup.readJournal(root), { warn: warning => warnings.push(warning) });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ global: { 'cmd-p': 'my.picker', 'cmd-n': 'space.new', 'cmd-shift-w': 'pane.close' }, terminal: { 'ctrl-v': 'my.paste' } });
  expect(warnings).toHaveLength(1);
});

test('migrates a terminal-only journal without losing newer global baselines', async () => {
  const { root, path, journal } = await keyFixture();
  const initial = Buffer.from(JSON.stringify({ global: { 'cmd-shift-w': 'pane.close' }, terminal: { 'ctrl-v': 'terminal.paste_image', 'cmd-shift-a': 'previous.action' } }));
  await writeFile(path, initial);
  const legacyKeys = { 'cmd-shift-a': desired.terminal['cmd-shift-a'] };
  const legacy: InstallFile = { path, expected: backup.digest(initial), bytes: backup.mergeTerminalKeys(initial, legacyKeys, {}, true), terminalKeys: legacyKeys, managed: { kind: 'json', section: 'terminal', fields: ['cmd-shift-a'] } };
  await publishKeys(root, legacy, journal);
  journal.verified = true;
  const edited = JSON.parse(await readFile(path, 'utf8'));
  edited.global['cmd-p'] = 'mod.open:picker';
  edited.global['cmd-n'] = 'space.new';
  await writeFile(path, JSON.stringify(edited));
  const current = await readFile(path);
  const upgrade = { path, expected: backup.digest(current), bytes: backup.mergeKeys(current, desired, { terminal: legacyKeys }, false), keys: desired, managed: { kind: 'keys', sections } } as unknown as InstallFile;
  await publishKeys(root, upgrade, journal);
  const migrated = await backup.readJournal(root);
  expect(migrated.entries[0].previous).toHaveLength(1);
  await backup.rollbackFiles(root, migrated);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ global: { 'cmd-shift-w': 'pane.close', 'cmd-p': 'mod.open:picker', 'cmd-n': 'space.new' }, terminal: { 'ctrl-v': 'terminal.paste_image', 'cmd-shift-a': 'previous.action' } });
});

test('does not use clone replacement permission to overwrite an unowned key', async () => {
  const { root, path, journal } = await keyFixture();
  const current = Buffer.from(JSON.stringify({ global: { 'cmd-p': 'foreign.picker', 'cmd-shift-w': 'pane.close' } }));
  await writeFile(path, current);
  const file: InstallFile = { path, expected: backup.digest(current), bytes: backup.mergeKeys(current, desired, {}, true), keys: desired, managed: { kind: 'keys', sections }, collision: 'key', refusal: { code: 'key-binding-conflict', message: 'Unowned key' } };
  await expect(backup.validateFiles([file], journal, false, undefined, { replaceChanged: true })).rejects.toMatchObject({ code: 'key-binding-conflict' });
  expect((await backup.readJournal(root)).entries).toEqual([]);
  expect(await readFile(path)).toEqual(current);
  await expect(backup.validateFiles([file], journal, true)).resolves.toEqual([expect.objectContaining({ action: 'replace' })]);
});

test('refuses a key edit after preflight before writing a backup', async () => {
  const { root, path, journal } = await keyFixture();
  const original = Buffer.from(JSON.stringify({ global: { 'cmd-p': 'mod.open:picker', 'cmd-shift-w': 'pane.close' } }));
  await writeFile(path, original);
  const file: InstallFile = { path, expected: backup.digest(original), bytes: backup.mergeKeys(original, desired, {}, false), keys: desired, managed: { kind: 'keys', sections } };
  await backup.validateFiles([file], journal);
  await writeFile(path, JSON.stringify({ global: { 'cmd-p': 'someone.changed.it' } }));
  await expect(backup.prepareBackups(root, [file], journal)).rejects.toMatchObject({ code: 'concurrent-settings-edit' });
  expect((await backup.readJournal(root)).entries).toEqual([]);
  expect(JSON.parse(await readFile(path, 'utf8')).global['cmd-p']).toBe('someone.changed.it');
});

test('keeps only a conflicting key journalled and finishes rollback after repair', async () => {
  const { root, path, journal } = await keyFixture();
  const original = Buffer.from(JSON.stringify({ global: { 'cmd-p': 'mod.open:picker', 'cmd-n': 'space.new', 'cmd-shift-w': 'pane.close' } }));
  await writeFile(path, original);
  const file: InstallFile = { path, expected: backup.digest(original), bytes: backup.mergeKeys(original, desired, {}, false), keys: desired, managed: { kind: 'keys', sections } };
  await publishKeys(root, file, journal);
  const edited = JSON.parse(await readFile(path, 'utf8'));
  edited.global['cmd-p'] = 'my.picker';
  await writeFile(path, JSON.stringify(edited));
  const partial = await backup.readJournal(root);
  await backup.rollbackFiles(root, partial);
  await backup.saveJournal(root, partial);
  const reopened = await backup.readJournal(root);
  expect(reopened.entries[0].managed).toEqual({ kind: 'keys', sections: { global: ['cmd-p'] } });
  const repaired = JSON.parse(await readFile(path, 'utf8'));
  repaired.global['cmd-p'] = 'mod.open:spider-picker';
  await writeFile(path, JSON.stringify(repaired));
  await backup.rollbackFiles(root, reopened);
  expect(reopened.entries).toEqual([]);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(JSON.parse(original.toString()));
});

test('reports an edited managed key and preserves baselines on explicit takeover', async () => {
  const { root, path, journal } = await keyFixture();
  const original = Buffer.from(JSON.stringify({ global: { 'cmd-p': 'mod.open:picker', 'cmd-n': 'space.new', 'cmd-shift-w': 'pane.close' } }));
  await writeFile(path, original);
  const first: InstallFile = { path, expected: backup.digest(original), bytes: backup.mergeKeys(original, desired, {}, false), keys: desired, managed: { kind: 'keys', sections } };
  await publishKeys(root, first, journal);
  journal.verified = true;
  const changed = JSON.parse(await readFile(path, 'utf8'));
  changed.global['cmd-p'] = 'my.picker';
  await writeFile(path, JSON.stringify(changed));
  const current = await readFile(path);
  const update: InstallFile = { path, expected: backup.digest(current), bytes: backup.mergeKeys(current, desired, desired, true), keys: desired, managed: { kind: 'keys', sections }, collision: 'key', refusal: { code: 'key-binding-conflict', message: 'Changed key' } };
  await expect(backup.validateFiles([update], journal)).rejects.toMatchObject({ code: 'managed-artifact-changed' });
  await backup.validateFiles([update], journal, true);
  await backup.prepareBackups(root, [update], journal);
  await backup.applyFiles(root, [update], journal);
  await backup.rollbackFiles(root, await backup.readJournal(root));
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ global: { 'cmd-p': 'my.picker', 'cmd-n': 'space.new', 'cmd-shift-w': 'pane.close' } });
});

test('refuses a key baseline that is not present in any verified backup', async () => {
  const { root, path, journal } = await keyFixture();
  const original = Buffer.from(JSON.stringify({ global: { 'cmd-p': 'mod.open:picker', 'cmd-shift-w': 'pane.close' } }));
  await writeFile(path, original);
  const file: InstallFile = { path, expected: backup.digest(original), bytes: backup.mergeKeys(original, desired, {}, false), keys: desired, managed: { kind: 'keys', sections } };
  await publishKeys(root, file, journal);
  const raw = JSON.parse(await readFile(join(root, 'journal.json'), 'utf8'));
  raw.entries[0].keysBefore.global['cmd-p'] = { present: true, value: 'forged' };
  await writeFile(join(root, 'journal.json'), JSON.stringify(raw));
  const installed = await readFile(path);
  await expect(backup.rollbackFiles(root, await backup.readJournal(root))).rejects.toMatchObject({ code: 'backup-verification-failed' });
  expect(await readFile(path)).toEqual(installed);
});

test('rejects malformed legacy terminal ownership as an invalid journal', async () => {
  const { root, journal } = await keyFixture();
  const entry = { path: join(root, 'keys.json'), before: null, after: 'hash', backup: null, mode: 0o600, terminalKeys: { 'cmd-shift-a': 42 } };
  await writeFile(join(root, 'journal.json'), JSON.stringify({ ...journal, entries: [entry] }));
  await expect(backup.readJournal(root)).rejects.toMatchObject({ code: 'setup-journal-invalid' });
});

test('rejects malformed section ownership in a persisted journal', async () => {
  const { root, journal } = await keyFixture();
  const entry = { path: join(root, 'keys.json'), before: null, after: 'hash', backup: null, mode: 0o600, keys: { global: { 'cmd-p': { command: 'mod.open', args: [] } } }, managed: { kind: 'keys', sections: { global: ['cmd-p'] } }, managedAfter: 'value' };
  await writeFile(join(root, 'journal.json'), JSON.stringify({ ...journal, entries: [entry] }));
  await expect(backup.readJournal(root)).rejects.toMatchObject({ code: 'setup-journal-invalid' });
});
