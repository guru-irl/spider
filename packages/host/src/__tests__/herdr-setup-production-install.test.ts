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

test('production installs each theme where its consumer reads it', async () => {
  const f = await fixture();
  const files = await f.parts.installFiles(f.request, f.context);
  expect(files.find(file => file.path === join(f.h.directories.agent, 'themes/dracula-plus-glass.json'))?.bytes).toEqual(await readFile(join(f.root, 'packages/herdr/assets/themes/dracula-plus-glass.json')));
  expect(files.find(file => file.path === join(f.h.directories.app, 'themes/spider-glass.json'))?.bytes).toEqual(await readFile(join(f.root, 'packages/herdr/assets/themes/spider-glass.json')));
  expect(files.some(file => file.path === join(f.h.directories.agent, 'themes/spider-glass.json'))).toBe(false);
  expect(files.some(file => file.path === join(f.h.directories.app, 'themes/dracula-plus-glass.json'))).toBe(false);
});

test('production layout passes selected font families and retention to the consuming mods', async () => {
  const f = await fixture();
  const fonts = join(f.root, 'packages/herdr/assets/fonts');
  const config = JSON.parse(await readFile(f.request.configPath, 'utf8'));
  config.fonts = {
    label: { path: join(fonts, 'GoogleSansFlex.ttf'), license: join(fonts, 'GoogleSansFlex-OFL.txt') },
    paths: { path: join(fonts, 'GlassLabel-Bold.ttf'), license: join(fonts, 'GoogleSansFlex-OFL.txt') },
  };
  config.limits = { completedRows: 7, completedHours: 3 };
  await writeFile(f.request.configPath, JSON.stringify(config));
  const request = await f.ports.request(f.request.configPath);
  await setupHerdr(request, f.parts);
  const layout = JSON.parse(await readFile(join(f.h.directories.app, 'layouts/spider-glass.json'), 'utf8'));
  const contents: any[] = [];
  const visit = (node: any) => { if (node?.content?.mod) contents.push(node.content); if (node?.content?.pane?.header) visit(node.content.pane.header); for (const child of node?.children ?? []) visit(child); };
  visit(layout);
  expect(contents.find(c => c.mod === 'spider-agents')?.props).toMatchObject({ labelFont: 'Google Sans Flex', retention: { completedRows: 7, completedHours: 3 } });
  expect(contents.find(c => c.mod === 'spider-spaces')?.props).toMatchObject({ labelFont: 'Google Sans Flex' });
  expect(contents.find(c => c.mod === 'spider-pane')?.props).toMatchObject({ pathFont: 'Glass Label' });
});

test('production refuses an unowned same-named mod before any backup', async () => {
  const f = await fixture();
  const path = join(f.h.directories.app, 'mods/spider-panel/main.js'); await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'user owned');
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'unowned-clone-collision' });
  expect(await readFile(path, 'utf8')).toBe('user owned');
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
});

test('production reuses Node observations on an unchanged second setup', async () => {
  const f = await fixture();
  const first = await setupHerdr(f.request, f.parts);
  expect(first.probes).toHaveLength(1);
  const before = (await f.h.calls()).filter(call => call.argv[0] === 'run').length;
  const journal = await readFile(join(f.request.journalRoot, 'journal.json'));
  const second = await setupHerdr(f.request, f.parts);
  expect(second.writes).toEqual([]);
  // Root-loss repair needs one live root probe per machine; doctor reuses it and the cached Node version.
  const added = (await f.h.calls()).filter(call => call.argv[0] === 'run').slice(before);
  expect(added).toHaveLength(f.request.config.machines.length);
  for (const call of added) { expect(call.argv).toContain('--probe'); expect(call.argv).not.toContain('--version'); }
  expect(await readFile(join(f.request.journalRoot, 'journal.json'))).toEqual(journal);
  expect(f.bootstraps).toHaveLength(1);
});

test('production keeps unrelated edits in all shared settings files', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts); await editUnrelated(f);
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(join(f.h.directories.agent, 'settings.json'), 'utf8')).unrelated).toBe('edited');
  expect(await readFile(f.request.config.shellRc, 'utf8')).toContain('export USER_CHOICE=kept');
  expect(await readFile(f.request.config.core.config, 'utf8')).toContain('value = 42');
  expect(JSON.parse(await readFile(join(f.h.directories.app, 'keys.json'), 'utf8')).global).toEqual({ 'ctrl-q': 'user.action' });
  expect(f.bootstraps).toHaveLength(1);
});

test.each(['theme', 'notes', 'resume', 'keys'])('production refuses a user edit to the managed %s with repair advice', async kind => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  if (kind === 'theme') await writeFile(join(f.h.directories.agent, 'settings.json'), '{"theme":"user-theme"}');
  if (kind === 'notes') await writeFile(f.request.config.core.config, 'notes = true\n');
  if (kind === 'resume') await writeFile(f.request.config.shellRc, (await readFile(f.request.config.shellRc, 'utf8')).replace('. ', '. changed '));
  if (kind === 'keys') { const path = join(f.h.directories.app, 'keys.json'), keys = JSON.parse(await readFile(path, 'utf8')); keys.terminal['cmd-shift-o'] = 'user.action'; await writeFile(path, JSON.stringify(keys)); }
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'managed-artifact-changed', message: expect.stringContaining('Restore') });
});

test('production upgrades changed mods themes and runtime without a patch-set change', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const patchBytes = await readFile(join(f.root, 'packages/herdr/assets/look/patches.json'));
  const source = join(f.root, 'packages/herdr/assets/mods/spider/main.js'); await writeFile(source, (await readFile(source, 'utf8')) + '\n// upgraded\n');
  const theme = join(f.root, 'packages/herdr/assets/themes/spider-glass.json'); const data = JSON.parse(await readFile(theme, 'utf8')); data.background = '#121214'; await writeFile(theme, JSON.stringify(data));
  await writeFile(join(f.root, 'dist/herdr/remote-runtime.mjs'), (await readFile(join(f.root, 'dist/herdr/remote-runtime.mjs'), 'utf8')) + '\n// runtime update\n');
  const result = await setupHerdr(f.request, f.parts);
  expect(result.writes).toContain(join(f.h.directories.app, 'mods/spider-panel/main.js'));
  expect(result.writes).toContain(join(f.h.directories.app, 'themes/spider-glass.json'));
  expect(await readFile(join(f.h.directories.app, 'mods/spider-panel/main.js'))).toEqual(await readFile(source));
  expect(await readFile(join(f.h.directories.app, 'themes/spider-glass.json'))).toEqual(await readFile(theme));
  expect(result.probes).toHaveLength(1);
  expect(new Set(f.bootstraps).size).toBe(2);
  expect(await readFile(join(f.root, 'packages/herdr/assets/look/patches.json'))).toEqual(patchBytes);
});

test('app selections are backed up before commands and restored by rollback', async () => {
  const f = await fixture('fake', true);
  const settings = join(f.h.directories.app, 'settings.json');
  const original = await readFile(settings);
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ zoom: 1.25, theme: 'spider-glass', layout: 'spider-glass' });
  const entry = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === settings)!;
  expect(await readFile(entry.backup!)).toEqual(original);
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(settings)).toEqual(original);
});

test('setup without --config reads the standard file and records no extra path', async () => {
  const f = await fixture(); const standard = join(f.h.directories.global, 'herdr/config.json');
  await mkdir(dirname(standard), { recursive: true }); await writeFile(standard, await readFile(f.request.configPath));
  const request = await f.ports.request();
  expect(request.configPath).toBe(standard);
  expect(await runHerdrCli(['setup'], { ...f.ports, setupParts: r => f.ports.setupParts(r), stdout() {}, stderr() {} })).toBe(0);
  expect(JSON.parse(await readFile(join(f.h.directories.global, 'config.json'), 'utf8'))['herdr.config']).toBeUndefined();
  expect((await readJournal(request.journalRoot)).entries.some(e => e.path === join(f.h.directories.global, 'config.json'))).toBe(false);
});

test('custom configuration paths are backed up as an owned global key without copying', async () => {
  const f = await fixture(); const global = join(f.h.directories.global, 'config.json');
  const original = await readFile(global);
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(global, 'utf8'))['herdr.config']).toBe(f.request.configPath);
  const entry = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === global)!;
  expect(await readFile(entry.backup!)).toEqual(original);
  expect(await readFile(join(f.h.directories.global, 'herdr/config.json')).then(() => true, () => false)).toBe(false);
  await writeFile(global, JSON.stringify({ ...JSON.parse(await readFile(global, 'utf8')), userChoice: 'keep' }));
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(global, 'utf8')).userChoice).toBe('keep');
  expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
});

test('production template planning skips malformed global role values like the normal parser', async () => {
  const f = await fixture();
  await writeFile(join(f.h.directories.global, 'config.json'), JSON.stringify({ 'models.defaults': { worker: 42 } }));
  const files = await f.parts.generateTemplates(f.request, f.context);
  expect(files).toHaveLength(6);
  for (const file of files) expect(file.bytes.length).toBeGreaterThan(0);
});

async function addAuditTerminal(f: Awaited<ReturnType<typeof fixture>>, address: string, notify: boolean | undefined) {
  const terminal = { address, parent: null, labels: { 'spider.kind': 'subagent-viewer' }, state: 'finished', status: null, exit_code: 0, reason: 'exited', signal: null, finished_ms: 1, ...(notify === undefined ? {} : { notify }) };
  await f.h.emitCore({ type: 'created', seq: 100, terminal: address, data: terminal });
  await vi.waitFor(async () => expect(await f.h.cli(['get', address, '--json'])).toMatchObject(terminal));
  // hc 0.1.17 omits labels and notify from list rows, but keeps them in events.
  await f.h.scenario({ steps: [{ argvPrefix: ['ls'], reply: { terminals: [{ address, agent: 'node', cwd: '/fixture', state: 'finished', turn: 0 }] } }] });
}

test('production doctor reads native notification policy and can reject a launch', async () => {
  const f = await fixture(); await addAuditTerminal(f, 'unsafe', true);
  try {
    const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
    expect(report.failures).toContainEqual(expect.objectContaining({ item: 'launches', code: 'launch-notify-enabled' }));
    expect(report.warnings).not.toContainEqual(expect.objectContaining({ item: 'launches', code: 'inspection-unavailable' }));
  } finally { await f.h.scenario({}); }
});

test('doctor verifies quiet launches when the core list omits their labels and notification policy', async () => {
  const f = await fixture(); await addAuditTerminal(f, 'quiet', false);
  try {
    const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
    expect(report.failures).not.toContainEqual(expect.objectContaining({ item: 'launches' }));
    expect(report.warnings).not.toContainEqual(expect.objectContaining({ item: 'launches', code: 'inspection-unavailable' }));
  } finally { await f.h.scenario({}); }
});

test('doctor gives usable advice when a launch has no readable notification policy', async () => {
  const f = await fixture(); await addAuditTerminal(f, 'unknown', undefined);
  try {
    const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
    expect(report.warnings).toContainEqual(expect.objectContaining({ item: 'launches', code: 'inspection-unavailable', repair: expect.stringMatching(/setup[\s\S]*doctor/i) }));
    expect(report.warnings.find(row => row.item === 'launches')?.repair).not.toMatch(/core version/i);
  } finally { await f.h.scenario({}); }
});

test('production doctor marks unavailable launch evidence unknown', async () => {
  const f = await fixture();
  const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
  expect(report.warnings).toContainEqual(expect.objectContaining({ item: 'launches', code: 'inspection-unavailable' }));
});

test.each(['layout-theme', 'keys', 'patch-version'] as const)('production doctor checks %s content even if its journal hash matches', async item => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const path = item === 'layout-theme' ? join(f.h.directories.app, 'layouts/spider-glass.json') : item === 'keys' ? join(f.h.directories.app, 'keys.json') : join(f.h.directories.app, 'mods/spider-agents/mod.json');
  const json = JSON.parse(await readFile(path, 'utf8'));
  if (item === 'layout-theme') json.theme = 'wrong';
  if (item === 'keys') json.terminal['cmd-shift-o'] = 'wrong';
  if (item === 'patch-version') json.clonedFrom.version = '0.0.0';
  await writeFile(path, JSON.stringify(json)); await claimCurrentHash(f, path);
  expect((await (await f.ports.doctorParts(f.request)).inspect(item, f.request)).failures.length).toBeGreaterThan(0);
});

test('production doctor does not confuse unrelated shared edits with seven broken features', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts); await editUnrelated(f);
  const parts = await f.ports.doctorParts(f.request);
  for (const item of ['mods', 'clones', 'patch-version', 'layout-theme', 'keys', 'roles', 'resume'] as const) expect((await parts.inspect(item, f.request)).failures).toEqual([]);
});

test('production doctor normalizes pi modifiers and reports tree and editor collisions', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  await writeFile(join(f.h.directories.agent, 'keybindings.json'), JSON.stringify({ 'app.tree.filter.cycleBackward': 'shift+ctrl+o', 'app.session.new': 'shift+ctrl+a' }));
  const report = await (await f.ports.doctorParts(f.request)).inspect('keys', f.request);
  expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'tree-view-key-collision', message: expect.stringContaining('ctrl+shift+o') }));
  expect(report.failures).toContainEqual(expect.objectContaining({ code: 'pi-shortcut-collision', message: expect.stringContaining('ctrl+shift+a') }));
});

if (process.env.SPIDER_HERDR_E2E !== '1') console.info('SKIP production setup with real isolated cores: require SPIDER_HERDR_E2E=1; no app window is used');

test('upgrades may add owned keys without treating a new key as a user edit', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const source = join(f.root, 'packages/herdr/assets/keys.json'), keys = JSON.parse(await readFile(source, 'utf8'));
  keys.terminal['ctrl-shift-z'] = 'new.action'; await writeFile(source, JSON.stringify(keys));
  const result = await setupHerdr(f.request, f.parts);
  expect(result.writes).toContain(join(f.h.directories.app, 'keys.json'));
  expect(JSON.parse(await readFile(join(f.h.directories.app, 'keys.json'), 'utf8')).terminal['ctrl-shift-z']).toBe('new.action');
});

test('damaged managed resume markers explain how to repair them', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  await writeFile(f.request.config.shellRc, (await readFile(f.request.config.shellRc, 'utf8')) + '# spider:resume:start\n');
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'managed-artifact-changed', message: expect.stringContaining('Restore') });
});

test('doctor validates the installed pi theme with the actual pi schema', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.agent, 'themes/dracula-plus-glass.json'), theme = JSON.parse(await readFile(path, 'utf8'));
  delete theme.colors.accent; await writeFile(path, JSON.stringify(theme));
  expect((await (await f.ports.doctorParts(f.request)).inspect('pi-schema-contrast', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'pi-theme-schema' }));
});

test('doctor never passes unresolved role-template inspection', async () => {
  const f = await fixture();
  await writeFile(join(f.h.directories.global, 'config.json'), JSON.stringify({ 'models.defaults': { worker: 'unavailable', reviewer: 'unavailable', watcher: 'unavailable' } }));
  expect((await (await f.ports.doctorParts(f.request)).inspect('roles', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'role-unresolved', repair: expect.stringContaining('Choose an available configured model') }));
});
