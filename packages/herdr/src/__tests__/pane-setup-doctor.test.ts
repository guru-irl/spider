// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeKeys, readJournal, validateFiles, prepareBackups, applyFiles, rollbackFiles, digest } from '../setup/backup.js';
import { checkManagedKeyBindings } from '../setup/doctor.js';
import { createClientFixture } from './testutil.js';
import type { KeySections } from '../setup/backup.js';
import type { InstallFile } from '../setup/installer.js';
vi.mock('node:child_process', async original => { const actual = await original<typeof import('node:child_process')>(); return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) }; });
const b = {
  global: { 'cmd-p': 'mod.open:spider-picker', 'cmd-n': { command: 'space.new', args: { machine: '' } }, 'cmd-t': 'mod.open:spider-machine-picker', 'cmd-d': 'mod.open:spider-machine-picker-right', 'cmd-shift-d': 'mod.open:spider-machine-picker-down' },
  'layout:spider-glass': { 'cmd-shift-e': 'spider-pane.park', 'cmd-shift-w': 'spider-pane.close' },
} as const satisfies KeySections;
const stock = () => ({ global: { 'cmd-p': 'mod.open:picker', 'cmd-n': 'space.new', 'cmd-t': 'tab.new', 'cmd-d': 'pane.split:right', 'cmd-shift-d': 'pane.split:down', 'cmd-shift-w': 'pane.close', 'cmd-f': 'terminal.search' }, terminal: { 'ctrl-v': 'terminal.paste_image' } });
test('B extends A managed key ownership without changing native close behaviour', async () => {
  const shipped = JSON.parse(await readFile(new URL('../../assets/keys.json', import.meta.url), 'utf8'));
  expect(shipped.global).toMatchObject(b.global); expect(shipped['layout:spider-glass']).toEqual(b['layout:spider-glass']);
  const keys = JSON.parse(mergeKeys(Buffer.from(JSON.stringify(stock())), b, {}, false).toString());
  for (const layout of ['main', 'terminals', 'win98']) expect(keys[`layout:${layout}`]?.['cmd-shift-w'] ?? keys.global['cmd-shift-w']).toBe('pane.close');
  expect(keys['layout:spider-glass']['cmd-shift-w']).toBe('spider-pane.close'); expect(keys.global['cmd-n']).toEqual(b.global['cmd-n']);
  expect(keys.global['cmd-f']).toBe('terminal.search'); expect(keys.terminal['ctrl-v']).toBe('terminal.paste_image');
  expect(checkManagedKeyBindings(Buffer.from(JSON.stringify(keys)), b).failures).toEqual([]);
});
test('stock creation and close bindings migrate but user keys refuse', () => {
  const bytes = Buffer.from(JSON.stringify(stock())), installed = mergeKeys(bytes, b, {}, false);
  expect(mergeKeys(installed, b, b, false)).toEqual(installed);
  for (const key of ['cmd-t', 'cmd-d', 'cmd-shift-d']) for (const overwrite of [false, true]) {
    const keys = stock(); keys.global[key as 'cmd-t'] = 'foreign.action'; const original = Buffer.from(JSON.stringify(keys));
    expect(() => mergeKeys(original, b, {}, overwrite)).toThrowError(expect.objectContaining({ code: 'key-binding-conflict' })); expect(JSON.parse(original.toString())).toEqual(keys);
  }
  expect(() => mergeKeys(Buffer.from(JSON.stringify({ 'layout:spider-glass': { 'cmd-shift-w': 'foreign.action' } })), b, {}, true)).toThrow();
});
test('B key ownership rolls back only unchanged fields', async () => {
  const f = await createClientFixture();
  try {
    const root = join(f.root, 'setup'), path = join(f.root, 'keys.json'), original = Buffer.from(JSON.stringify(stock())); await writeFile(path, original);
    const journal = await readJournal(root), file: InstallFile = { path, expected: digest(original), bytes: mergeKeys(original, b, {}, false), keys: b, managed: { kind: 'keys', sections: Object.fromEntries(Object.entries(b).map(([section, keys]) => [section, Object.keys(keys)])) } };
    await validateFiles([file], journal); await prepareBackups(root, [file], journal); await applyFiles([file], journal);
    const edited = JSON.parse(await readFile(path, 'utf8')); edited.global['cmd-d'] = 'my.split'; await writeFile(path, JSON.stringify(edited));
    await rollbackFiles(root, await readJournal(root), { warn: () => {} }); const result = JSON.parse(await readFile(path, 'utf8'));
    expect(result.global).toEqual({ ...stock().global, 'cmd-d': 'my.split' }); expect(result['layout:spider-glass']).toBeUndefined(); expect(result.terminal).toEqual(stock().terminal);
  } finally { await f.close(); }
});
afterEach(() => vi.restoreAllMocks());

test('generated picker mods have isolated private configuration and entry points', async () => {
  const f = await createClientFixture();
  try {
    const { planPaneModFiles } = await import('../setup/pane-assets.js');
    const files = await planPaneModFiles({ assetsRoot: new URL('../../assets/', import.meta.url).pathname, appHome: f.root, nodePath: process.execPath, cliPath: join(f.root, 'cli.mjs'), fonts: {} });
    for (const [suffix, place] of [['', 'tab'], ['-right', 'right'], ['-down', 'down']]) {
      const directory = join(f.root, 'mods', 'spider-machine-picker' + suffix);
      expect(files.find(file => file.path === join(directory, 'main.js'))!.bytes.toString()).toContain(`machinePickerView(${JSON.stringify(place)})`);
      const config = files.find(file => file.path === join(directory, 'config.json'))!; expect(config.mode).toBe(0o600); expect(JSON.parse(config.bytes.toString())).toMatchObject({ version: 1, checkMode: false, nodePath: process.execPath });
      expect(files.some(file => file.path === join(directory, 'picker.js'))).toBe(true); expect(files.some(file => file.path === join(directory, 'actions.js'))).toBe(true);
    }
    expect(files.some(file => file.path.endsWith('spider-pane-waiting/main.js'))).toBe(true);
  } finally { await f.close(); }
});

test('doctor missing helper starts nothing', async () => {
  const f = await createClientFixture();
  try {
    const { inspectPaneServiceState } = await import('../setup/doctor.js'), probe = vi.fn(async () => { throw new Error('Must not contact a missing helper'); });
    const root = join(f.root, 'absent-panes'), report = await inspectPaneServiceState(root, probe);
    expect(report.warnings?.[0].code).toBe('pane-helper-missing'); expect(probe).not.toHaveBeenCalled();
    await expect((await import('node:fs/promises')).stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.close(); }
});
test('doctor checks the proved core floor and treats unknown capabilities as unsupported', async () => {
  const { paneCoreVersionSupported, inspectPaneCommands } = await import('../setup/doctor.js');
  expect(paneCoreVersionSupported('0.1.15')).toBe(false); expect(paneCoreVersionSupported('0.1.16')).toBe(true); expect(paneCoreVersionSupported('unknown')).toBe(false);
  expect(inspectPaneCommands({ commands: 'unknown' }).warnings?.[0].code).toBe('pane-capabilities-unknown');
  expect(inspectPaneCommands({ commands: [{ name: 'pane.swap', args: [] }] }).warnings?.[0].code).toBe('pane-command-unavailable');
});
test('doctor private-cache failures do not print source owner paths', async () => {
  const f = await createClientFixture();
  try {
    const { inspectPaneServiceState } = await import('../setup/doctor.js'), root = join(f.root, 'panes'); await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, 'service.json'), JSON.stringify({ owner: { cwd: 'private-source-cwd', sessionFile: 'private-session-file' } }), { mode: 0o644 });
    const probe = vi.fn(async () => true), report = await inspectPaneServiceState(root, probe);
    expect(report.failures[0].code).toBe('pane-cache-unsafe'); expect(JSON.stringify(report)).not.toContain('private-source-cwd'); expect(JSON.stringify(report)).not.toContain('private-session-file'); expect(probe).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('production doctor missing helper does not start a helper, target or view', async () => {
  const { fixture, cleanup } = await import('../../../host/src/__tests__/herdr-setup-fixture.js'); const f = await fixture();
  try {
    const before = (await f.h.calls()).filter(call => call.argv[0] === 'run');
    const report = await (await f.ports.doctorParts(f.request)).inspect('pane-helper', f.request);
    expect(report.warnings?.[0].code).toBe('pane-helper-missing'); expect((await f.h.calls()).filter(call => call.argv[0] === 'run')).toEqual(before);
  } finally { for (const close of cleanup.splice(0).reverse()) await close(); }
});
test('production setup endpoint staging is local and idempotent', async () => {
  const { fixture, cleanup } = await import('../../../host/src/__tests__/herdr-setup-fixture.js'); const f = await fixture();
  try {
    const before = await f.h.calls(), remoteBefore = await f.h.calls('remote');
    const writes = await f.parts.stagePaneEndpoint!(f.request);
    expect(writes.some(path => path.startsWith(join(f.root, 'dist/herdr/pane-endpoint-')))).toBe(true);
    expect(await f.parts.stagePaneEndpoint!(f.request)).toEqual([]);
    expect(await f.h.calls()).toEqual(before); expect(await f.h.calls('remote')).toEqual(remoteBefore);
    expect((await (await f.ports.doctorParts(f.request)).inspect('pane-installation', f.request)).failures).toEqual([]);
  } finally { for (const close of cleanup.splice(0).reverse()) await close(); }
});

test('setup refuses an existing nonprivate picker config without rewriting it', async () => {
  const f = await createClientFixture();
  try {
    const { planPaneModFiles } = await import('../setup/pane-assets.js'), directory = join(f.root, 'mods/spider-machine-picker'), config = join(directory, 'config.json');
    await mkdir(directory, { recursive: true }); await writeFile(config, '{"private":"unchanged"}', { mode: 0o600 }); await chmod(config, 0o644);
    await expect(planPaneModFiles({ assetsRoot: new URL('../../assets/', import.meta.url).pathname, appHome: f.root, nodePath: process.execPath, cliPath: join(f.root, 'cli.mjs'), fonts: {} })).rejects.toMatchObject({ code: 'picker-config-insecure' });
    expect(await readFile(config, 'utf8')).toBe('{"private":"unchanged"}');
  } finally { await f.close(); }
});
