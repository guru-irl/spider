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
import { fixture, hash, realFs, registerSetupCleanup } from './setup-fixture.js';

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
  const f = await fixture(), first = await setupHerdr(f.request, f.parts);
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
  const f = await fixture();
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
  expect(JSON.parse(await readFile(f.paths.props, 'utf8')).labelContract).toEqual({ version: 1, labels: HERDR_LABELS, kinds: HERDR_KINDS });
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
  const f = await fixture();
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
  expect(inspected).toHaveLength(26);
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
  const f = await fixture();
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

test('an uncertain cutover failure blocks retry rather than reopening a session with an unrecorded owner', async () => {
  const f = await fixture();
  const real = f.parts.cutover;
  f.parts.cutover = async (r, c) => { await real(r, c); throw new Error('lost cutover acknowledgement'); };
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('lost cutover acknowledgement');
  const calls = await f.h.calls();
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'cutover-reconciliation-required' });
  expect(await f.h.calls()).toEqual(calls);
  expect(f.cutovers()).toBe(1);
});

test('duplicate root notes keys refuse while section notes and unrelated TOML survive', async () => {
  const f = await fixture();
  await writeFile(f.notes, 'notes = true\nnotes = false\n[other]\nnotes = true\n');
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'duplicate-notes-key' });
  expect(JSON.parse(await readFile(f.settings, 'utf8')).theme).toBe('stock');
  await writeFile(f.notes, '# keep comment\nnotes = true # root\nzoom = 2\n[other]\nnotes = true\n');
  await setupHerdr(f.request, f.parts);
  expect(await readFile(f.notes, 'utf8')).toBe('# keep comment\nnotes = false # root\nzoom = 2\n[other]\nnotes = true\n');
});

test('a symlink destination or parent refuses before any target replacement', async () => {
  for (const parent of [false, true]) {
    const f = await fixture();
    const other = join(f.h.root, 'other');
    await mkdir(other);
    if (parent)
      await symlink(other, join(f.request.config.app.home, 'fonts'));
    else {
      const file = join(other, 'font');
      await writeFile(file, 'unowned');
      await mkdir(join(f.request.config.app.home, 'fonts'));
      await symlink(file, f.paths.font);
    }
    await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'destination-symlink' });
    expect(JSON.parse(await readFile(f.settings, 'utf8')).theme).toBe('stock');
  }
});

test('an unowned clone and unavailable role refuse before writes without replacing usable artifacts', async () => {
  const f = await fixture();
  await mkdir(join(f.request.config.app.home, 'layouts'));
  await writeFile(f.paths.layout, 'local-clone');
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'unowned-clone-collision' });
  expect(await readFile(f.paths.layout, 'utf8')).toBe('local-clone');
  const g = await fixture();
  g.parts.generateTemplates = async () => { throw Object.assign(new Error('Configured role unavailable'), { code: 'role-unresolved' }); };
  await expect(setupHerdr(g.request, g.parts)).rejects.toMatchObject({ code: 'role-unresolved' });
  expect(JSON.parse(await readFile(g.settings, 'utf8')).theme).toBe('stock');
  expect(g.cutovers()).toBe(0);
});

test('read-only export is preferred; a fallback warns before an explicitly fenced staging clone', async () => {
  const f = await fixture();
  await setupHerdr(f.request, f.parts);
  expect(f.modes).toEqual(['export']);
  expect(f.warnings).toEqual([]);
  const g = await fixture();
  const original = g.parts.preflight;
  g.parts.preflight = async (r) => ({ ...await original(r), layoutExport: false, stagingProof: { appHome: join(g.h.root, 'staging-app'), coreSocket: g.h.remoteSocket, coreId: g.h.remoteCoreId! } });
  await expect(setupHerdr(g.request, g.parts)).rejects.toMatchObject({ code: 'staging-app-not-authorized' });
  expect(g.modes).toEqual([]);
  expect(g.warnings[0]).toContain('second app window');
  const stage = g.parts.stageLook;
  g.parts.stageLook = async (...args) => { expect(g.warnings.length).toBeGreaterThan(0); return stage(...args); };
  await setupHerdr({ ...g.request, allowStagingApp: true }, g.parts);
  expect(g.modes).toEqual(['isolated-clone']);
});

test('setup requires a plain shell and cannot use a headless child as cutover authority', async () => {
  const f = await fixture();
  for (const variable of ['PI_SESSION_ID', 'PI_SUBAGENT_CHILD']) {
    vi.stubEnv(variable, variable === 'PI_SUBAGENT_CHILD' ? '1' : 'fixture');
    await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'setup-requires-plain-shell' });
    vi.unstubAllEnvs();
  }
  expect(f.cutovers()).toBe(0);
  expect(JSON.parse(await readFile(f.settings, 'utf8')).theme).toBe('stock');
});

test('rollback restores only matching installed files and never closes an unrelated terminal', async () => {
  const f = await fixture();
  const result = await setupHerdr(f.request, f.parts);
  const unrelated = await f.h.hc.run({ argv: [f.h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: f.h.root, labels: {}, outliveParent: true, background: true, noNotify: true });
  await writeFile(f.paths.spider, 'user-edited-decoder');
  const restored = await rollbackHerdr(f.request, f.parts);
  expect(restored).not.toContain(f.paths.spider);
  expect(await readFile(f.paths.spider, 'utf8')).toBe('user-edited-decoder');
  expect(JSON.parse(await readFile(f.settings, 'utf8'))).toEqual({ theme: 'stock', unrelated: 'keep' });
  expect((await f.h.hc.get(unrelated.address)).state).toBe('live');
  await expect(f.h.hc.get(result.cutover!.terminals[0])).rejects.toMatchObject({ code: 'not_found' });
});

test('a changed Node path or core start invalidates the observation without duplicate owners or runtime uploads', async () => {
  const f = await fixture();
  await setupHerdr(f.request, f.parts);
  const uploads = () => f.h.calls().then(calls => calls.filter(c => c.argv[0] === 'file' && c.argv[1] === 'write'));
  expect(await uploads()).toHaveLength(1);
  f.setTarget({ nodePath: '/opt/node' });
  const changed = await setupHerdr(f.request, f.parts);
  expect(changed.probes).toHaveLength(1);
  expect(changed.probes[0].nodePath).toBe('/opt/node');
  f.setTarget({ coreStartedAt: 'core-start-2' });
  const restarted = await setupHerdr(f.request, f.parts);
  expect(restarted.probes).toHaveLength(1);
  expect(restarted.probes[0].coreStartedAt).toBe('core-start-2');
  expect(f.cutovers()).toBe(1);
  expect(await uploads()).toHaveLength(1);
  const journal = await readJournal(f.request.journalRoot);
  expect(journal.probes).toEqual([{ machine: 'remote.invalid', nodePath: '/opt/node', version: 'v22.19.0', coreStartedAt: 'core-start-2' }]);
  const launches = (await f.h.calls()).filter(c => c.argv[0] === 'run');
  expect(launches.length).toBeGreaterThan(0);
  for (const launch of launches)
    expect(launch.argv).toContain('--no-notify');
});

if (process.env.SPIDER_HERDR_E2E !== '1')
  console.info('SKIP real setup core probes: require SPIDER_HERDR_E2E=1; no real app test is launched');

test.skipIf(process.env.SPIDER_HERDR_E2E !== '1')('isolated hc visibly probes destination Node and verifies one runtime upload without opening an app', async () => {
  const f = await fixture('hc');
  f.setTarget({ nodePath: f.h.nodeBinary });
  const result = await setupHerdr(f.request, f.parts);
  expect(result.probes[0].version).toBe(process.version);
  expect(await f.h.hc.fileRead('remote.invalid' as MachineName, f.h.directories.remote + '/runtime-v1.mjs')).toEqual(Buffer.from('runtime-v1'));
  const journal = await readJournal(f.request.journalRoot);
  const before = await readFile(join(f.request.journalRoot, 'journal.json'));
  expect(journal.probes[0].nodePath).toBe(f.h.nodeBinary);
  const second = await setupHerdr(f.request, f.parts);
  expect(second.writes).toEqual([]);
  expect(second.probes).toEqual([]);
  expect(f.cutovers()).toBe(1);
  expect(await readFile(join(f.request.journalRoot, 'journal.json'))).toEqual(before);
  for (const launch of f.launches)
    expect(launch.noNotify).toBe(true);
  await f.h.close();
  expect(await f.h.remainingOwnedResources()).toEqual([]);
  expect(f.h.cleanupProof).toMatchObject({ mode: 'hc', defaultCoreUnchanged: true, remaining: [] });
}, 30000);

test('an isolated staging app cannot share the selected target core or nest inside its app home', async () => {
  for (const kind of ['same-core', 'nested-home']) {
    const f = await fixture();
    const original = f.parts.preflight;
    f.parts.preflight = async (r) => ({ ...await original(r), layoutExport: false, stagingProof: {
        appHome: kind === 'nested-home' ? join(f.request.config.app.home, 'staging') : join(f.h.root, 'staging'),
        coreSocket: kind === 'same-core' ? f.h.localSocket : f.h.remoteSocket,
        coreId: kind === 'same-core' ? f.h.localCoreId! : f.h.remoteCoreId!,
      } });
    await expect(setupHerdr({ ...f.request, allowStagingApp: true }, f.parts)).rejects.toMatchObject({ code: 'staging-isolation-unproved' });
    expect(f.modes).toEqual([]);
    expect(JSON.parse(await readFile(f.settings, 'utf8')).theme).toBe('stock');
  }
});

test('an existing versioned runtime with different bytes fails before local writes instead of overwriting it', async () => {
  const f = await fixture();
  const path = f.h.directories.remote + '/runtime-v1.mjs';
  await f.h.hc.fileWrite('remote.invalid' as MachineName, path, Buffer.from('unowned-runtime'));
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'runtime-digest-mismatch' });
  expect(await f.h.hc.fileRead('remote.invalid' as MachineName, path)).toEqual(Buffer.from('unowned-runtime'));
  expect(JSON.parse(await readFile(f.settings, 'utf8')).theme).toBe('stock');
  expect(f.cutovers()).toBe(0);
  expect(await realFs.stat(join(f.request.journalRoot, 'backups')).then(() => true, () => false)).toBe(false);
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
});

test('a partial prewrite backup crash is repaired from the unchanged pinned original before installing', async () => {
  const f = await fixture();
  let crashed = false;
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realFs.open(...args);
    if (String(args[0]).includes('/backups/') && !crashed) {
      handle.writeFile = async () => { crashed = true; await handle.write(Buffer.from('partial')); throw new Error('partial backup crash'); };
    }
    return handle;
  });
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow('partial backup crash');
  vi.mocked(fs.open).mockImplementation(realFs.open);
  expect(JSON.parse(await readFile(f.settings, 'utf8')).theme).toBe('stock');
  await setupHerdr(f.request, f.parts);
  const journal = await readJournal(f.request.journalRoot);
  const backup = journal.entries.find(e => e.path === f.settings)!.backup!;
  expect(await readFile(backup, 'utf8')).toBe('{"theme":"stock","unrelated":"keep"}\n');
});

test('a missing configured destination Node produces a named repair without changing target files', async () => {
  const f = await fixture();
  f.parts.probeMachineNode = async () => { throw Object.assign(new Error('node executable is missing'), { code: 'spawn-error' }); };
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'remote-node-unavailable', message: expect.stringContaining('remote.invalid') });
  expect(JSON.parse(await readFile(f.settings, 'utf8')).theme).toBe('stock');
  expect(f.cutovers()).toBe(0);
});

test('native pending-note identities are journaled and a fresh launch cannot reuse one', async () => {
  const f = await fixture();
  f.parts.cutover = async () => ({ terminals: [f.h.owner!.terminal.address], identities: {} });
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'retired-terminal-reused' });
  expect((await readJournal(f.request.journalRoot)).retiredTerminals).toEqual([f.h.owner!.terminal.address]);
});

test('exclusive setup ownership refuses another live installer without altering the lock', async () => {
  const f = await fixture();
  const original = f.parts.preflight;
  let attempted = false;
  f.parts.preflight = async (r) => {
    if (!attempted) {
      attempted = true;
      const before = await readFile(join(r.journalRoot, 'lock'));
      await expect(setupHerdr(r, f.parts)).rejects.toMatchObject({ code: 'setup-locked' });
      expect(await readFile(join(r.journalRoot, 'lock'))).toEqual(before);
    }
    return original(r);
  };
  await setupHerdr(f.request, f.parts);
});

test('installed mod copies get unique validated modIds equal to their directory names and duplicate copies refuse', async () => {
  const f = await fixture();
  await setupHerdr(f.request, f.parts);
  const installed = JSON.parse(await readFile(f.paths.props, 'utf8')).mods as {
    directory: string;
    props: {
      modId: string;
    };
  }[];
  expect(installed.map(copy => copy.props.modId)).toEqual(['spider', 'machines', 'agents', 'spaces', 'pane']);
  for (const copy of installed) {
    expect(copy.directory).toBe(join(f.request.config.app.home, 'mods', copy.props.modId));
    expect(JSON.parse(await readFile(join(copy.directory, 'props.json'), 'utf8')).modId).toBe(copy.props.modId);
  }
  const g = await fixture();
  const original = g.parts.preflight;
  g.parts.preflight = async (r) => { const p = await original(r); return { ...p, mods: [...p.mods, p.mods[0]] }; };
  await expect(setupHerdr(g.request, g.parts)).rejects.toMatchObject({ code: 'duplicate-mod-id' });
  expect(JSON.parse(await readFile(g.settings, 'utf8')).theme).toBe('stock');
  expect(g.cutovers()).toBe(0);
});

test('the IPC subcommand consumes exactly the canonical full panel argv and returns one canonical reply line', async () => {
  const f = await fixture();
  const output: string[] = [];
  const errors: string[] = [];
  const descriptor: IpcDescriptor = { version: 1, sessionId: f.h.owner!.sessionId, generation: f.h.owner!.generation, address: join(f.h.root, 'ipc.sock'), capabilityFile: join(f.h.root, 'capability') };
  await writeFile(descriptor.capabilityFile, 'a'.repeat(64), { mode: 0o600 });
  const request: SessionIpcRequest = { op: 'openRun', generation: descriptor.generation, runId: 'run-fixture' as import('../contracts.js').RunId };
  let called = 0;
  const ports: HerdrCliPorts = { request: async () => { throw new Error('IPC must not load setup config'); }, setupParts: async () => f.parts, doctorParts: async () => f.doctorParts,
    ipc: async (d, r) => { called++; expect(d).toEqual(descriptor); expect(r).toEqual(request); expect(await readFile(d.capabilityFile, 'utf8')).toHaveLength(64); return { ok: true, op: 'openRun', viewer: f.h.owner!.terminal.address }; }, stdout: s => output.push(s), stderr: s => errors.push(s) };
  const argv = panelIpcArgv(f.h.nodeBinary, join(f.h.root, 'cli.mjs'), descriptor, request);
  expect(await runHerdrCli(argv, ports)).toBe(0);
  expect(output).toEqual([JSON.stringify({ ok: true, op: 'openRun', viewer: f.h.owner!.terminal.address }) + '\n']);
  expect(errors).toEqual([]);
  expect(called).toBe(1);
  expect(await runHerdrCli(argv.slice(2), ports)).toBe(2);
  expect(await runHerdrCli([...argv, '--extra'], ports)).toBe(2);
  expect(called).toBe(1);
});

test('journal compare-before-write preserves an edit racing its next checkpoint', async () => {
  const f = await fixture();
  const path = join(f.request.journalRoot, 'journal.json');
  let edited = false;
  vi.mocked(fs.readFile).mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await realFs.readFile(...args);
    if (args[0] === path && !edited) {
      edited = true;
      await realFs.writeFile(path, JSON.stringify({ ...JSON.parse(bytes.toString()), externalEdit: true }));
    }
    return bytes;
  }) as typeof fs.readFile);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'concurrent-settings-edit' });
  expect(JSON.parse(await realFs.readFile(path, 'utf8')).externalEdit).toBe(true);
  expect(f.cutovers()).toBe(0);
});

test('two stale-lock reclaimers cannot both acquire setup ownership', async () => {
  const f = await fixture();
  const path = join(f.request.journalRoot, 'lock');
  await mkdir(f.request.journalRoot);
  await writeFile(path, '99999999:fixture-stale');
  let triggered = false;
  let held = 0;
  let maxHeld = 0;
  let secondaryError: unknown;
  let signalReady!: () => void;
  const ready = new Promise<void>(done => { signalReady = done; });
  let releaseSecondary!: () => void;
  const release = new Promise<void>(done => { releaseSecondary = done; });
  let secondary: Promise<void> | undefined;
  vi.mocked(fs.unlink).mockImplementation(async (target) => {
    if (target === path && !triggered) {
      triggered = true;
      secondary = withSetupLock(f.request.journalRoot, async () => { held++; maxHeld = Math.max(maxHeld, held); signalReady(); await release; held--; })
        .catch(error => { secondaryError = error; signalReady(); });
      await ready;
    }
    await realFs.unlink(target);
  });
  await withSetupLock(f.request.journalRoot, async () => { held++; maxHeld = Math.max(maxHeld, held); releaseSecondary(); held--; });
  await secondary;
  expect(maxHeld).toBe(1);
  expect(secondaryError).toMatchObject({ code: 'setup-locked' });
});

test('the actual pi process title refuses setup before a CLI factory can create resources', async () => {
  const f = await fixture();
  const title = process.title;
  const errors: string[] = [];
  let factories = 0;
  const ports: HerdrCliPorts = { request: async () => { factories++; return f.request; }, setupParts: async () => { factories++; return f.parts; }, doctorParts: async () => f.doctorParts, stdout: () => { }, stderr: s => errors.push(s) };
  try {
    process.title = 'pi';
    expect(await runHerdrCli(['setup', '--config', f.request.configPath], ports)).toBe(1);
    expect(factories).toBe(0);
    expect(errors.join('')).toContain('setup-requires-plain-shell');
  }
  finally {
    process.title = title;
  }
  expect(JSON.parse(await readFile(f.settings, 'utf8')).theme).toBe('stock');
});

test('doctor CLI reports unavailable inspections instead of claiming all checks passed', async () => {
  const f = await fixture(); await writeFile(f.notes, 'notes = false\n'); let output = '';
  await writeFile(join(f.inspections, 'jobs.json'), JSON.stringify({ failures: [], warnings: [{ item: 'jobs', code: 'inspection-unavailable', message: 'No job inspector', repair: 'Run with an inspectable owner' }] }));
  expect(await runHerdrCli(['doctor', '--config', f.request.configPath], { request: async () => f.request, setupParts: async () => f.parts, doctorParts: async () => f.doctorParts, stdout: text => { output += text; }, stderr() {} })).toBe(0);
  expect(output).not.toContain('Doctor checks passed');
  expect(output).toContain('1 unavailable');
});

test('an unchanged install still runs cutover recheck when the layout needs journal adoption', async () => {
  const f = await fixture(); const cutover = vi.spyOn(f.parts, 'cutover'); await setupHerdr(f.request, f.parts);
  expect(cutover).toHaveBeenCalledTimes(1);
  const preflight = f.parts.preflight;
  f.parts.preflight = async request => ({ ...await preflight(request), cutoverNeedsRecheck: true });
  await setupHerdr(f.request, f.parts);
  expect(cutover).toHaveBeenCalledTimes(2);
  f.parts.preflight = preflight; await setupHerdr(f.request, f.parts);
  expect(cutover).toHaveBeenCalledTimes(2);
  expect(f.cutovers()).toBe(1);
});
