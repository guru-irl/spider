// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, readFile, writeFile, readdir, chmod, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { doctorHerdr } from '../../../herdr/src/setup/doctor.js';
import { createJobStore } from '../../../herdr/src/jobs/store.js';
import { monitorFixture, on, program } from '../../../herdr/src/__tests__/herdr-monitor-fixture.js';
import { cleanup, type SetupFixture } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';
import { editUnrelated, claimCurrentHash } from './herdr-setup-production-helpers.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const offlineFixture = () => focusedSetupFixture({ startCores: false, localOnly: true });
const processFixture = () => focusedSetupFixture({ coreTransport: 'process', localOnly: true });

test('doctor shows terminal cleanup diagnostics without treating automatic retries as warnings', async () => {
  const f = await offlineFixture(), h = await monitorFixture(), jobs = h.monitor();
  await jobs.start(program, h.owner, on, { background: true }); await jobs.shutdown('reload');
  const journal = await createJobStore(h.f.root, h.owner.sessionId).read();
  journal.jobs[0].cleanupFailure = { code: 'machine-unavailable', attempts: 2, firstAt: 1000, lastAt: 31000 };
  const root = join(f.request.config.globalRoot, 'herdr/jobs');
  await createJobStore(root, h.owner.sessionId).write(journal);
  journal.child = { id: 'diagnostic-child' as never, pid: process.pid, startIdentity: 'ended', ended: true, settled: true };
  journal.jobs[0].runId = journal.child.id;
  await createJobStore(root, h.owner.sessionId, journal.child.id).write(journal);
  const result = await (await f.ports.doctorParts(f.request)).inspect('jobs', f.request);
  expect(result.failures).toEqual([]);
  expect(result.warnings ?? []).toEqual([]);
  expect(result.information).toEqual([
    { item: 'jobs', code: 'cleanup-retrying', message: '2 terminals on remote.invalid are waiting for cleanup. Last failure machine-unavailable. Oldest failure at 1000 ms since epoch. Retries run while each owning session is open.' },
  ]);
});

test('doctor reads every job file without changing modes and isolates corrupt journals', async () => {
  const f = await offlineFixture(), h = await monitorFixture(), jobs = h.monitor();
  await jobs.start(program, h.owner, on, { background: true }); await jobs.shutdown('reload');
  const journal = await createJobStore(h.f.root, h.owner.sessionId).read();
  journal.jobs[0].cleanupFailure = { code: 'machine-unavailable', attempts: 2, firstAt: 1000, lastAt: 31000 };
  const root = join(f.request.config.globalRoot, 'herdr/jobs');
  const good = createJobStore(root, h.owner.sessionId), corrupt = createJobStore(root, 'a-corrupt' as never);
  await good.write(journal); await mkdir(corrupt.directory, { recursive: true });
  await writeFile(corrupt.path, '{"private-parser-detail":');
  const empty = join(root, 'sessions/z-empty'); await mkdir(empty, { recursive: true });
  const directories = [good.directory, corrupt.directory, empty];
  for (const directory of directories) await chmod(directory, 0o750);
  const modes = await Promise.all(directories.map(async directory => (await stat(directory)).mode));
  const contents = await Promise.all(directories.map(directory => readdir(directory)));
  const result = await (await f.ports.doctorParts(f.request)).inspect('jobs', f.request);
  expect(result.failures).toEqual([]);
  expect(result.information).toContainEqual({ item: 'jobs', code: 'job-journal-unreadable', message: `Could not read job journal ${corrupt.path}.` });
  expect(result.information?.filter(line => line.code === 'cleanup-retrying')).toHaveLength(1);
  expect(JSON.stringify(result)).not.toMatch(/private-parser-detail|Expected|JSON at position/);
  expect(await Promise.all(directories.map(async directory => (await stat(directory)).mode))).toEqual(modes);
  expect(await Promise.all(directories.map(directory => readdir(directory)))).toEqual(contents);
});

test('doctor job inspection preserves directory permissions when journals are absent', async () => {
  const f = await offlineFixture();
  const directory = join(f.request.config.globalRoot, 'herdr/jobs/sessions/empty');
  await mkdir(directory, { recursive: true }); await chmod(directory, 0o750);
  const mode = (await stat(directory)).mode;
  const result = await (await f.ports.doctorParts(f.request)).inspect('jobs', f.request);
  expect(result.failures).toEqual([]);
  expect((await stat(directory)).mode).toBe(mode);
  expect(await readdir(directory)).toEqual([]);
});

async function addAuditTerminal(f: SetupFixture, address: string, notify: boolean | undefined) {
  const terminal = { address, parent: null, labels: { 'spider.kind': 'subagent-viewer' }, state: 'finished', status: null, exit_code: 0, reason: 'exited', signal: null, finished_ms: 1, ...(notify === undefined ? {} : { notify }) };
  await f.h.emitCore({ type: 'created', seq: 100, terminal: address, data: terminal });
  await vi.waitFor(async () => expect(await f.h.cli(['get', address, '--json'])).toMatchObject(terminal));
  // hc 0.1.17 omits labels and notify from list rows, but keeps them in events.
  await f.h.scenario({ steps: [{ argvPrefix: ['ls'], reply: { terminals: [{ address, agent: 'node', cwd: '/fixture', state: 'finished', turn: 0 }] } }] });
}

test('production doctor reads native notification policy and can reject a launch', async () => {
  const f = await processFixture(); await addAuditTerminal(f, 'unsafe', true);
  try {
    const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
    expect(report.failures).toContainEqual(expect.objectContaining({ item: 'launches', code: 'launch-notify-enabled' }));
    expect(report.warnings).not.toContainEqual(expect.objectContaining({ item: 'launches', code: 'inspection-unavailable' }));
  } finally { await f.h.scenario({}); }
});

test('doctor verifies quiet launches when the core list omits their labels and notification policy', async () => {
  const f = await processFixture(); await addAuditTerminal(f, 'quiet', false);
  try {
    const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
    expect(report.failures).not.toContainEqual(expect.objectContaining({ item: 'launches' }));
    expect(report.warnings).not.toContainEqual(expect.objectContaining({ item: 'launches', code: 'inspection-unavailable' }));
  } finally { await f.h.scenario({}); }
});

test('doctor gives usable advice when a launch has no readable notification policy', async () => {
  const f = await processFixture(); await addAuditTerminal(f, 'unknown', undefined);
  try {
    const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
    expect(report.warnings).toContainEqual(expect.objectContaining({ item: 'launches', code: 'inspection-unavailable', repair: expect.stringMatching(/setup[\s\S]*doctor/i) }));
    expect(report.warnings.find(row => row.item === 'launches')?.repair).not.toMatch(/core version/i);
  } finally { await f.h.scenario({}); }
});

test('production doctor marks unavailable launch evidence unknown', async () => {
  const f = await processFixture();
  const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
  expect(report.warnings).toContainEqual(expect.objectContaining({ item: 'launches', code: 'inspection-unavailable' }));
});

test.each(['layout-theme', 'keys', 'patch-version'] as const)('production doctor checks %s content even if its journal hash matches', async item => {
  const f = await focusedSetupFixture(); await setupHerdr(f.request, f.parts);
  const path = item === 'layout-theme' ? join(f.h.directories.app, 'layouts/Spider.json') : item === 'keys' ? join(f.h.directories.app, 'keys.json') : join(f.h.directories.app, 'mods/spider-agents/mod.json');
  const json = JSON.parse(await readFile(path, 'utf8'));
  if (item === 'layout-theme') json.theme = 'wrong';
  if (item === 'keys') json.terminal['cmd-shift-o'] = 'wrong';
  if (item === 'patch-version') json.clonedFrom.version = '0.0.0';
  await writeFile(path, JSON.stringify(json)); await claimCurrentHash(f, path);
  expect((await (await f.ports.doctorParts(f.request)).inspect(item, f.request)).failures.length).toBeGreaterThan(0);
});

test('setup stages the tab strip and doctor accepts its resting size', async () => {
  const f = await focusedSetupFixture();
  await writeFile(join(f.h.directories.app, 'layouts/main.json'), await readFile(resolve('packages/herdr/src/__tests__/fixtures/herdr-0.1.12/layouts/main.json')));
  await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.app, 'layouts/Spider.json');
  const layout = JSON.parse(await readFile(path, 'utf8'));
  const nodes = (node: any): any[] => [node, ...(node.children ?? []).flatMap(nodes)];
  expect(nodes(layout).find(node => node.id === 'tabs')).toMatchObject({ size: { px: 6 }, window_drag: true, content: { props: { autoHideTabs: true } } });
  expect((await (await f.ports.doctorParts(f.request)).inspect('layout-theme', f.request)).failures).toEqual([]);
});

test('setup forwards the tab opt-out and doctor rejects the opposite setting', async () => {
  const f = await focusedSetupFixture();
  f.request.config.look = { autoHideTabs: false };
  await writeFile(join(f.h.directories.app, 'layouts/main.json'), await readFile(resolve('packages/herdr/src/__tests__/fixtures/herdr-0.1.12/layouts/main.json')));
  await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.app, 'layouts/Spider.json');
  const layout = JSON.parse(await readFile(path, 'utf8'));
  const nodes = (node: any): any[] => [node, ...(node.children ?? []).flatMap(nodes)];
  expect(nodes(layout).find(node => node.id === 'tabs')).toMatchObject({ size: { px: 42 }, content: { props: { autoHideTabs: false } } });
  expect((await (await f.ports.doctorParts(f.request)).inspect('layout-theme', f.request)).failures).toEqual([]);
  nodes(layout).find(node => node.id === 'tabs').content.props.autoHideTabs = true;
  await writeFile(path, JSON.stringify(layout));
  expect((await (await f.ports.doctorParts(f.request)).inspect('layout-theme', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'layout-props-mismatch' }));
});

test('production doctor accepts folded sidebar blocks', async () => {
  const f = await focusedSetupFixture();
  await writeFile(join(f.h.directories.app, 'layouts/main.json'), await readFile(resolve('packages/herdr/src/__tests__/fixtures/herdr-0.1.12/layouts/main.json')));
  await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.app, 'layouts/Spider.json');
  const layout = JSON.parse(await readFile(path, 'utf8'));
  const found: string[] = [];
  const visit = (node: any) => {
    if (['brand', 'agents', 'sidebar-footer'].includes(node.id)) { node.hidden = true; found.push(node.id); }
    for (const child of node.children ?? []) visit(child);
  };
  visit(layout);
  expect(found.sort()).toEqual(['agents', 'brand', 'sidebar-footer']);
  await writeFile(path, JSON.stringify(layout));
  expect((await (await f.ports.doctorParts(f.request)).inspect('layout-theme', f.request)).failures).toEqual([]);
});

test('production doctor rejects a missing sidebar agent block', async () => {
  const f = await focusedSetupFixture();
  await writeFile(join(f.h.directories.app, 'layouts/main.json'), await readFile(resolve('packages/herdr/src/__tests__/fixtures/herdr-0.1.12/layouts/main.json')));
  await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.app, 'layouts/Spider.json');
  const layout = JSON.parse(await readFile(path, 'utf8'));
  const visit = (node: any) => {
    if (!node.children) return;
    node.children = node.children.filter((child: any) => child.id !== 'agents');
    for (const child of node.children) visit(child);
  };
  visit(layout); await writeFile(path, JSON.stringify(layout));
  expect((await (await f.ports.doctorParts(f.request)).inspect('layout-theme', f.request)).failures)
    .toContainEqual(expect.objectContaining({ code: 'layout-mod-mismatch' }));
});

test('production doctor does not confuse unrelated shared edits with seven broken features', async () => {
  const f = await focusedSetupFixture(); await setupHerdr(f.request, f.parts); await editUnrelated(f);
  const parts = await f.ports.doctorParts(f.request);
  for (const item of ['mods', 'clones', 'patch-version', 'layout-theme', 'keys', 'roles', 'resume'] as const) expect((await parts.inspect(item, f.request)).failures).toEqual([]);
});

test('production doctor normalizes pi modifiers and reports tree and editor collisions', async () => {
  const f = await focusedSetupFixture(); await setupHerdr(f.request, f.parts);
  await writeFile(join(f.h.directories.agent, 'keybindings.json'), JSON.stringify({ 'app.tree.filter.cycleBackward': 'shift+ctrl+o', 'app.session.new': 'shift+ctrl+a' }));
  const report = await (await f.ports.doctorParts(f.request)).inspect('keys', f.request);
  expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'tree-view-key-collision', message: expect.stringContaining('ctrl+shift+o') }));
  expect(report.failures).toContainEqual(expect.objectContaining({ code: 'pi-shortcut-collision', message: expect.stringContaining('ctrl+shift+a') }));
});

test('doctor validates the installed pi theme with the actual pi schema', async () => {
  const f = await focusedSetupFixture(); await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.agent, 'themes/dracula-plus-glass.json'), theme = JSON.parse(await readFile(path, 'utf8'));
  delete theme.colors.accent; await writeFile(path, JSON.stringify(theme));
  expect((await (await f.ports.doctorParts(f.request)).inspect('pi-schema-contrast', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'pi-theme-schema' }));
});

test('doctor never passes unresolved role-template inspection', async () => {
  const f = await offlineFixture();
  await writeFile(join(f.h.directories.global, 'config.json'), JSON.stringify({ 'models.defaults': { worker: 'unavailable', reviewer: 'unavailable', watcher: 'unavailable' } }));
  expect((await (await f.ports.doctorParts(f.request)).inspect('roles', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'role-unresolved', repair: expect.stringContaining('Choose an available configured model') }));
});
