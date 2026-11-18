// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { doctorHerdr, type DoctorItem, type DoctorParts } from '../../../herdr/src/setup/doctor.js';
import type { SetupRequest } from '../../../herdr/src/setup/installer.js';
import { HerdrLabelContract, type Owner } from '../../../herdr/src/contracts.js';
import { createTerminalRegistry } from '../../../herdr/src/sessions/registry.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { PANE_ENTRY_MODS } from '../../../herdr/src/setup/pane-assets.js';
import * as children from '../../../herdr/assets/agents/children.js';
import { FEED_DISCONNECT_MS } from '../../../herdr/assets/shared/feed.js';
import { projectPanePresentations } from '../../../herdr/assets/shared/presentations.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) =>
    args[0] === '/fixture/version' ? 'herdr-app 0.1.16\n' : actual.execFileSync(...args) };
});
const roots: string[] = [];
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'doctor-independent-')); roots.push(root);
  const appHome = join(root, 'app'), agentDirectory = join(root, 'agent'), globalRoot = join(root, 'global');
  for (const directory of [appHome, agentDirectory, globalRoot]) await mkdir(directory, { mode: 0o700 });
  const packageRoot = resolve('.');
  await writeFile(join(root, 'core.toml'), 'notes = false\n');
  const config = parseHerdrConfig({ app: { binary: '/fixture/version', home: appHome }, core: { binary: process.execPath, config: join(root, 'core.toml') }, agentDirectory, globalRoot, shellRc: join(root, 'shellrc'), spaces: [], machines: [] });
  const request: SetupRequest = { config, packageRoot, configPath: join(root, 'config.json'), journalRoot: join(root, 'journal') };
  const ports = createProductionHerdrCliPorts(packageRoot, { ...process.env, SPIDER_GLOBAL_ROOT: globalRoot });
  disposals.push(() => ports.dispose());
  const parts = await ports.doctorParts(request);
  const report = async (items: DoctorItem[]) => {
    const doctor: DoctorParts = { ...parts, inspect: (...args) => items.includes(args[0]) ? parts.inspect(...args) : Promise.resolve({ failures: [] }), targets: async () => [], launchHistory: async () => [], probeRuntimeRoot: undefined };
    return doctorHerdr(request, doctor);
  };
  const owner = async (session: string) => {
    const value = { sessionId: session, generation: 'generation', terminal: { coreId: 'core', terminalId: session, address: session, socket: join(root, 'core.sock'), sessionNamespace: 'fixture' }, cwd: root, name: null, sessionFile: null } as Owner;
    await createTerminalRegistry(join(globalRoot, 'herdr')).record({ owner: value, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory, extensionArguments: [] } });
  };
  return { root, appHome, globalRoot, packageRoot, request, ports, parts, report, owner };
}

const feedItems: DoctorItem[] = ['feed-permissions', 'feed-freshness', 'ipc-authentication'];
test('missing owner feeds are classified per owner and do not hide other stale feeds', async () => {
  const f = await fixture();
  await f.owner('missing'); await f.owner('malformed');
  const directory = join(f.globalRoot, 'herdr/sessions/malformed');
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'session.json'), '{}');
  const report = await f.report(feedItems);
  for (const item of feedItems) {
    const failures = report.failures.filter(failure => failure.item === item);
    expect(failures).toHaveLength(2);
    expect(failures).toContainEqual(expect.objectContaining({ code: 'feed-stale', message: expect.stringContaining('missing') }));
    expect(failures).toContainEqual(expect.objectContaining({ code: 'feed-stale', message: expect.stringContaining('malformed') }));
    expect(failures).not.toContainEqual(expect.objectContaining({ code: 'doctor-inspection-failed' }));
  }
  const unreadable = await fixture(); await unreadable.owner('bad-read');
  await mkdir(join(unreadable.globalRoot, 'herdr/sessions/bad-read/session.json'), { recursive: true });
  const failed = await unreadable.report(feedItems);
  for (const item of feedItems) expect(failed.failures).toContainEqual(expect.objectContaining({ item, code: 'doctor-inspection-failed' }));
});

test('0.1.16 generated navigation keeps native remote actions until a snapshot is available', async () => {
  const f = await fixture();
  const stock = join(f.packageRoot, 'packages/herdr/src/__tests__/fixtures/herdr-0.1.16');
  await cp(join(stock, 'mods'), join(f.appHome, 'mods'), { recursive: true });
  await mkdir(join(f.appHome, 'layouts')); await cp(join(stock, 'layouts/main.json'), join(f.appHome, 'layouts/main.json'));
  const names = ['agents', 'spaces', 'pane', 'tabs', 'panel', 'chrome', 'picker', ...PANE_ENTRY_MODS.map(name => name.slice('spider-'.length)), 'menu', 'new-menu', 'toast'];
  const modProps = [...new Set(names)].map(name => ({ directory: join(f.appHome, 'mods', `spider-${name}`), props: { modId: `spider-${name}`, feedRoot: join(f.globalRoot, 'herdr'), cliPath: join(f.root, 'cli'), nodePath: process.execPath, appBinary: '/fixture/version', configPath: f.request.configPath, labelContract: HerdrLabelContract } }));
  const setup = await f.ports.setupParts(f.request);
  const files = await setup.stageLook(f.request, { labelContract: HerdrLabelContract, installed: {}, retiredTerminals: [], priorCutover: null, recordCutover: async () => {}, modProps }, 'export');
  const navigationBytes = files.find(file => file.path === join(f.appHome, 'mods/spider-agents/shared/navigation.js'))!.bytes;
  for (const name of ['panel', 'picker']) expect(files.find(file => file.path === join(f.appHome, `mods/spider-${name}/shared/navigation.js`))!.bytes).toEqual(navigationBytes);
  const source = navigationBytes.toString('utf8').replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)*import .*;\s*$/gm, '').replaceAll('export function ', 'function ');
  const project = new Function('filterTopLevelAgents', 'projectAgentChildren', 'FEED_DISCONNECT_MS', 'projectPanePresentations', `${source}; return projectNavigation;`)(children.filterTopLevelAgents, children.projectAgentChildren, FEED_DISCONNECT_MS, projectPanePresentations);
  const id = 'parked-one', generation = 'gen-one', address = 'box-1.invalid/owner';
  const owner = { sessionId: id, generation, name: 'Parked', cwd: '/home/fixture', terminal: { address, coreId: 'core-1', terminalId: 'owner' } };
  const feed = { sessionId: id, generation, owner, lifecycle: 'live', updatedAt: Date.now(), status: { effective: 'idle' }, runs: { rows: [], total: 0, truncated: false }, ipc: { address: 'endpoint', capabilityFile: 'cap' }, placement: null };
  const snapshot = { coreId: 'local-core', now: Date.now(), destination: { space: 's1', tab: 'tab' }, contract: HerdrLabelContract, agents: [], terminals: [{ address, state: 'live', status: 'idle', labels: { 'spider.session': id } }], panes: [], spaces: [], machines: [{ name: 'box-1.invalid', coreId: 'core-1', layout: 'ready' }], feeds: [feed], includeChildren: false };
  const native = project(snapshot).find((row: any) => row.sessionId === id);
  expect.soft(native.action).toMatchObject({ kind: 'ipc', descriptor: { sessionId: id, generation }, request: { op: 'openSession', generation, destination: { space: 's1', tab: 'tab' } } });
  const plainAddress = 'box-1.invalid/plain';
  const plain = project({ ...snapshot, feeds: [], agents: [{ address: plainAddress, pane: 'native-pane', space: 's1', tab: 'tab', title: 'Native', program: { name: 'pi' }, status: 'idle' }], terminals: [{ address: plainAddress, state: 'live', status: 'idle', labels: {} }] }).find((row: any) => row.terminal === plainAddress);
  expect.soft(plain.action).toEqual({ kind: 'focus', pane: 'native-pane' });
  const viewerAddress = 'box-1.invalid/viewer';
  const child = project({ ...snapshot, includeChildren: true, terminals: [...snapshot.terminals, { address: viewerAddress, parent: address, state: 'live', status: 'idle', labels: { 'spider.session': id, 'spider.kind': 'subagent-viewer', 'spider.run': 'run-one' } }], panes: [{ terminal: viewerAddress, pane: 'viewer-pane', tab: 'tab' }] }).find((row: any) => row.id === `run:${id}:run-one`);
  expect.soft(child.action).toEqual({ kind: 'focus', pane: 'viewer-pane' });
  const target = { coreId: 'core-1', terminalId: 'owner', address, createdMs: 42, identityLabels: {}, alias: 'box-1.invalid', machineId: 'machine-1', kind: 'session', sessionId: id, generation, homeEpoch: 1, runId: null, consoleId: null, name: 'Parked', cwd: '/home/fixture' };
  const service = { version: 1, kind: 'snapshot', complete: true, omittedRows: 0, rows: [{ sessionId: id, generation, owner: { terminal: { address } }, target, name: 'Parked', status: 'idle', machineKey: 'box-1.invalid', children: [], consoles: [], unavailableReason: null }], presentations: [] };
  const projected = project({ ...snapshot, paneSnapshot: service }).find((row: any) => row.sessionId === id);
  expect(projected.action).toMatchObject({ kind: 'pane', request: { op: 'open-existing', sessionId: id, generation } });
});

test('insecure picker configuration does not hide clone or patch version failures', async () => {
  const f = await fixture();
  const stock = join(f.packageRoot, 'packages/herdr/src/__tests__/fixtures/herdr-0.1.16');
  await cp(join(stock, 'mods'), join(f.appHome, 'mods'), { recursive: true });
  await mkdir(join(f.appHome, 'layouts')); await cp(join(stock, 'layouts/main.json'), join(f.appHome, 'layouts/main.json'));
  const picker = join(f.appHome, 'mods/spider-picker'); await mkdir(picker); await writeFile(join(picker, 'config.json'), '{}'); await chmod(join(picker, 'config.json'), 0o644);
  const agents = join(f.appHome, 'mods/spider-agents'); await mkdir(agents);
  await writeFile(join(agents, 'mod.json'), JSON.stringify({ clonedFrom: { name: 'agents', version: '0.1.13' }, patchState: { version: 1 } }));
  const setup = await f.ports.setupParts(f.request);
  await expect(setup.stageLook(f.request, {
    labelContract: HerdrLabelContract, installed: {}, retiredTerminals: [], priorCutover: null, recordCutover: async () => {},
    modProps: [{ directory: picker, props: { modId: 'spider-picker', feedRoot: join(f.globalRoot, 'herdr'), cliPath: join(f.root, 'cli'), nodePath: process.execPath, appBinary: '/fixture/version', configPath: f.request.configPath, labelContract: HerdrLabelContract } }],
  }, 'export')).rejects.toMatchObject({ code: 'picker-config-insecure' });
  const report = await f.report(['mods', 'clones', 'patch-version']);
  expect(report.failures).toContainEqual(expect.objectContaining({ item: 'mods', code: 'picker-config-insecure' }));
  expect(report.failures).toContainEqual(expect.objectContaining({ item: 'clones', code: 'installed-artifact-changed' }));
  expect(report.failures).toContainEqual(expect.objectContaining({ item: 'patch-version', code: 'upstream-version-mismatch' }));
  expect(report.failures.filter(failure => ['mods', 'clones', 'patch-version'].includes(failure.item))).not.toContainEqual(expect.objectContaining({ code: 'doctor-inspection-failed' }));
});
