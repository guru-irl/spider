// SPDX-License-Identifier: MIT
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import patches from '../../assets/look/patches.json' with { type: 'json' };
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '../look/patches.js';
import { buildGlassLayout } from '../look/layout.js';
import { createUiModules, createHostModule } from './strict-mod-api.mjs';

const fixtureRoot = process.env.SPIDER_HERDR_MOD_FIXTURE;
async function clones(): Promise<HerdrClones> {
  const result = {} as HerdrClones;
  for (const name of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const) result[name] = {
    name: `spider-${name}`, clonedFrom: { name, version: '0.1.12' },
    files: { 'main.js': await readFile(join(fixtureRoot!, name, 'main.js'), 'utf8'), 'mod.json': await readFile(join(fixtureRoot!, name, 'mod.json'), 'utf8') },
  };
  return result;
}
const colors = { chrome: '#161618', selected: '#ffffff14', foreground: '#eeeeee', muted: '#aaaaaa', dim: '#777777', hover: '#ffffff1a', border: '#00000000' };
function nodes(root: any): any[] { return root && typeof root === 'object' ? [root, ...(root.items ?? []).flatMap(nodes)] : []; }
function scene(source: string, enabled: string[] | null = null) {
  const panel = { id: 'panel', hidden: true }, body = { id: 'panel-body', active: 'files' };
  const space = { id: 'one', active: true, tabs: [] as { id: string; name: string; active: boolean }[] };
  const panes: { tab: string; program: Record<string, unknown> }[] = [];
  const calls: unknown[] = [], saved = new Map<string, string>();
  const ui = createUiModules();
  const ports = { spaces: () => [space], panes: () => panes, theme: () => colors, window: () => ({}), shared: () => enabled,
    layout: () => ({ children: [panel, body] }), settings: () => ({ zoom: 1 }), openOverlay() {},
    run: (name: string, args: any) => { calls.push([name, args]); if (name === 'layout.select') body.active = args.child; if (name === 'layout.show') panel.hidden = false; if (name === 'layout.hide') panel.hidden = true; },
  };
  const imports = { View: ui['gpui-kit'].View, div: ui['gpui-kit'].div, svg: (asset: string) => Object.assign(ui['gpui-kit'].svg(), { asset }), image: (asset: string) => Object.assign(ui['gpui-kit'].image(), { asset }), h_flex: ui['gpui-base'].h_flex, ...createHostModule(ports), localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) } };
  const code = source.replace(/^import .*;\s*$/gm, '').replace('export default class ', 'class ');
  const Tabs = new Function('api', `const { ${Object.keys(imports).join(',')} } = api; ${code}; return Tabs;`)(imports);
  const view = new Tabs(); view.init();
  const render = () => nodes(view.render());
  const button = (id: string) => render().find(node => node.styles.id?.[0] === `panel-${id}`);
  return { view, panel, body, space, panes, calls, saved, render, button };
}

describe.skipIf(!fixtureRoot)('Spider top-bar button against shipped Herdr 0.1.12', () => {
  test('tab icons use the spider mark for pi and keep other programs', async () => {
    const patched = await applyLookPatches(await clones(), patches as LookPatchSet);
    const s = scene(patched.tabs.files['main.js']);
    s.space.tabs.push({ id: 'pi-tab', name: 'Planner', active: false }, { id: 'node-tab', name: 'Node', active: false });
    s.panes.push({ tab: 'pi-tab', program: { key: 'pi', name: 'Pi', icon: 'pi.svg', agent: true } }, { tab: 'node-tab', program: { key: 'node', name: 'Node', icon: 'node.svg', tint: true } });
    const rendered = s.render();
    const pi = rendered.find(node => node.styles.id?.[0] === 'tab-pi-tab');
    const node = rendered.find(node => node.styles.id?.[0] === 'tab-node-tab');
    expect(nodes(pi).find(item => item.asset === 'mods/spider-tabs/spider.svg')).toMatchObject({ styles: { size: [14], text_color: [colors.muted] } });
    expect(nodes(pi).some(item => item.asset === 'pi.svg')).toBe(false);
    expect(nodes(node).find(item => item.asset === 'node.svg')).toBeDefined();
  });

  test('renders after Changes and toggles the same panel using the strict mod API', async () => {
    const patched = await applyLookPatches(await clones(), patches as LookPatchSet);
    const s = scene(patched.tabs.files['main.js']);
    expect(s.render().filter(n => n.styles.id?.[0]?.startsWith('panel-')).map(n => n.styles.id[0])).toEqual(['panel-files', 'panel-changes', 'panel-spider']);
    const spider = s.button('spider'), changes = s.button('changes');
    expect(spider.items).toContain('Spider');
    for (const key of ['h', 'px', 'gap', 'rounded', 'text_size', 'bg', 'text_color']) expect(spider.styles[key]).toEqual(changes.styles[key]);
    spider.events.on_click();
    expect(s.calls).toEqual([['layout.select', { stack: 'panel-body', child: 'spider' }], ['layout.show', { id: 'panel' }]]);
    expect(s.button('spider').styles.bg).toEqual([colors.selected]);
    expect(s.button('spider').styles.text_color).toEqual([colors.foreground]);
    expect(s.button('changes').styles.bg).toEqual([colors.chrome]);
    s.button('spider').events.on_click();
    expect(s.calls.at(-1)).toEqual(['layout.hide', { id: 'panel' }]);
    expect(s.button('spider').styles.bg).toEqual([colors.chrome]);
  });

  test.each([{ enabled: [] }, { enabled: ['files'] }, { enabled: ['spider', 'changes'] }])('Spider is always enabled and remembered per space with $enabled configured', async ({ enabled }) => {
    const patched = await applyLookPatches(await clones(), patches as LookPatchSet);
    const s = scene(patched.tabs.files['main.js'], enabled);
    expect(s.button('spider')).toBeDefined();
    s.button('spider').events.on_click(); s.render();
    expect(JSON.parse(s.saved.get('panels')!).one).toBe('spider');
    s.space.id = 'two'; s.render(); s.render();
    expect(s.panel.hidden).toBe(true);
    s.space.id = 'one'; s.render(); s.render();
    expect(s.body.active).toBe('spider'); expect(s.panel.hidden).toBe(false);
    s.button('spider').events.on_click(); s.render();
    expect(JSON.parse(s.saved.get('panels')!).one).toBeNull();
  });

  test('a moved or repeated tabs anchor refuses pure staging without changing inputs', async () => {
    const original = await clones();
    for (const source of [original.tabs.files['main.js'].replace('const enabled =', 'const allowed ='), original.tabs.files['main.js'] + '\n' + 'const enabled = shared("workspace.panels") ?? ["files", "changes"];']) {
      const changed = structuredClone(original); changed.tabs.files = { ...changed.tabs.files, 'main.js': source };
      const before = structuredClone(changed);
      // A hypothetical recognized source can still have an invalid patch anchor.
      const recognized = structuredClone(patches);
      recognized.sourceHashes.tabs['main.js'] = createHash('sha256').update(source).digest('hex');
      await expect(applyLookPatches(changed, recognized as LookPatchSet)).rejects.toMatchObject({ code: 'patch-anchor-mismatch', message: expect.stringContaining('tabs:') });
      expect(changed).toEqual(before);
    }
  });

  test('patching the tabs clone is idempotent and detects later edits', async () => {
    const patched = await applyLookPatches(await clones(), patches as LookPatchSet);
    expect(await applyLookPatches(patched, patches as LookPatchSet)).toEqual(patched);
    patched.tabs.files = { ...patched.tabs.files, 'main.js': patched.tabs.files['main.js'] + '\n// user edit' };
    await expect(applyLookPatches(patched, patches as LookPatchSet)).rejects.toMatchObject({ code: 'clone-modified' });
  });

  test('the glass layout routes the shipped top bar through the tabs clone without changing the source', async () => {
    const source = JSON.parse(await readFile(new URL('./fixtures/herdr-0.1.12/layouts/main.json', import.meta.url), 'utf8'));
    const before = structuredClone(source);
    const result = buildGlassLayout(source, { agents: 'spider-agents', spaces: 'spider-spaces', pane: 'spider-pane', tabs: 'spider-tabs', spider: 'spider-panel', chrome: 'spider-chrome' });
    function mods(node: any): string[] { return [node.content?.mod, ...(node.children ?? []).flatMap(mods)].filter(Boolean); }
    expect(mods(result)).toContain('spider-tabs'); expect(mods(result)).not.toContain('tabs');
    expect(source).toEqual(before);
  });
});
