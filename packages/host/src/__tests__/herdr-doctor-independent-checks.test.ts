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
