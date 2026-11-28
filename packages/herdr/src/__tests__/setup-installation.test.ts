// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import * as fs from 'node:fs/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { HERDR_KINDS, type MachineName } from '../contracts.js';
import { setupHerdr, type SetupParts, type SetupRequest } from '../setup/installer.js';
import { doctorHerdr } from '../setup/doctor.js';
import { runHerdrCli, type HerdrCliPorts } from '../setup/cli.js';
import { readJournal } from '../setup/backup.js';
import { fixture as processFixture, hash, realFs, registerSetupCleanup } from './setup-fixture.js';
import { createInProcessHerdrHarness } from './setup-inprocess-harness.js';

const fixture = () => processFixture('fake', createInProcessHerdrHarness);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, chmod: vi.fn(actual.chmod), readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename), open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});
registerSetupCleanup();

test('CLI plan mode lists every file without a journal, probes or cutover', async () => {
  const f = await fixture(), output: string[] = [], errors: string[] = [];
  await mkdir(dirname(f.paths.layout), { recursive: true });
  await writeFile(f.paths.layout, '{"name":"spider-glass"}');
  await mkdir(dirname(f.paths.font), { recursive: true }); await writeFile(f.paths.font, 'user font');
  const before = await f.h.calls();
  const ports: HerdrCliPorts = { request: async () => f.request, setupParts: async () => f.parts, doctorParts: async () => f.doctorParts, stdout: text => output.push(text), stderr: text => errors.push(text) };
  expect(await runHerdrCli(['setup', '--dry-run'], ports)).toBe(1);
  expect(output.join('')).toContain(`adopt ${f.paths.layout}`);
  expect(output.join('')).toContain(`replace ${f.paths.font}`);
  expect(output.join('')).toContain(`write ${f.paths.spider}`);
  expect(output.join('')).toContain('cutover');
  expect(errors.join('')).toContain('--replace-changed');
  expect(await realFs.stat(f.request.journalRoot).then(() => true, () => false)).toBe(false);
  expect(await f.h.calls()).toEqual(before);
  expect(await readFile(f.paths.font, 'utf8')).toBe('user font');
  expect(f.cutovers()).toBe(0);
  expect(await runHerdrCli(['setup', '--dry-run', '--replace-changed'], ports)).toBe(0);
});

test('proved running sessions bypass cutover after a core restart and terminal replacement', async () => {
  const f = await processFixture(), first = await setupHerdr(f.request, f.parts);
  const preflight = f.parts.preflight;
  const recovered = { terminals: ['replacement' as never], identities: { session: 'current' } };
  f.parts.preflight = async request => ({ ...await preflight(request), coreIdentity: { ...f.h.owner!.terminal, coreId: 'restarted' as never }, recoveredCutover: recovered, cutoverNeedsRecheck: true, cutoverActions: [] });
  f.parts.cutover = async () => { throw new Error('Must not disturb running sessions'); };
  f.parts.reconcileCutover = async () => { throw new Error('Must not repeat session setup'); };
  const result = await setupHerdr(f.request, f.parts);
  expect(result.cutover).toEqual(recovered);
  expect(result.writes).toEqual([]);
  expect((await readJournal(f.request.journalRoot)).cutover).toEqual(recovered);
  expect((await f.h.hc.get(first.cutover!.terminals[0])).state).toBe('live');
  expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
});

test('saved mod state is available before the updated layout becomes visible', async () => {
  const f = await fixture(), stage = f.parts.stageLook;
  let path = '/path/to/old';
  f.parts.stageLook = async (...args) => (await stage(...args)).map(file => file.path === f.paths.layout ? { ...file, bytes: Buffer.from(JSON.stringify({ content: { mod: 'spider-agents', props: { path } } })) } : file);
  await setupHerdr(f.request, f.parts);
  const data = join(f.request.config.app.home, 'data/spider-agents'); await mkdir(data, { recursive: true });
  await writeFile(join(data, 'store-94630e0b396dc745.json'), '{"timer":"42"}');
  const observed: string[] = [];
  vi.mocked(fs.rename).mockImplementation(async (from, to) => { await realFs.rename(from, to); if (to === f.paths.layout) observed.push(await readFile(join(data, 'store-97d9d849eea9eed8.json'), 'utf8')); });
  const runtime = f.parts.ensureRuntime;
  f.parts.ensureRuntime = async (...args) => { await writeFile(join(data, 'store-94630e0b396dc745.json'), '{"timer":"43"}'); return runtime(...args); };
  path = '/path/to/new'; await setupHerdr(f.request, f.parts);
  expect(observed).toEqual(['{"timer":"43"}']);
});

test('runtime bootstrap follows verified uploads and precedes cutover', async () => {
  const f = await fixture();
  const order: string[] = [];
  const parts = f.parts as SetupParts & { bootstrapRuntime(request: SetupRequest, context: unknown): Promise<void> };
  parts.bootstrapRuntime = async () => {
    expect(await f.h.hc.fileRead('remote.invalid' as MachineName, f.h.directories.remote + '/runtime-v1.mjs')).toEqual(Buffer.from('runtime-v1'));
    order.push('bootstrap');
  };
  const cutover = parts.cutover;
  parts.cutover = async (r, c) => { order.push('cutover'); return cutover(r, c); };
  await setupHerdr(f.request, parts);
  expect(order).toEqual(['bootstrap', 'cutover']);
});

test('runtime bootstrap failure prevents cutover with repair advice', async () => {
  const f = await fixture();
  const parts = f.parts as SetupParts & { bootstrapRuntime(request: SetupRequest, context: unknown): Promise<void> };
  parts.bootstrapRuntime = async () => { throw new Error('destination is not writable'); };
  await expect(setupHerdr(f.request, parts)).rejects.toMatchObject({ code: 'runtime-bootstrap-failed', message: expect.stringContaining('destination is not writable') });
  expect(f.cutovers()).toBe(0);
});

test('a changed core and legacy layout fingerprint reconcile existing sessions without another cutover', async () => {
  const f = await fixture(), first = await setupHerdr(f.request, f.parts);
  const journal = await readJournal(f.request.journalRoot);
  journal.cutoverFingerprint = 'legacy-fingerprint';
  await (await import('../setup/backup.js')).saveJournal(f.request.journalRoot, journal);
  const preflight = f.parts.preflight;
  f.parts.preflight = async request => ({ ...await preflight(request), coreIdentity: { ...f.h.owner!.terminal, coreId: 'new-core' as never }, cutoverNeedsRecheck: true });
  let reconciled = 0;
  (f.parts as any).reconcileCutover = async (_request: SetupRequest, context: any) => { reconciled++; await context.recordCutover(first.cutover); return first.cutover; };
  f.parts.cutover = async () => { throw new Error('An existing owner must not be cut over again'); };
  const result = await setupHerdr(f.request, f.parts);
  expect(reconciled).toBe(1); expect(result.cutover).toEqual(first.cutover);
  expect(f.cutovers()).toBe(1);
  expect((await f.h.hc.get(first.cutover!.terminals[0])).state).toBe('live');
});

test('an unchanged setup performs no feed-directory metadata writes', async () => {
  const f = await fixture();
  await setupHerdr(f.request, f.parts);
  vi.mocked(fs.chmod).mockClear();
  await setupHerdr(f.request, f.parts);
  const directories = [join(f.request.config.globalRoot, 'herdr'), join(f.request.config.globalRoot, 'herdr/sessions')];
  expect(vi.mocked(fs.chmod).mock.calls.filter(([path]) => directories.includes(String(path)))).toEqual([]);
});

test('a second setup writes nothing and preserves unrelated settings', async () => {
  const f = await processFixture();
  const first = await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(f.settings, 'utf8'))).toEqual({ theme: 'dracula-plus-glass', unrelated: 'keep' });
  expect(first.writes).toContain(f.paths.spider);
  expect(first.writes).toHaveLength(17);
  const baseline = await Promise.all(first.writes.map(async (p) => [p, hash(await readFile(p))]));
  const calls = await f.h.calls();
  const second = await setupHerdr(f.request, f.parts);
  expect(second.writes).toEqual([]);
  expect(await f.h.calls()).toEqual(calls);
  expect(f.cutovers()).toBe(1);
  expect(await Promise.all(first.writes.map(async (p) => [p, hash(await readFile(p))]))).toEqual(baseline);
  expect((await doctorHerdr(f.request, f.doctorParts)).failures).toEqual([]);
  expect(JSON.parse(await readFile(f.paths.props, 'utf8')).labelContract).toEqual({ version: 1, labels: {
    session: 'spider.session', ownerCore: 'spider.owner-core', ownerTerminal: 'spider.owner-terminal',
    kind: 'spider.kind', job: 'spider.job', run: 'spider.run', space: 'herdr.space', tab: 'herdr.tab', machine: 'spider.machine',
    paneId: 'spider.pane-id', paneOperation: 'spider.pane-operation', targetCore: 'spider.target-core', targetTerminal: 'spider.target-terminal',
    paneRole: 'spider.pane-role', ownerGeneration: 'spider.owner-generation',
    parentName: 'spider.parent-name', steer: 'spider.steer', displayName: 'spider.display-name', viewerLifetime: 'spider.viewer-lifetime',
  }, kinds: HERDR_KINDS });
  expect(JSON.parse(await readFile(f.paths.props, 'utf8')).mods.map((mod: { props: { appBinary: string } }) => mod.props.appBinary)).toEqual(Array(5).fill(f.request.config.app.binary));
  for (const path of [f.paths.spider, f.paths.agents, f.paths.machines])
    expect(await readFile(path)).toEqual(await readFile(f.paths.feed));
  expect(await readFile(f.paths.children)).toEqual(await readFile(f.paths.projection));
});

test('old or missing destination Node refuses before target writes', async () => {
  for (const version of ['v22.17.9', 'v20.19.0', 'not-node', '']) {
    const f = await fixture();
    f.setVersion(version);
    await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'remote-node-unavailable' });
    expect(JSON.parse(await readFile(f.settings, 'utf8')).theme).toBe('stock');
    expect(f.cutovers()).toBe(0);
    expect(await realFs.stat(join(f.request.journalRoot, 'backups')).then(() => true, () => false)).toBe(false);
    expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
  }
});

test('standalone doctor repeats visible probes and detects independent native notification failures', async () => {
  const f = await processFixture();
  await setupHerdr(f.request, f.parts);
  const before = f.launches.length;
  await f.h.cli(['run', '--bg', '--no-parent', '--', f.h.nodeBinary, '-e', '']);
  await writeFile(f.notes, 'notes = true\n');
  const report = await doctorHerdr(f.request, f.doctorParts);
  expect(report.failures.map(e => e.code)).toContain('launch-notify-enabled');
  expect(report.failures.map(e => e.code)).toContain('native-notes-enabled');
  expect(report.probes).toEqual([{ machine: 'remote.invalid', nodePath: '/usr/bin/node', coreStartedAt: 'core-start-1', version: 'v22.19.0' }]);
  expect(f.launches.length).toBe(before + 1);
  const launch = f.launches.at(-1)!;
  expect(launch.noNotify).toBe(true);
  expect(launch.argv).toEqual(['/usr/bin/node', '--version']);
  expect(launch.parent).toBeUndefined();
  expect(await readFile(f.notes, 'utf8')).toBe('notes = true\n');
});

test('doctor asks every read-only inspector and reports an absent live status instance without a disk substitute', async () => {
  const f = await fixture();
  const inspected: string[] = [];
  const report = await doctorHerdr(f.request, { ...f.doctorParts, inspect: async (item) => {
      inspected.push(item);
      return item === 'status-instance' ? { failures: [{ item, code: 'status-instance-unavailable', message: 'No live terminal', repair: 'Reload a TUI owner' }] }
        : item === 'keys' ? { failures: [], warnings: [{ item, code: 'tree-view-key-collision', message: 'Tree filter owns the key in tree view', repair: 'Leave tree view before using the shortcut' }] } : { failures: [] };
    } });
  expect(inspected).toContain('runtime-digest');
  expect(inspected).toContain('mappings-leases');
  expect(inspected).toContain('bypass-stripping');
  expect(inspected).toHaveLength(30);
  for (const item of ['pane-core', 'pane-capabilities', 'pane-helper', 'pane-installation']) expect(inspected).toContain(item);
  expect(report.failures).toContainEqual({ item: 'status-instance', code: 'status-instance-unavailable', message: 'No live terminal', repair: 'Reload a TUI owner' });
  expect(report.warnings[0].code).toBe('tree-view-key-collision');
});

test('unowned terminal keys refuse before writes unless overwrite is explicit, preserving Ctrl-V and other sections', async () => {
  const f = await fixture();
  const path = join(f.request.config.app.home, 'keys.json');
  await writeFile(path, JSON.stringify({ global: { 'cmd-t': 'tab.new' }, terminal: { 'ctrl-v': 'terminal.paste_image', 'cmd-shift-a': 'other.action' } }));
  const original = f.parts.installFiles;
  f.parts.installFiles = async (r, c) => [...await original(r, c), { path, expected: hash(await readFile(path)), bytes: Buffer.from('{}'), terminalKeys: { 'cmd-shift-a': 'send:\u001b[97;6u' } }];
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'key-binding-conflict' });
  expect(JSON.parse(await readFile(f.settings, 'utf8')).theme).toBe('stock');
  await setupHerdr({ ...f.request, overwriteUnownedKeys: true }, f.parts);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ global: { 'cmd-t': 'tab.new' }, terminal: { 'ctrl-v': 'terminal.paste_image', 'cmd-shift-a': 'send:\u001b[97;6u' } });
  const before = await readFile(path);
  const second = await setupHerdr(f.request, f.parts);
  expect(second.writes).toEqual([]);
  expect(await readFile(path)).toEqual(before);
});

test('a crash after a fresh launch recovers recorded app IDs rather than launching a second writer', async () => {
  const f = await processFixture();
  let crash = true;
  const real = f.parts.cutover;
  f.parts.cutover = async (r, c) => {
    const result = c.priorCutover ?? await real(r, c);
    await c.recordCutover(result);
    if (crash) {
      crash = false;
      throw new Error('simulated crash after cutover record');
    }
    return result;
  };
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('simulated crash');
  const launches = (await f.h.calls()).filter(c => c.argv[0] === 'run').length;
  await setupHerdr(f.request, f.parts);
  expect((await f.h.calls()).filter(c => c.argv[0] === 'run')).toHaveLength(launches);
  expect(f.cutovers()).toBe(1);
});

test('the shell CLI validates absolute config arguments and invokes setup or doctor without an app spawn', async () => {
  const f = await fixture();
  const output: string[] = [];
  const errors: string[] = [];
  let defaultRequests = 0;
  const ports: HerdrCliPorts = { request: async (path) => { if (path === undefined) defaultRequests++; else expect(path).toBe(f.request.configPath); return f.request; }, setupParts: async () => f.parts, doctorParts: async () => f.doctorParts, stdout: s => output.push(s), stderr: s => errors.push(s) };
  expect(await runHerdrCli(['setup', '--config', f.request.configPath], ports)).toBe(0);
  expect(JSON.parse(await readFile(f.settings, 'utf8')).theme).toBe('dracula-plus-glass');
  expect(await runHerdrCli(['doctor', '--config', f.request.configPath], ports)).toBe(0);
  expect(await runHerdrCli(['setup'], ports)).toBe(0);
  expect(defaultRequests).toBe(1);
  for (const argv of [['setup', '--config', 'relative.json'], ['setup', '--config', f.request.configPath, '--unknown'], ['setup', '--config', f.request.configPath, '--config', f.request.configPath]])
    expect(await runHerdrCli(argv, ports)).toBe(2);
  expect(output.join('')).toContain('Setup verified');
  expect(errors.join('')).toContain('usage');
});

test('CLI doctor has a nonzero exit for an unavailable role and reports its repair', async () => {
  const f = await fixture();
  const output: string[] = [];
  await writeFile(f.notes, 'notes = false\n');
  const ports: HerdrCliPorts = { request: async () => f.request, setupParts: async () => f.parts, doctorParts: async () => ({ ...f.doctorParts, inspect: async (item) => ({ failures: item === 'roles' ? [{ item, code: 'role-unresolved', message: 'Configured role unavailable', repair: 'Choose an available configured model' }] : [] }) }), stdout: s => output.push(s), stderr: s => output.push(s) };
  expect(await runHerdrCli(['doctor', '--config', f.request.configPath], ports)).toBe(1);
  expect(output.join('')).toContain('role-unresolved');
  expect(output.join('')).toContain('Choose an available configured model');
});

test('backup preparation pins earlier snapshots even when a later preflight file read races an edit', async () => {
  const f = await fixture();
  const original = f.parts.installFiles;
  f.parts.installFiles = async (r, c) => {
    const files = await original(r, c);
    await writeFile(f.settings, '{"theme":"stock","unrelated":"edited"}');
    return files;
  };
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'concurrent-settings-edit' });
  expect(JSON.parse(await readFile(f.settings, 'utf8')).unrelated).toBe('edited');
  expect(f.cutovers()).toBe(0);
});

test('a crash cannot overwrite a settings edit between validation and the verified backup', async () => {
  const f = await fixture();
  const realRead = realFs.readFile;
  let reads = 0;
  vi.mocked(fs.readFile).mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    const result = await realRead(...args);
    if (args[0] === f.settings && ++reads === 2)
      await writeFile(f.settings, '{"theme":"stock","unrelated":"raced"}');
    return result;
  }) as typeof fs.readFile);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'concurrent-settings-edit' });
  expect(JSON.parse(await realRead(f.settings, 'utf8')).unrelated).toBe('raced');
  expect(f.cutovers()).toBe(0);
});
