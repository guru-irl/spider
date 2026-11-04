// SPDX-License-Identifier: MIT
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, expect, test } from 'vitest';
import patchSet from '../../assets/look/patches.json' with { type: 'json' };
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '../look/patches.js';
import { middlePath } from '../../assets/shared/feed.js';
import { identityPill } from '../../assets/shared/look.js';
import { createUiModules } from './strict-mod-api.mjs';

type Element = { items: (Element | string)[]; styles: Record<string, unknown[]>; asset?: string };
let source: string;
let patched: HerdrClones;
let selectedPatches: LookPatchSet;
beforeAll(async () => {
  const clones = {} as HerdrClones;
  const fixture = process.env.SPIDER_HERDR_MOD_FIXTURE!;
  for (const name of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const) clones[name] = {
    name: `spider-${name}`, clonedFrom: { name, version: '0.1.12' }, files: {
      'main.js': await readFile(join(fixture, name, 'main.js'), 'utf8'),
      'mod.json': await readFile(join(fixture, name, 'mod.json'), 'utf8'),
    },
  };
  selectedPatches = patchSet as LookPatchSet;
  patched = await applyLookPatches(clones, selectedPatches);
  source = patched.pane.files['main.js'];
});
function texts(el: Element | string): string[] { return typeof el === 'string' ? [el] : el.items.flatMap(texts); }
function all(el: Element): Element[] { return [el, ...el.items.filter((item): item is Element => typeof item !== 'string').flatMap(all)]; }
function render(patch: Record<string, unknown>, kind?: string, options: { name?: string; parent?: string; theme?: Record<string, string> } = {}) {
  const ui = createUiModules();
  const pane = { pane: 'pane-1', terminal: 't1', title: 'Terminal', cwd: '/fixture/project', status: 'idle', program: { name: 'node', icon: 'program-node.svg' }, ...patch };
  const ports = { ...ui['gpui-kit'], ...ui['gpui-base'], middlePath, identityPill,
    props: () => ({ pane: 'pane-1' }), panes: () => [pane], home: () => '/home/fixture',
    terminals: () => [{ address: 't1', labels: kind ? { 'spider.kind': kind, 'spider.display-name': options.name ?? 'Reviewer', 'spider.parent-name': options.parent ?? 'Planner' } : {} }],
    theme: () => ({ foreground: '#eeeef0', dim: '#99999b', muted: '#88888a', hover: '#ffffff14', background: '#161618', working: '#eeeef0', ...options.theme }),
    openOverlay() {}, run() {},
    svg: (asset: string) => Object.assign(ui['gpui-kit'].svg(), { asset }),
    image: (asset: string) => Object.assign(ui['gpui-kit'].image(), { asset }),
  };
  const code = source.replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)?import .*;\s*$/gm, '').replace('export default class ', 'class ');
  const Pane = new Function('ports', `const {${Object.keys(ports).join(',')}}=ports;${code};return Pane;`)(ports);
  const view = new Pane(); view.init();
  return view.render({ notify() {} }) as Element;
}

test.each([
  ['subagent-viewer', 'mods/spider-agents/bot.svg'],
  ['remote-console', 'mods/workspace-chrome/terminal.svg'],
  ['remote-observer', 'mods/workspace-chrome/terminal.svg'],
])('%s keeps its fixed icon when program detection changes', (kind, icon) => {
  for (const program of [{ name: 'node', icon: 'program-node.svg' }, null, { name: 'shell' }]) {
    const tree = render({ program }, kind);
    expect(tree.items[0]).toMatchObject({ asset: icon, styles: { size: [14], flex_none: [] } });
    expect(all(tree).some(el => el.asset === 'program-node.svg')).toBe(false);
    expect(texts(tree)).toContain('Reviewer');
  }
});

test('pi sessions use the spider mark while other programs retain their icons', () => {
  const pi = render({ program: { name: 'pi', key: 'pi', icon: 'program-pi.svg', agent: true } });
  expect(pi.items[0]).toMatchObject({ asset: 'mods/spider-tabs/spider.svg', styles: { size: [14], text_color: ['#99999b'] } });
  const node = render({ program: { name: 'node', key: 'node', icon: 'program-node.svg' } });
  expect(node.items[0]).toMatchObject({ asset: 'program-node.svg' });
});

test('a pi title renders the program logo, session pill and path in order', () => {
  const tree = render({ title: 'π - Planner - project', program: { name: 'pi', key: 'pi', icon: 'program-pi.svg', agent: true } });
  expect(tree.items[0]).toMatchObject({ asset: 'mods/spider-tabs/spider.svg' });
  expect(tree.items[1]).toMatchObject({ items: ['Planner'], styles: { px: [8], h: [18], rounded: [999], bg: ['#ffffff14'], font_family: ['JetBrains Mono'], text_size: [11], tooltip: ['Planner'] } });
  expect(texts(tree.items[2])).toEqual(['/fixture/project']);
});

test.each(['π - project', 'π -  - project', 'Ordinary title'])('an unnamed session keeps its old header text for %s', title => {
  const tree = render({ title, program: { name: 'pi', icon: 'program-pi.svg', agent: true } });
  expect(texts(tree.items[1])).toEqual(['pi']);
  expect((tree.items[1] as Element).styles.bg).toBeUndefined();
});

test('session names retain their own separators and numeric names', () => {
  expect(texts(render({ title: 'π - Plan - review - project' }).items[1])).toEqual(['Plan - review']);
  expect(texts(render({ title: 'π - 123 - project' }).items[1])).toEqual(['123']);
});

test('a Spider pane never mistakes a title for a top-level session pill', () => {
  const tree = render({ title: 'π - Other session - project' }, 'subagent-viewer');
  expect(texts(tree.items[1])).toEqual(['Reviewer']);
  expect((tree.items[1] as Element).styles.bg).toEqual(['#ffffff14']);
  expect(texts(tree)).not.toContain('Other session');
});

test('pane header patches are unchanged on a second setup pass', async () => {
  expect(await applyLookPatches(patched, selectedPatches)).toEqual(patched);
});


test('a subagent header is bot, run pill, parent pill and a spacer before status', () => {
  const tree = render({ status: 'working', cwd: '/fixture/hidden-path' }, 'subagent-viewer');
  expect(tree.items[0]).toMatchObject({ asset: 'mods/spider-agents/bot.svg' });
  expect(tree.items[1]).toMatchObject({ items: ['Reviewer'], styles: { px: [8], h: [18], rounded: [999], bg: ['#ffffff14'], font_family: ['JetBrains Mono'], text_size: [11], tooltip: ['Reviewer'] } });
  expect(tree.items[2]).toMatchObject({ items: [expect.objectContaining({ asset: 'mods/spider-agents/corner-up-left.svg' }), 'Planner'], styles: { px: [8], h: [18], rounded: [999], bg: ['#ffffff14'] } });
  expect(tree.items[3]).toMatchObject({ items: [], styles: { flex_1: [] } });
  expect(tree.items[4]).toMatchObject({ asset: 'mods/workspace-chrome/spinner.svg' });
  expect(all(tree).some(el => el.styles.id?.[0] === 'spider-path')).toBe(false);
  expect(texts(tree).join(' ')).not.toMatch(/hidden-path|Can steer|Read-only/);
});

const identityTheme = { ansi1: '#ff5555', ansi2: '#50fa7b', ansi3: '#ffcb6b', ansi4: '#82aaff', ansi5: '#c792ea', ansi6: '#8be9fd', ansi12: '#d6acff', ansi13: '#ff92df' };
const mainPill = (name: string, theme: Record<string, string> = identityTheme) => render({ title: `π - ${name} - project`, program: { name: 'pi', icon: 'program-pi.svg', agent: true } }, undefined, { theme }).items[1] as Element;
const childHeader = (name: string, parent: string, theme: Record<string, string> = identityTheme) => render({}, 'subagent-viewer', { name, parent, theme });

test.each([
  ['india', '#50fa7b33'], ['charlie', '#82aaff33'], ['echo', '#c792ea33'],
  ['bravo', '#8be9fd33'], ['juliet', '#d6acff33'], ['alpha', '#ff92df33'],
])('the name %s has a stable non-status background', (name, background) => {
  expect(mainPill(name).styles.bg).toEqual([background]);
  expect(mainPill(name).styles.bg).toEqual(mainPill(name).styles.bg);
  expect((childHeader(name, 'Parent').items[1] as Element).styles.bg).toEqual([background]);
});

test('a parent uses the same colour as its main session', () => {
  const parent = childHeader('Child', 'charlie').items[2] as Element;
  expect(parent.styles.bg).toEqual(['#82aaff33']);
  expect(parent.styles.bg).toEqual(mainPill('charlie').styles.bg);
  expect(parent.styles.text_color).toEqual(mainPill('charlie').styles.text_color);
});

test('a missing selected theme colour keeps the neutral background', () => {
  const theme = { ...identityTheme }; delete (theme as Partial<typeof theme>).ansi4;
  expect(mainPill('charlie', theme).styles.bg).toEqual(['#ffffff14']);
  expect((childHeader('Child', 'charlie', theme).items[2] as Element).styles.bg).toEqual(['#ffffff14']);
});

test('a low contrast hue uses the theme foreground while retaining its tint', () => {
  const pill = mainPill('india', { ...identityTheme, ansi2: '#242426' });
  expect(pill.styles.bg).toEqual(['#24242633']);
  expect(pill.styles.text_color).toEqual(['#eeeef0']);
});

test('the parent pill renders the small parent icon', () => {
  const parent = childHeader('Child', 'Planner').items[2] as Element;
  expect(all(parent).some(el => el.asset === 'mods/spider-agents/corner-up-left.svg' && el.styles.size?.[0] === 11)).toBe(true);
});

test('only the parent pill has the parent icon and descriptive tooltip', () => {
  const tree = childHeader('Child', 'Planner');
  const child = tree.items[1] as Element, parent = tree.items[2] as Element;
  expect(all(child).some(el => el.asset === 'mods/spider-agents/corner-up-left.svg')).toBe(false);
  expect(all(mainPill('Planner')).some(el => el.asset === 'mods/spider-agents/corner-up-left.svg')).toBe(false);
  expect(parent.styles.tooltip).toEqual(['Started by Planner']);
  expect(parent.items[0]).toMatchObject({ asset: 'mods/spider-agents/corner-up-left.svg', styles: { size: [11], flex_none: [] } });
  expect(texts(parent)).toEqual(['Planner']);
});

test.each(['remote-console', 'remote-observer'])('%s keeps its name and path without a new name pill', kind => {
  const tree = render({}, kind);
  expect((tree.items[1] as Element).styles.bg).toBeUndefined();
  expect(all(tree).find(el => el.styles.id?.[0] === 'spider-path')?.items).toEqual(['/fixture/project']);
});
