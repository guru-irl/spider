// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import patches from '../../assets/look/patches.json' with { type: 'json' };
import crossMachine from '../../assets/look/cross-machine-patches.json' with { type: 'json' };
import { ACTIVITY_FRAMES } from '../../../ui/src/icons.js';
import { middlePath } from '../../assets/shared/feed.js';
import { identityPill } from '../../assets/shared/look.js';
import { applyLookPatches, selectLookPatches, type HerdrClones, type LookPatchSet } from '../look/patches.js';
import { applyCrossMachinePatches, selectCrossMachinePatches } from '../look/cross-machine.js';
import { loadSpacesAFiles, type SpacesAVersion } from './spaces-a-fixture.js';
import { createUiModules } from './strict-mod-api.mjs';

type Element = { items: (Element | string)[]; styles: Record<string, unknown[]>; asset?: string };
function all(root: Element): Element[] {
  return [root, ...root.items.filter((item): item is Element => typeof item !== 'string').flatMap(all)];
}
async function sources(version: '0.1.12' | SpacesAVersion): Promise<Record<string, string>> {
  if (version === '0.1.12') {
    const clones = {} as HerdrClones;
    for (const kind of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const) clones[kind] = {
      name: `spider-${kind}`, clonedFrom: { name: kind, version },
      files: Object.fromEntries(await Promise.all(['main.js', 'mod.json'].map(async file => [file, await readFile(new URL(`./fixtures/herdr-${version}/mods/${kind}/${file}`, import.meta.url), 'utf8')]))),
    };
    const result = await applyLookPatches(clones, patches as LookPatchSet);
    return Object.fromEntries(Object.entries(result).map(([kind, clone]) => [kind, clone.files['main.js']]));
  }
  const files = loadSpacesAFiles(version);
  const kinds = ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome', 'menu', 'new-menu'] as const;
  const clones = Object.fromEntries(kinds.map(kind => [kind, {
    name: `spider-${kind}`, clonedFrom: { name: kind, version }, files: files[kind],
  }])) as unknown as HerdrClones;
  const recipe = selectLookPatches(patches as LookPatchSet, version);
  const staged = await applyLookPatches(clones, { ...recipe, mods: { ...recipe.mods, 'new-menu': [] } }, { requireCompleteSources: true });
  for (const derived of recipe.recipe!.derivedFiles) {
    const clone = staged[derived.mod as keyof HerdrClones];
    if (clone) clone.files = { ...clone.files, [derived.file]: readFileSync(new URL(`../../assets/${derived.asset}`, import.meta.url), 'utf8') };
  }
  const result = applyCrossMachinePatches(Object.fromEntries(kinds.map(kind => [kind, staged[kind]!.files])), selectCrossMachinePatches(crossMachine, version));
  return Object.fromEntries(Object.entries(result).map(([kind, files]) => [kind, files['main.js']]));
}
function render(source: string, mod: 'agents' | 'tabs' | 'pane', status: string, tab?: { program: { key?: string; name: string; icon: string }; sidebarWidth: number; trafficLightsX?: number }): Element {
  const ui = createUiModules();
  const working = '#123456';
  const theme = { working, foreground: '#eeeeee', muted: '#aaaaaa', dim: '#777777', hover: '#333333', selected: '#444444', raised: '#555555', chrome: '#161618', border: '#222222', background: '#161618', done: '#888888', blocked: '#ffcc00' };
  const machineCode = readFileSync(new URL('../../assets/pane/machine.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
  const machine = new Function('div', `${machineCode}; return { panePresentation, paneTargetFacts, resolvePaneHeaderFacts, renderMachinePill, initPaneHeaderProjection, closePaneHeaderProjection };`)(ui['gpui-kit'].div);
  const ports: Record<string, unknown> = {
    View: ui['gpui-kit'].View, div: ui['gpui-kit'].div, h_flex: ui['gpui-base'].h_flex, v_flex: ui['gpui-base'].v_flex, middlePath, identityPill, ...machine,
    svg: (asset: string) => Object.assign(ui['gpui-kit'].svg(), { asset }),
    image: (asset: string) => Object.assign(ui['gpui-kit'].image(), { asset }),
    props: () => ({ pane: 'p1' }),
    panes: () => [{ pane: 'p1', terminal: 't1', tab: 'tab', cwd: '/fixture', status, program: tab?.program }],
    spaces: () => [{ id: 's1', active: true, tabs: [{ id: 'tab', name: 'Work', active: false, status }] }],
    terminals: () => [], theme: () => theme, home: () => '/home/fixture',
    layout: () => tab ? { id: 'root', traffic_lights: [tab.trafficLightsX ?? -60, -60], children: [{ id: 'sidebar', size: { px: tab.sidebarWidth } }] } : { id: 'root', children: [] },
    window: () => tab ? { platform: 'macos', titlebar: 'none', fullscreen: false } : {}, shared: () => null,
    settings: () => ({ zoom: 1 }), run: () => {}, openOverlay: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) }, herdrApi: {},
    openPickerFromHost: () => {}, parkFocusedTerminal: () => {},
  };
  const code = source.replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)*import .*;\s*$/gm, '').replace('export default class ', 'class ');
  const name = /class (\w+) extends View/.exec(code)![1];
  const View = new Function('ports', `const { ${Object.keys(ports).join(', ')} } = ports; ${code}; return ${name};`)(ports);
  const view = new View();
  if (mod === 'agents') return view.status(theme, { status, address: 't1' }, false);
  view.init();
  return view.render({ notify() {} });
}

test('0.1.18 hides Pi icons in tab labels but still shows other program icons', async () => {
  const source = (await sources('0.1.18')).tabs!;
  const assets = (program: { key?: string; name: string; icon: string }) => {
    const row = render(source, 'tabs', 'working', { program, sidebarWidth: 268 });
    return all(all(row).find(node => node.styles.id?.[0] === 'tab-tab')!).flatMap(node => node.asset ? [node.asset] : []);
  };
  expect(assets({ key: 'pi', name: 'Pi', icon: 'pi.svg' })).toEqual([]);
  expect(assets({ name: 'Pi', icon: 'pi.svg' })).toEqual([]);
  expect(assets({ key: 'shell', name: 'Shell', icon: 'shell.svg' })).toEqual(['shell.svg']);
});

test('0.1.18 uses a 6.5px tab gutter but makes more room when the traffic lights need it', async () => {
  const source = (await sources('0.1.18')).tabs!;
  const program = { name: 'Shell', icon: 'shell.svg' };
  expect.soft(render(source, 'tabs', 'idle', { program, sidebarWidth: 268 }).styles.pl).toEqual([6.5]);
  expect(render(source, 'tabs', 'idle', { program, sidebarWidth: 8, trafficLightsX: -40 }).styles.pl).toEqual([16]);
});

const flippedMoon = [
  '\uE3E3', '\uE3E1', '\uE3DF', '\uE3DD', '\uE3DB', '\uE3D9', '\uE3D7',
  '\uE3D5', '\uE3D3', '\uE3D1', '\uE3CF', '\uE3CD', '\uE3CB', '\uE3C9',
];

for (const version of ['0.1.12', '0.1.13', '0.1.16', '0.1.18'] as const) {
  for (const mod of ['agents', 'tabs', 'pane'] as const) {
    test(`${version} ${mod} shows Spider's moon only while working`, async () => {
      const source = (await sources(version))[mod];
      const working = all(render(source, mod, 'working'));
      const animation = working.filter(node => node.styles.frames);
      expect(animation).toHaveLength(1);
      expect(animation[0].styles.frames).toEqual([flippedMoon, 1000 / 14]);
      expect(animation[0].styles.frames[0]).toEqual(ACTIVITY_FRAMES.nerd.working);
      expect(animation[0].styles).toMatchObject({ size: [12], text_size: [12], font_family: ['CaskaydiaCove Nerd Font'], text_color: ['#123456'], flex_none: [] });
      expect(working.some(node => node.asset === 'mods/workspace-chrome/spinner.svg')).toBe(false);
      expect(all(render(source, mod, 'idle')).some(node => node.styles.frames)).toBe(false);
    });
  }
}
