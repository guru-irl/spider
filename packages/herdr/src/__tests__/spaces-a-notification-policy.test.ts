// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setupHerdr, rollbackHerdr } from '../setup/installer.js';
import { readJournal } from '../setup/backup.js';
import { planToastFiles } from '../setup/toast.js';
import { automaticAgentAlert } from '../../assets/toast/filter.js';
import { cleanup, fixture } from '../../../host/src/__tests__/herdr-setup-fixture.js';
import { createUiModules } from './strict-mod-api.mjs';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
const toastRoots: string[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); for (const root of toastRoots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

test('filters only native automatic agent alerts', () => {
  for (const title of ['Pi finished', 'Pi needs you']) expect(automaticAgentAlert({ title, action: { name: 'agent.focus' } })).toBe(true);
  for (const props of [null, {}, { title: 'Pi finished', action: { name: 'pane.focus' } }, { title: 'Pi failed', action: { name: 'agent.focus' } }, { title: 'Pifinished', action: { name: 'agent.focus' } }, { title: 'Pi finished!', action: { name: 'agent.focus' } }, { title: 42, action: { name: 'agent.focus' } }, { title: 'Pi finished', action: null }]) expect(automaticAgentAlert(props)).toBe(false);
});

test('derived toast closes automatic alerts and preserves failure and login-copy rendering', () => {
  const ui = createUiModules(), calls: unknown[][] = [];
  let value: Record<string, unknown> = {};
  const api = { ...ui['gpui-kit'], ...ui['gpui-base'], automaticAgentAlert, props: () => value,
    closeOverlay: (...args: unknown[]) => calls.push(['close', ...args]), run: (...args: unknown[]) => calls.push(['run', ...args]),
    playSound: (...args: unknown[]) => calls.push(['sound', ...args]), theme: () => ({ popover: '#111111', hover: '#222222', foreground: '#ffffff', muted: '#aaaaaa', raised: '#333333', accent: '#444444', blocked: '#555555', working: '#666666', done: '#777777' }) };
  const source = readFileSync(resolve('packages/herdr/assets/toast/main.js'), 'utf8').replace(/^import .*;\s*$/gm, '').replace('export default class Toast', 'class Toast');
  const Toast = new Function('api', `const { ${Object.keys(api).join(', ')} } = api; ${source}; return Toast;`)(api);
  const view = new Toast(), flatten = (node: any): any[] => node && typeof node === 'object' ? [node, ...(node.items ?? []).flatMap(flatten)] : [];
  value = { title: 'Pi finished', action: { name: 'agent.focus' }, overlay: 'o1' }; view.render({});
  expect(calls).toEqual([['close', 'o1']]);
  calls.length = 0; value = { title: 'Network failed', action: { name: 'pane.focus', args: { pane: 'p1' } }, overlay: 'o2' };
  const failure = view.render({});
  expect(flatten(failure).flatMap(node => node.items).filter((x: unknown) => typeof x === 'string')).toContain('Network failed');
  expect(calls).toEqual([]); failure.events.on_click();
  expect(calls).toEqual([['run', 'pane.focus', { pane: 'p1' }], ['close', 'o2']]);
  calls.length = 0; value = { title: 'Login', body: 'box-1.invalid needs login; run hc machine login box-1.invalid', overlay: 'o3' };
  const login = view.render({}), copy = flatten(login).find(node => node.styles?.id?.[0] === 'toast-login-copy');
  expect(copy).toBeDefined();
  copy.events.on_click({}, { stop_propagation: () => calls.push(['stop']), write_to_clipboard: (text: string) => calls.push(['copy', text]), notify: () => {} });
  expect(calls).toEqual([['stop'], ['copy', 'hc machine login box-1.invalid']]);
});

test('plans the derived toast only for verified 0.1.16 stock sources', async () => {
  const parent = join(process.env.SPIDER_GLOBAL_ROOT!, 'toast-plan'); await mkdir(parent, { recursive: true });
  const home = await mkdtemp(join(parent, 'case-')); toastRoots.push(home);
  const stock = join(home, 'mods/toast'); await mkdir(stock, { recursive: true });
  const fixtures = resolve('packages/herdr/src/__tests__/fixtures'), assets = resolve('packages/herdr/assets/toast');
  await cp(join(fixtures, 'herdr-0.1.13/mods/toast'), stock, { recursive: true });
  const before13 = await readFile(join(stock, 'main.js'));
  expect(await planToastFiles('0.1.13', home, assets)).toEqual([]);
  expect(await readFile(join(stock, 'main.js'))).toEqual(before13);
  await cp(join(fixtures, 'herdr-0.1.16/mods/toast'), stock, { recursive: true });
  const before16 = await readFile(join(stock, 'main.js')), files = await planToastFiles('0.1.16', home, assets);
  expect(files.map(file => file.path).sort()).toEqual(['NOTICE', 'filter.js', 'main.js', 'mod.json'].map(name => join(home, 'mods/spider-toast', name)).sort());
  expect(await readFile(join(stock, 'main.js'))).toEqual(before16);
  await writeFile(join(stock, 'main.js'), Buffer.concat([before16, Buffer.from('\n// unsupported\n')]));
  await expect(planToastFiles('0.1.16', home, assets)).rejects.toMatchObject({ code: 'upstream-source-mismatch' });
  await expect(planToastFiles('0.1.17', home, assets)).rejects.toMatchObject({ code: 'upstream-version-mismatch' });
});

test('stages the verified 0.1.16 toast and checks its layout selector', async () => {
  const f = await fixture(), app = f.h.directories.app;
  const manifestPath = join(f.root, 'packages/herdr/assets/look/patches.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.upstreamVersion = '0.1.16';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const appScript = join(f.h.root, 'app-selection.mjs');
  await writeFile(appScript, (await readFile(appScript, 'utf8')).replace('herdr-app 0.1.12', 'herdr-app 0.1.16'));
  await cp(resolve('packages/herdr/src/__tests__/fixtures/herdr-0.1.16/mods/toast'), join(app, 'mods/toast'), { recursive: true });
  const originalToast = await readFile(join(app, 'mods/toast/main.js'));
  const base = f.context.modProps[0].props;
  f.context.modProps = [...f.context.modProps, ...['picker', 'toast'].map(name => ({ directory: join(app, 'mods', `spider-${name}`), props: { ...base, modId: `spider-${name}` } }))];
  const files = await f.parts.stageLook(f.request, f.context, 'export');
  const toastFiles = files.filter(file => file.path.startsWith(join(app, 'mods/spider-toast') + '/'));
  expect(toastFiles.map(file => file.path.slice((join(app, 'mods/spider-toast') + '/').length)).sort()).toEqual(['NOTICE', 'filter.js', 'main.js', 'mod.json']);
  expect(toastFiles.find(file => file.path.endsWith('/main.js'))?.bytes).toEqual(await readFile(resolve('packages/herdr/assets/toast/main.js')));
  expect(await readFile(join(app, 'mods/toast/main.js'))).toEqual(originalToast);
  const layoutPath = join(app, 'layouts/spider-glass.json');
  const layout = JSON.parse(files.find(file => file.path === layoutPath)!.bytes.toString());
  layout.toast = 'unknown-toast';
  await writeFile(layoutPath, JSON.stringify(layout));
  const doctor = await f.ports.doctorParts(f.request);
  expect((await doctor.inspect('layout-theme', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'toast-selector-mismatch' }));
  layout.toast = 'spider-toast';
  await writeFile(layoutPath, JSON.stringify(layout));
  await mkdir(join(app, 'themes'), { recursive: true });
  await cp(join(f.root, 'packages/herdr/assets/themes/spider-glass.json'), join(app, 'themes/spider-glass.json'));
  await writeFile(join(app, 'settings.json'), JSON.stringify({ theme: 'spider-glass', layout: 'spider-glass', sounds: { enabled: false } }));
  const result = await doctor.inspect('layout-theme', f.request);
  expect(result.failures).toEqual([]);
  expect(result.information).toContainEqual(expect.objectContaining({ code: 'native-sound-policy', message: expect.stringContaining('derived toast is selected') }));
});

test('plans a native sound compare-write without changing custom sound fields', async () => {
  const f = await fixture(), path = join(f.h.directories.app, 'settings.json');
  const original = { theme: 'stock', layout: 'main', sounds: { enabled: true, done: 'custom.mp3' } };
  await writeFile(path, JSON.stringify(original));
  const files = await f.parts.installFiles(f.request, f.context), file = files.find(item => item.path === path)!;
  expect(JSON.parse(file.bytes.toString())).toEqual({ ...original, sounds: { ...original.sounds, enabled: false } });
  expect(file.managed).toEqual({ kind: 'json-paths', paths: ['theme', 'layout', 'sounds.enabled'] });
  expect(file.updateAfterCutover).toBe(true);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(original);
});

test('owns native sound with app selection while preserving custom sounds and stock toast', async () => {
  const f = await fixture(), settingsPath = join(f.h.directories.app, 'settings.json');
  const original = { zoom: 1.25, theme: 'stock', layout: 'main', sounds: { enabled: true, done: 'custom-done.mp3', blocked: 'custom-blocked.mp3' } };
  await writeFile(settingsPath, JSON.stringify(original));
  const stock = join(f.h.directories.app, 'mods/toast'); await mkdir(stock, { recursive: true });
  await cp(resolve('packages/herdr/src/__tests__/fixtures/herdr-0.1.13/mods/toast/main.js'), join(stock, 'main.js'));
  const stockBefore = await readFile(join(stock, 'main.js'));
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toMatchObject({ theme: 'spider-glass', layout: 'spider-glass', sounds: { ...original.sounds, enabled: false } });
  expect(await readFile(join(stock, 'main.js'))).toEqual(stockBefore);
  const journal = await readJournal(f.request.journalRoot), entries = journal.entries.filter(entry => entry.path === settingsPath);
  expect(entries).toHaveLength(1);
  expect(entries[0].managed).toEqual({ kind: 'json-paths', paths: ['theme', 'layout', 'sounds.enabled'] });
  expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
  const current = JSON.parse(await readFile(settingsPath, 'utf8')); current.sounds.enabled = true;
  await writeFile(settingsPath, JSON.stringify(current));
  const doctor = await f.ports.doctorParts(f.request);
  expect((await doctor.inspect('layout-theme', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'native-sound-enabled' }));
  await rollbackHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual(original);
  expect(await readFile(join(stock, 'main.js'))).toEqual(stockBefore);
});

test('installs the separate intentional sound preference in panel props', async () => {
  const f = await fixture();
  const base = f.context.modProps[0].props;
  f.context.modProps = [...f.context.modProps, { directory: join(f.h.directories.app, 'mods/spider-picker'), props: { ...base, modId: 'spider-picker' } }];
  const panelProps = async () => {
    const files = await f.parts.stageLook(f.request, f.context, 'export');
    const layout = JSON.parse(files.find(file => file.path === join(f.h.directories.app, 'layouts/spider-glass.json'))!.bytes.toString());
    const find = (node: any): any => node.id === 'spider' ? node.content.props : (node.children ?? []).map(find).find(Boolean);
    return find(layout);
  };
  expect((await panelProps()).notifications).toEqual({ sound: true });
  f.request.config.notifications = { sound: false };
  expect((await panelProps()).notifications).toEqual({ sound: false });
});
