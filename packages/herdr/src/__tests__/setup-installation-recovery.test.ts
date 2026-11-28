// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readPlacementRepairs, writePlacementRepair } from '../jobs/placement-repairs.js';
import * as fs from 'node:fs/promises';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { type MachineName, panelIpcArgv, type IpcDescriptor, type SessionIpcRequest } from '../contracts.js';
import { setupHerdr, rollbackHerdr } from '../setup/installer.js';
import { doctorHerdr } from '../setup/doctor.js';
import { runHerdrCli, type HerdrCliPorts } from '../setup/cli.js';
import { readJournal, withSetupLock } from '../setup/backup.js';
import { fixture as processFixture, hash, realFs, registerSetupCleanup } from './setup-fixture.js';
import { createInProcessHerdrHarness } from './setup-inprocess-harness.js';

const fixture = () => processFixture('fake', createInProcessHerdrHarness);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, chmod: vi.fn(actual.chmod), readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename), open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});
registerSetupCleanup();

test('an uncertain cutover failure blocks retry rather than reopening a session with an unrecorded owner', async () => {
  const f = await processFixture();
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
  await mkdir(dirname(f.paths.spider), { recursive: true });
  await writeFile(f.paths.spider, 'local-clone');
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'unowned-clone-collision' });
  expect(await readFile(f.paths.spider, 'utf8')).toBe('local-clone');
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
  const f = await processFixture();
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
  const f = await processFixture();
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
  const f = await processFixture('hc');
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

test('a standalone picker receives validated installed-mod properties', async () => {
  const f = await fixture(), preflight = f.parts.preflight;
  const directory = join(f.request.config.app.home, 'mods/spider-picker');
  f.parts.preflight = async request => { const result = await preflight(request); return { ...result, mods: [...result.mods, { directory }] }; };
  const installFiles = f.parts.installFiles;
  f.parts.installFiles = async (request, context) => [...await installFiles(request, context), { path: join(directory, 'mod.json'), expected: null, bytes: Buffer.from('{"place":"none"}') }];
  await setupHerdr(f.request, f.parts);
  const props = JSON.parse(await readFile(join(directory, 'props.json'), 'utf8'));
  expect(props.modId).toBe('spider-picker');
  for (const name of ['feedRoot', 'cliPath', 'nodePath', 'appBinary', 'configPath']) expect(isAbsolute(props[name]), name).toBe(true);
  expect(props.labelContract).toMatchObject({ version: 1 });
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


test('doctor reports a durable failed pane repair after the actor exits', async () => {
  const f = await fixture();
  await writePlacementRepair(join(f.request.config.globalRoot, 'herdr/panes'), {
    viewer: 'viewer' as never, app: 'fixture', coreId: 'core', anchor: { space: 'space', tab: 'tab', pane: 'foreign-pane' } as never, error: 'park-refused',
  });
  const report = await doctorHerdr(f.request, f.doctorParts);
  expect(report.failures).toContainEqual(expect.objectContaining({ item: 'pane-repairs', code: 'pane-repair-pending', message: expect.stringContaining('foreign-pane') }));
});


test.each(['gone', 'moved', 'app changed', 'core changed'] as const)('doctor clears a pane repair when its viewer is %s', async state => {
  const f = await fixture(), root = join(f.request.config.globalRoot, 'herdr/panes');
  const placed = { space: 'space', tab: 'tab', pane: 'wrong-pane' } as never;
  await writePlacementRepair(root, { viewer: 'viewer' as never, app: 'fixture', coreId: 'core', anchor: { space: 'space', tab: 'tab', pane: 'owner-pane' } as never, placed, error: 'park-refused' });
  const report = await doctorHerdr(f.request, { ...f.doctorParts, placementRepairInspection: async () => ({
    app: state === 'app changed' ? 'new-app' : 'fixture', coreId: state === 'core changed' ? 'new-core' : 'core',
    placement: async () => state === 'gone' ? null : state === 'moved' ? { space: 'space', tab: 'tab', pane: 'safe-pane' } as never : placed,
  }) });
  expect(report.failures.filter(failure => failure.item === 'pane-repairs')).toEqual([]);
  expect(await readPlacementRepairs(root)).toEqual([]);
});

test('doctor names the exact pending repair file and explains how to clear it', async () => {
  const f = await fixture(), root = join(f.request.config.globalRoot, 'herdr/panes');
  await writePlacementRepair(root, { viewer: 'viewer' as never, app: 'fixture', coreId: 'core', anchor: { space: 'space', tab: 'tab', pane: 'owner-pane' } as never, placed: { space: 'space', tab: 'tab', pane: 'wrong-pane' } as never, error: 'park-refused' });
  const [name] = await fs.readdir(join(root, 'repairs'));
  const report = await doctorHerdr(f.request, { ...f.doctorParts, placementRepairInspection: async () => ({ app: 'fixture', coreId: 'core', placement: async () => ({ space: 'space', tab: 'tab', pane: 'wrong-pane' } as never) }) });
  expect(report.failures.find(failure => failure.code === 'pane-repair-pending')?.repair).toContain(join(root, 'repairs', name));
  expect(report.failures.find(failure => failure.code === 'pane-repair-pending')?.repair).toContain('rerun doctor');
  expect(await readPlacementRepairs(root)).toHaveLength(1);
});


test.each(['identity', 'placement'])('doctor names every repair file when %s inspection fails', async stage => {
  const f = await fixture(), root = join(f.request.config.globalRoot, 'herdr/panes');
  for (const viewer of ['viewer-one', 'viewer-two']) await writePlacementRepair(root, { viewer: viewer as never, app: 'fixture', coreId: 'core', anchor: { space: 'space', tab: 'tab', pane: 'owner-pane' } as never, error: 'park-refused' });
  const names = await fs.readdir(join(root, 'repairs'));
  const report = await doctorHerdr(f.request, { ...f.doctorParts, placementRepairInspection: async () => {
    if (stage === 'identity') throw new Error('Core unavailable');
    return { app: 'fixture', coreId: 'core', placement: async () => { throw new Error('App unavailable'); } };
  } });
  const failure = report.failures.find(value => value.code === 'pane-repair-inspection-failed');
  expect(failure).toBeDefined();
  for (const name of names) expect(failure?.repair).toContain(join(root, 'repairs', name));
  expect(failure?.repair).toContain('rerun doctor');
  expect(await readPlacementRepairs(root)).toHaveLength(2);
});

test('doctor does not inspect app or core placement when no repair record exists', async () => {
  const f = await fixture();
  const report = await doctorHerdr(f.request, { ...f.doctorParts, placementRepairInspection: async () => { throw new Error('No repair needs inspection'); } });
  expect(report.failures.filter(failure => failure.item === 'pane-repairs')).toEqual([]);
});

const sectionKeys = {
  global: { 'cmd-p': 'mod.open:spider-picker', 'cmd-n': { command: 'space.new', args: { machine: '' } }, 'cmd-t': 'mod.open:spider-machine-picker', 'cmd-d': 'mod.open:spider-machine-picker-right', 'cmd-shift-d': 'mod.open:spider-machine-picker-down' },
  'layout:Spider': { 'cmd-shift-e': 'spider-pane.park', 'cmd-shift-w': 'spider-pane.close' },
} as const;
const legacyTerminalKeys = { 'cmd-shift-a': 'send:\u001b[97;6u' };

test('setup refuses absent native keys before any other installation changes', async () => {
  const f = await fixture(), path = join(f.request.config.app.home, 'keys.json');
  await writeFile(path, JSON.stringify({ global: { 'cmd-shift-w': 'pane.close' }, terminal: { 'ctrl-v': 'terminal.paste_image' } }));
  await fs.unlink(path);
  const originalSettings = await readFile(f.settings);
  const original = f.parts.installFiles;
  f.parts.installFiles = async (r, c) => [...await original(r, c), { path, expected: null, bytes: Buffer.alloc(0), terminalKeys: legacyTerminalKeys, keys: sectionKeys }];
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'keys-defaults-missing', message: 'Open Herdr once so it creates its default key map, then rerun setup.' });
  expect(await realFs.stat(path).then(() => true, () => false)).toBe(false);
  expect(await readFile(f.settings)).toEqual(originalSettings);
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
  expect(f.cutovers()).toBe(0);
});

test('setup composes legacy and section keys in one write and records ownership', async () => {
  const f = await fixture(), path = join(f.request.config.app.home, 'keys.json');
  await writeFile(path, JSON.stringify({ global: { 'cmd-p': 'mod.open:picker', 'cmd-n': 'space.new', 'cmd-shift-w': 'pane.close' }, terminal: { 'ctrl-v': 'terminal.paste_image' } }));
  const original = f.parts.installFiles;
  f.parts.installFiles = async (r, c) => [...await original(r, c), { path, expected: hash(await readFile(path)), bytes: Buffer.alloc(0), terminalKeys: legacyTerminalKeys, keys: sectionKeys }];
  const first = await setupHerdr(f.request, f.parts);
  expect(first.writes.filter(p => p === path)).toEqual([path]);
  const keys = JSON.parse(await readFile(path, 'utf8'));
  expect(keys.global).toEqual({ ...sectionKeys.global, 'cmd-shift-w': 'pane.close' });
  expect(keys['layout:Spider']['cmd-shift-w']).toBe('spider-pane.close');
  expect(keys.terminal).toEqual({ 'ctrl-v': 'terminal.paste_image', 'cmd-shift-a': legacyTerminalKeys['cmd-shift-a'] });
  expect(keys['layout:Spider']['cmd-shift-e']).toBe('spider-pane.park');
  const saved = await readJournal(f.request.journalRoot);
  expect(saved.entries.find(entry => entry.path === path)).toMatchObject({ keys: { ...sectionKeys, terminal: legacyTerminalKeys }, managed: { kind: 'keys' } });
  expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
});

test.each([
  { global: { 'cmd-p': 'foreign.picker' } },
  { global: { 'cmd-shift-e': 'foreign.action' } },
  { terminal: { 'cmd-shift-e': 'foreign.action' } },
  { global: { 'cmd-shift-w': 'terminal.park' } },
])('setup refuses a conflicting key before backup or cutover', async initial => {
  const f = await fixture(), path = join(f.request.config.app.home, 'keys.json');
  await writeFile(path, JSON.stringify(initial));
  const original = f.parts.installFiles;
  f.parts.installFiles = async (r, c) => [...await original(r, c), { path, expected: hash(await readFile(path)), bytes: Buffer.alloc(0), terminalKeys: legacyTerminalKeys, keys: sectionKeys }];
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'key-binding-conflict' });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(initial);
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
  expect(f.cutovers()).toBe(0);
});

test('setup migrates a journal with terminalKeys only and retains its earlier baseline', async () => {
  const f = await fixture(), path = join(f.request.config.app.home, 'keys.json');
  await writeFile(path, JSON.stringify({ global: { 'cmd-shift-w': 'pane.close' }, terminal: { 'ctrl-v': 'terminal.paste_image', 'cmd-shift-a': 'previous.action' } }));
  const original = f.parts.installFiles;
  f.parts.installFiles = async (r, c) => [...await original(r, c), { path, expected: hash(await readFile(path)), bytes: Buffer.alloc(0), terminalKeys: legacyTerminalKeys }];
  await setupHerdr({ ...f.request, overwriteUnownedKeys: true }, f.parts);
  const legacy = await readJournal(f.request.journalRoot), entry = legacy.entries.find(item => item.path === path)!;
  delete entry.managed; delete entry.managedAfter;
  await (await import('../setup/backup.js')).saveJournal(f.request.journalRoot, legacy);
  const current = JSON.parse(await readFile(path, 'utf8'));
  current.global['cmd-p'] = 'mod.open:picker';
  current.global['cmd-n'] = 'space.new';
  await writeFile(path, JSON.stringify(current));
  f.parts.installFiles = async (r, c) => [...await original(r, c), { path, expected: hash(await readFile(path)), bytes: Buffer.alloc(0), terminalKeys: legacyTerminalKeys, keys: sectionKeys }];
  await setupHerdr(f.request, f.parts);
  expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
  await rollbackHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ global: { 'cmd-shift-w': 'pane.close', 'cmd-p': 'mod.open:picker', 'cmd-n': 'space.new' }, terminal: { 'ctrl-v': 'terminal.paste_image', 'cmd-shift-a': 'previous.action' } });
});
