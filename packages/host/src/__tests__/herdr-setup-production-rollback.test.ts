import { afterEach, expect, test, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { verifiedHerdrFile } from '../herdr/ports.js';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { doctorHerdr } from '../../../herdr/src/setup/doctor.js';
import { readJournal, saveJournal, digest } from '../../../herdr/src/setup/backup.js';
import { cleanup, fixture } from './herdr-setup-fixture.js';
import { editUnrelated, claimCurrentHash, installedModFiles, startInteractiveShell, installedShells } from './herdr-setup-production-helpers.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

test.skipIf(process.env.SPIDER_HERDR_E2E !== '1')('real isolated production setup preserves edits upgrades and repeats doctor probes without an app window', async () => {
  const f = await fixture('hc', true);
  const first = await setupHerdr(f.request, f.parts);
  expect(first.probes).toHaveLength(1); expect(first.probes[0].version).toBe(process.version);
  const before = await readFile(join(f.request.journalRoot, 'journal.json'));
  expect((await setupHerdr(f.request, f.parts)).probes).toEqual([]);
  expect(await readFile(join(f.request.journalRoot, 'journal.json'))).toEqual(before);
  await editUnrelated(f); await setupHerdr(f.request, f.parts);
  const source = join(f.root, 'packages/herdr/assets/mods/spider/main.js'); await writeFile(source, (await readFile(source, 'utf8')) + '\n// updated artifact\n');
  await writeFile(join(f.root, 'dist/herdr/remote-runtime.mjs'), (await readFile(join(f.root, 'dist/herdr/remote-runtime.mjs'), 'utf8')) + '\n// runtime update\n');
  const upgraded = await setupHerdr(f.request, f.parts);
  expect(upgraded.writes).toContain(join(f.h.directories.app, 'mods/spider-panel/main.js'));
  expect(upgraded.probes).toHaveLength(1);
  const runtime = (await f.parts.ensureRuntime(f.request, f.context))[0];
  expect(await f.parts.hc.fileRead(runtime.machine, runtime.path)).toEqual(runtime.bytes);
  const doctor = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
  expect(doctor.failures).toEqual([]); expect(doctor.probes).toHaveLength(1);
  expect(JSON.parse(await readFile(join(f.h.directories.agent, 'settings.json'), 'utf8')).unrelated).toBe('edited');
  await writeFile(resolve('.spider/scratch/production-real-evidence.json'), JSON.stringify({ localSocket: f.h.localSocket, remoteSocket: f.h.remoteSocket, appHome: f.request.config.app.home, appBinary: f.request.config.app.binary, probes: [first.probes, upgraded.probes, doctor.probes], warnings: doctor.warnings, runtimePath: runtime.path }, null, 2));
  await f.ports.dispose(); await f.h.cli(['machine', 'rm', 'remote.invalid', '--json']);
  await f.h.close();
  cleanup.splice(0);
  expect(await f.h.remainingOwnedResources()).toEqual([]);
  expect(f.h.cleanupProof).toMatchObject({ mode: 'hc', defaultCoreUnchanged: true, remaining: [] });
  await writeFile(resolve('.spider/scratch/production-real-cleanup.json'), JSON.stringify(f.h.cleanupProof, null, 2));
}, 60_000);

test('doctor rejects an older runtime when the current package requires new bytes', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const path = join(f.root, 'dist/herdr/remote-runtime.mjs'); await writeFile(path, (await readFile(path, 'utf8')) + '\n// new runtime\n');
  expect((await (await f.ports.doctorParts(f.request)).inspect('runtime-digest', f.request)).failures.length).toBeGreaterThan(0);
});

test('doctor reports mod loading not verified with fenced headless commands', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const parts = await f.ports.doctorParts(f.request);
  for (const item of ['mods', 'clones'] as const) {
    const report = await parts.inspect(item, f.request);
    expect(report.failures).toEqual([]);
    expect(report.warnings?.length).toBe(item === 'mods' ? 1 : 5);
    for (const warning of report.warnings ?? []) {
      expect(warning.message).toContain('not verified');
      expect(warning.code).toBe('inspection-unavailable');
      expect(warning.repair).toContain(`HERDR_APP_HOME='${join(f.request.journalRoot, 'headless-app-check')}'`);
      expect(warning.repair).toContain(`'${f.request.config.app.binary}' check '${join(f.request.config.app.home, 'mods')}/spider-`);
      expect(warning.repair).not.toContain(`HERDR_APP_HOME='${f.request.config.app.home}'`);
    }
  }
});

test('unrelated multiline TOML edits survive a complete production rerun', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const current = await readFile(f.request.config.core.config, 'utf8');
  const edited = `description = '''
notes = true
[not_a_table]
'''
choices = [
  [1, 2],
  [3, 4]
]
` + current;
  await writeFile(f.request.config.core.config, edited);
  expect((await setupHerdr(f.request, f.parts)).probes).toEqual([]);
  expect(await readFile(f.request.config.core.config, 'utf8')).toBe(edited);
});

test('production setup stages every relative import target in every installed mod', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const missing: string[] = [];
  for (const mod of ['agents', 'spaces', 'pane', 'tabs', 'panel', 'chrome']) {
    const files = await installedModFiles(join(f.h.directories.app, 'mods', `spider-${mod}`));
    for (const file of files.filter(file => file.endsWith('.js'))) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
        if (!files.includes(resolve(dirname(file), match[1]))) missing.push(`${mod}: ${match[1]}`);
      }
    }
  }
  expect(missing).toEqual([]);
  const parts = await f.ports.doctorParts(f.request);
  expect((await parts.inspect('clones', f.request)).failures).toEqual([]);
  await unlink(join(f.h.directories.app, 'mods/spider-agents/spider-children.js'));
  expect((await parts.inspect('clones', f.request)).failures.length).toBeGreaterThan(0);
});

test('production upgrade rollback removes newly installed artifacts and restores user originals', async () => {
  const f = await fixture();
  const settings = join(f.h.directories.agent, 'settings.json'), original = await readFile(settings);
  await setupHerdr(f.request, f.parts);
  const panel = join(f.h.directories.app, 'mods/spider-panel/main.js');
  const source = join(f.root, 'packages/herdr/assets/mods/spider/main.js');
  const before = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === panel)!;
  await writeFile(source, (await readFile(source, 'utf8')) + '\n// next version\n');
  await setupHerdr(f.request, f.parts);
  const after = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === panel)!;
  expect({ before: after.before, backup: after.backup, mode: after.mode }).toEqual({ before: before.before, backup: before.backup, mode: before.mode });
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(panel).then(() => true, () => false)).toBe(false);
  expect(await readFile(settings)).toEqual(original);
});

test('production template refresh retains the original backup for rollback', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const template = (await f.parts.generateTemplates(f.request, f.context))[0].path;
  const original = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === template)!;
  const current = await readFile(template);
  await verifiedHerdrFile(f.request.journalRoot, { path: template, expected: digest(current), bytes: Buffer.concat([current, Buffer.from('\nRefreshed instructions.\n')]) });
  const refreshed = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === template)!;
  expect(refreshed.before).toBe(original.before);
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(template).then(() => true, () => false)).toBe(false);
});

test('a pi save then replan never replaces the original settings backup', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.agent, 'settings.json');
  const original = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === path)!;
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), defaultModel: 'user-choice' }, null, 2));
  await setupHerdr(f.request, f.parts);
  const replanned = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === path)!;
  expect(replanned.before).toBe(original.before);
  expect(replanned.backup).toBe(original.backup);
  await rollbackHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(path, 'utf8')).theme).toBe('stock');
});

test('production rollback reverses only managed parts after unrelated shared edits', async () => {
  const f = await fixture();
  await writeFile(f.request.config.shellRc, 'export ORIGINAL=kept\n');
  await writeFile(f.request.config.core.config, 'notes = true\n[custom]\noriginal = 1\n');
  const keys = join(f.h.directories.app, 'keys.json');
  await writeFile(keys, JSON.stringify({ terminal: { 'cmd-shift-o': 'user.original', 'ctrl-x': 'user.keep' } }));
  f.request.overwriteUnownedKeys = true;
  await setupHerdr(f.request, f.parts); await editUnrelated(f);
  const appSettings = join(f.h.directories.app, 'settings.json');
  await writeFile(appSettings, JSON.stringify({ ...JSON.parse(await readFile(appSettings, 'utf8')), zoom: 2 }));
  const global = join(f.h.directories.global, 'config.json');
  await writeFile(global, JSON.stringify({ ...JSON.parse(await readFile(global, 'utf8')), userChoice: 'keep' }));
  const restored = await rollbackHerdr(f.request, f.parts);
  expect(restored).toContain(f.request.config.shellRc);
  expect(await readFile(f.request.config.shellRc, 'utf8')).toBe('export ORIGINAL=kept\nexport USER_CHOICE=kept\n');
  expect(JSON.parse(await readFile(join(f.h.directories.agent, 'settings.json'), 'utf8'))).toEqual({ theme: 'stock', unrelated: 'edited' });
  expect(JSON.parse(await readFile(appSettings, 'utf8'))).toEqual({ zoom: 2, theme: 'stock' });
  expect(JSON.parse(await readFile(keys, 'utf8'))).toEqual({ terminal: { 'cmd-shift-o': 'user.original', 'ctrl-x': 'user.keep' }, global: { 'ctrl-q': 'user.action' } });
  expect(JSON.parse(await readFile(global, 'utf8'))).toMatchObject({ userChoice: 'keep' });
  expect(JSON.parse(await readFile(global, 'utf8'))['herdr.config']).toBeUndefined();
  expect(await readFile(f.request.config.core.config, 'utf8')).toContain('notes = true');
  expect(await readFile(f.request.config.core.config, 'utf8')).toContain('value = 42');
  expect(await readFile(join(f.h.directories.global, 'herdr/resume.sh')).then(() => true, () => false)).toBe(false);
});

test.each(['resume', 'theme', 'keys'] as const)('rollback preserves dependencies of a user-changed managed %s and reports it', async kind => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const warnings: string[] = []; f.parts.warn = warning => warnings.push(warning);
  let dependency: string;
  if (kind === 'resume') {
    await writeFile(f.request.config.shellRc, (await readFile(f.request.config.shellRc, 'utf8')).replace('. ', '. changed '));
    dependency = join(f.h.directories.global, 'herdr/resume.sh');
  } else if (kind === 'theme') {
    await writeFile(join(f.h.directories.agent, 'settings.json'), '{"theme":"user-theme"}');
    dependency = join(f.h.directories.agent, 'themes/dracula-plus-glass.json');
  } else {
    const path = join(f.h.directories.app, 'keys.json'), keys = JSON.parse(await readFile(path, 'utf8'));
    keys.terminal['cmd-shift-o'] = 'user.action'; await writeFile(path, JSON.stringify(keys));
    dependency = join(f.h.directories.app, 'mods/spider-panel/main.js');
  }
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(dependency).then(() => true, () => false)).toBe(true);
  expect(warnings.some(warning => warning.includes('not restored'))).toBe(true);
});

test.each(installedShells)('a new %s starts silently after production rollback removes the resume hook', async binary => {
  const f = await fixture(); await setupHerdr(f.request, f.parts); await editUnrelated(f);
  await rollbackHerdr(f.request, f.parts);
  const home = join(f.h.root, 'shell-home'); await mkdir(home);
  const rc = await readFile(f.request.config.shellRc);
  await writeFile(join(home, '.bashrc'), rc); await writeFile(join(home, '.zshrc'), rc);
  expect(await startInteractiveShell(binary, home, { ...f.h.localEnv, HC_TERMINAL_ID: 'missing.invalid', HC_TERMINAL_SOCKET: f.h.localSocket })).toEqual({ code: 0, output: '' });
});

test.each(installedShells)('a new %s ignores a missing resume hook or pinned runtime silently', async binary => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const home = join(f.h.root, 'shell-home'); await mkdir(home);
  const rc = await readFile(f.request.config.shellRc, 'utf8'), hook = join(f.h.directories.global, 'herdr/resume.sh');
  const originalHook = await readFile(hook);
  await writeFile(join(home, '.bashrc'), rc); await writeFile(join(home, '.zshrc'), rc);
  await unlink(hook);
  const env = { ...f.h.localEnv, HC_TERMINAL_ID: 'missing.invalid', HC_TERMINAL_SOCKET: f.h.localSocket };
  expect(await startInteractiveShell(binary, home, env)).toEqual({ code: 0, output: '' });
  await writeFile(hook, originalHook);
  const missingRuntimeRc = rc.split(process.execPath).join(join(f.h.root, 'absent-node'));
  await writeFile(join(home, '.bashrc'), missingRuntimeRc); await writeFile(join(home, '.zshrc'), missingRuntimeRc);
  expect(await startInteractiveShell(binary, home, env)).toEqual({ code: 0, output: '' });
});

test('semantic pi and app saves preserve bytes and journal without another cutover', async () => {
  const f = await fixture(); const cutover = vi.spyOn(f.parts, 'cutover');
  await setupHerdr(f.request, f.parts); await editUnrelated(f);
  const app = join(f.h.directories.app, 'settings.json');
  await writeFile(app, JSON.stringify({ ...JSON.parse(await readFile(app, 'utf8')), zoom: 2 }, null, 4));
  const shared = [join(f.h.directories.agent, 'settings.json'), app, join(f.h.directories.app, 'keys.json'), f.request.config.shellRc, f.request.config.core.config];
  const bytes = await Promise.all(shared.map(path => readFile(path)));
  const journal = await readFile(join(f.request.journalRoot, 'journal.json'));
  expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
  expect(cutover).toHaveBeenCalledTimes(1);
  expect(await Promise.all(shared.map(path => readFile(path)))).toEqual(bytes);
  expect(await readFile(join(f.request.journalRoot, 'journal.json'))).toEqual(journal);
  await rollbackHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(shared[0], 'utf8'))).toEqual({ theme: 'stock', unrelated: 'edited' });
});

test('an artifact-only upgrade does not repeat a settled cutover', async () => {
  const f = await fixture(); const cutover = vi.spyOn(f.parts, 'cutover');
  await setupHerdr(f.request, f.parts);
  const source = join(f.root, 'packages/herdr/assets/mods/spider/main.js');
  await writeFile(source, (await readFile(source, 'utf8')) + '\n// updated panel\n');
  expect((await setupHerdr(f.request, f.parts)).writes).toContain(join(f.h.directories.app, 'mods/spider-panel/main.js'));
  expect(cutover).toHaveBeenCalledTimes(1);
});

test.each(['resume', 'mods', 'launcher'] as const)('doctor checks the pinned %s Node path with an explicit repair', async source => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const missing = join(f.h.root, 'removed-node');
  if (source === 'resume') await writeFile(f.request.config.shellRc, (await readFile(f.request.config.shellRc, 'utf8')).split(process.execPath).join(missing));
  else if (source === 'mods') {
    const path = join(f.h.directories.app, 'layouts/spider-glass.json');
    await writeFile(path, (await readFile(path, 'utf8')).split(process.execPath).join(missing));
  } else {
    const path = join(f.request.journalRoot, 'journal.json');
    const journal = JSON.parse(await readFile(path, 'utf8')); journal.launcherNodePath = missing; await writeFile(path, JSON.stringify(journal));
  }
  const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
  expect(report.failures).toContainEqual(expect.objectContaining({ item: 'local-node', code: 'pinned-node-unavailable', message: expect.stringContaining(missing), repair: expect.stringContaining('Node') }));
  expect(report.failures.find(f => f.code === 'pinned-node-unavailable')?.repair).toContain('setup');
});

test('production setup refuses a split global root before writes and doctor names the repair', async () => {
  const f = await fixture();
  const wrongRoot = join(f.h.root, 'wrong-global');
  const request = { ...f.request, config: { ...f.request.config, globalRoot: wrongRoot }, journalRoot: join(wrongRoot, 'herdr/setup') };
  const parts = await f.ports.setupParts(request);
  const calls = await f.h.calls();
  await expect(setupHerdr(request, parts)).rejects.toMatchObject({ code: 'global-root-mismatch', message: expect.stringContaining(f.h.directories.global) });
  expect(await readFile(join(request.journalRoot, 'journal.json')).then(() => true, () => false)).toBe(false);
  expect(await readdir(wrongRoot).then(() => true, () => false)).toBe(false);
  const report = await doctorHerdr(request, await f.ports.doctorParts(request));
  expect(report.failures).toContainEqual(expect.objectContaining({ code: 'global-root-mismatch', repair: expect.stringContaining(f.h.directories.global) }));
  expect(await f.h.calls()).toEqual(calls);
});

test('setup can follow a managed rollback that preserved unrelated edits', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts); await editUnrelated(f);
  await rollbackHerdr(f.request, f.parts);
  expect((await setupHerdr(f.request, f.parts)).doctor.failures).toEqual([]);
  expect(JSON.parse(await readFile(join(f.h.directories.agent, 'settings.json'), 'utf8')).unrelated).toBe('edited');
});

test('rollback reports damaged resume markers and retains the referenced hook', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const warnings: string[] = []; f.parts.warn = warning => warnings.push(warning);
  await writeFile(f.request.config.shellRc, (await readFile(f.request.config.shellRc, 'utf8')).replace('# spider:resume:end', '# user-edited:end'));
  await rollbackHerdr(f.request, f.parts);
  expect(warnings.some(warning => warning.includes('not restored'))).toBe(true);
  expect(await readFile(join(f.h.directories.global, 'herdr/resume.sh')).then(() => true, () => false)).toBe(true);
});
