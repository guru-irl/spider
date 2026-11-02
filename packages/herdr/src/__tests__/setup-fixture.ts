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

export const realFs: typeof fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const fixtures: HerdrHarness[] = [];
export function registerSetupCleanup(): void {
  afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.mocked(fs.readFile).mockImplementation(realFs.readFile); vi.mocked(fs.rename).mockImplementation(realFs.rename); vi.mocked(fs.open).mockImplementation(realFs.open); vi.mocked(fs.unlink).mockImplementation(realFs.unlink); for (const h of fixtures.splice(0)) {
  await h.close();
  expect(await h.remainingOwnedResources()).toEqual([]);
} });
}
export const hash: (bytes: Buffer) => string = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function fixture(mode: 'fake' | 'hc' = 'fake'): Promise<{
    h: HerdrHarness;
    request: SetupRequest;
    parts: SetupParts;
    doctorParts: DoctorParts;
    inspections: string;
    paths: {
        feed: string;
        projection: string;
        font: string;
        layout: string;
        spider: string;
        agents: string;
        children: string;
        machines: string;
        props: string;
        template: string;
    };
    settings: string;
    notes: string;
    modes: string[];
    warnings: string[];
    launches: import("../contracts.js").HcRunRequest[];
    bootstraps: string[];
    cutovers: () => number;
    setTarget: (change: Partial<{
        machine: MachineName;
        nodePath: string;
        coreStartedAt: string;
    }>) => void;
    setVersion: (v: string) => void;
}> {
  const h = await createHerdrHarness(mode);
  fixtures.push(h);
  await h.start();
  const settings = join(h.directories.agent, 'settings.json');
  const notes = join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml');
  await writeFile(settings, '{"theme":"stock","unrelated":"keep"}\n');
  await writeFile(notes, 'notes = true\nzoom = 2\n[other]\nnotes = true\n');
  const request: SetupRequest = { config: parseHerdrConfig({
      app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: notes },
      agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'),
      spaces: [], machines: [{ name: 'remote.invalid', nodePath: '/usr/bin/node', runtime: { directory: h.directories.remote, cwd: null, commands: {} } }]
    }), configPath: join(h.root, 'user.json'), packageRoot: h.root, journalRoot: join(h.directories.global, 'setup') };
  const paths = {
    feed: join(h.root, 'source-feed.js'), projection: join(h.root, 'source-children.js'),
    font: join(h.directories.app, 'fonts/body.ttf'), layout: join(h.directories.app, 'layouts/spider-glass.json'),
    spider: join(h.directories.app, 'mods/spider/shared/feed.js'), agents: join(h.directories.app, 'mods/agents/shared/feed.js'),
    children: join(h.directories.app, 'mods/agents/spider-children.js'), machines: join(h.directories.app, 'mods/machines/shared/feed.js'),
    props: join(h.directories.app, 'props.json'), template: join(dirname(notes), 'templates/worker.md')
  };
  await writeFile(paths.feed, await readFile(new URL('../../assets/shared/feed.js', import.meta.url)));
  await writeFile(paths.projection, 'export const children = [];\n');
  const fresh = async (path: string, bytes: Buffer | string, context: {
    installed: Readonly<Record<string, string>>;
  }, collision?: 'clone' | 'key'): Promise<InstallFile> => ({
    path, bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), expected: context.installed[path] ?? null, collision
  });
  let cutovers = 0;
  const modes: string[] = [];
  const bootstraps: string[] = [];
  const warnings: string[] = [];
  const launches: Parameters<SetupParts['probeMachineNode']>[1][] = [];
  let target = { machine: 'remote.invalid' as MachineName, nodePath: request.config.machines[0].nodePath ?? 'node', coreStartedAt: 'core-start-1' };
  let version = 'v22.19.0';
  // Uncomposed feature inspectors are external ports. Their fixture results are explicit files,
  // not claims that the status, IPC, mods or session producers have passed real acceptance.
  const inspections = join(h.root, 'inspections');
  await mkdir(inspections);
  for (const item of DOCTOR_ITEMS)
    await writeFile(join(inspections, item + '.json'), JSON.stringify({ failures: [] }));
  const doctorParts: DoctorParts = {
    targets: async () => [target],
    inspect: async (item) => JSON.parse(await readFile(join(inspections, item + '.json'), 'utf8')) as {
      failures: DoctorFailure[];
      warnings?: DoctorFailure[];
    },
    launchHistory: async () => h.calls(),
    probeMachineNode: async (_t, launch) => {
      launches.push(launch);
      if (mode === 'fake') {
        await h.hc.run(launch);
        return version;
      }
      const events = h.hc.events();
      await events.ready;
      const terminal = await h.hc.run(launch);
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => { unsubscribe(); reject(new Error('Visible Node probe did not finish')); }, 5000);
        const check = async () => {
          try {
            if ((await events.lookup(terminal.address))?.state === 'finished') {
              clearTimeout(timer);
              unsubscribe();
              done();
            }
          }
          catch (error) {
            clearTimeout(timer);
            unsubscribe();
            reject(error);
          }
        };
        const unsubscribe = events.subscribe(() => { void check(); });
        void check();
      });
      const screen = await h.hc.read(terminal.address, { lines: 10 });
      const observed = /\bv\d+\.\d+\.\d+\b/.exec(screen)?.[0];
      if (!observed)
        throw new Error('Visible Node probe has no version in its actual terminal screen');
      return observed;
    },
  };
  const parts: SetupParts = {
    preflight: async () => ({ fingerprint: 'assets-1', coreIdentity: h.owner!.terminal, mods: ['spider', 'machines', 'agents', 'spaces', 'pane'].map(name => ({ directory: join(request.config.app.home, 'mods', name) })), targets: [target], retiredTerminals: [h.owner!.terminal.address], layoutExport: true }),
    stageLook: async (_, c, mode) => { modes.push(mode); return [await fresh(paths.font, 'font-data', c), await fresh(paths.layout, '{"name":"spider-glass"}', c, 'clone')]; },
    installFiles: async (_, c) => {
      const files = await Promise.all([paths.spider, paths.agents, paths.machines].map(async (path) => fresh(path, await readFile(paths.feed), c)));
      files.push(await fresh(paths.children, await readFile(paths.projection), c), await fresh(paths.props, JSON.stringify({ feedRoot: request.config.globalRoot, cli: join(request.packageRoot, 'dist/herdr/cli.mjs'), nodePath: h.nodeBinary, config: request.configPath, labelContract: c.labelContract, mods: c.modProps }), c));
      for (const mod of c.modProps)
        files.push(await fresh(join(mod.directory, 'props.json'), JSON.stringify(mod.props), c));
      return files;
    },
    generateTemplates: async (_, c) => [await fresh(paths.template, '---\ncommand: pi\n---\n', c)],
    installResume: async (_, c) => [await fresh(request.config.shellRc, '# BEGIN spider resume\n# END spider resume\n', c)],
    probeMachineNode: doctorParts.probeMachineNode,
    ensureRuntime: async () => [{ machine: target.machine, path: h.directories.remote + '/runtime-v1.mjs', bytes: Buffer.from('runtime-v1'), sha256: hash(Buffer.from('runtime-v1')) }],
    bootstrapRuntime: async () => { bootstraps.push('bootstrap'); },
    hc: h.hc,
    cutover: async (_, c): Promise<CutoverResult> => {
      expect(await readFile(paths.font, 'utf8')).toBe('font-data');
      expect(await readFile(notes, 'utf8')).toContain('notes = false');
      expect(c.retiredTerminals).toEqual([h.owner!.terminal.address]);
      if (c.priorCutover) {
        for (const address of c.priorCutover.terminals)
          expect((await h.hc.get(address)).state).toBe('live');
        return c.priorCutover;
      }
      cutovers++;
      if (mode === 'fake') {
        await h.app.command('layout.switch', { name: 'spider-glass' });
        await h.app.command('app.theme', { name: 'spider-glass' });
      }
      const terminal = await h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: h.root, labels: {}, background: true, outliveParent: true, noNotify: true });
      return { terminals: [terminal.address], identities: { space: 'space-1', tab: 'tab-1' } };
    },
    verify: async () => doctorHerdr(request, { ...doctorParts, cachedNodeObservations: async () => (await readJournal(request.journalRoot)).probes }),
    rollback: async (result) => { for (const address of result.terminals) {
      await h.hc.kill(address);
      await h.hc.rm(address);
    } },
    warn: message => warnings.push(message),
  };
  return { h, request, parts, doctorParts, inspections, paths, settings, notes, modes, warnings, launches, bootstraps, cutovers: () => cutovers,
    setTarget: (change: Partial<typeof target>) => { target = { ...target, ...change }; if (change.nodePath)
      request.config.machines[0].nodePath = change.nodePath; }, setVersion: (v: string) => { version = v; } };
}
