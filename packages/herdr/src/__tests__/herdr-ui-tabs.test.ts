// SPDX-License-Identifier: MIT
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import patches from '../../assets/look/patches.json' with { type: 'json' };
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '../look/patches.js';
import { createUiModules, createHostModule, initView } from './strict-mod-api.mjs';

const fixture = new URL('./fixtures/herdr-0.1.12/mods/', import.meta.url);
const colors = { chrome: '#00000000', raised: '#ffffff1c', selected: '#ffffff14', foreground: '#eeeeee', muted: '#aaaaaa', dim: '#777777', hover: '#ffffff12', border: '#00000000', popover: '#161618f0', input: '#ffffff0f', accent: '#dddddd', background: '#161618' };
function nodes(root: any): any[] {
  if (!root || typeof root !== 'object') return [];
  return [root, ...(root.items ?? []).flatMap(nodes), ...['content', 'trigger'].flatMap(key => nodes(root.styles?.[key]?.[0]))];
}
function compile(source: string, ports: Record<string, unknown>, result: string) {
  const code = source.replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)?import .*;\s*$/gm, '').replaceAll('export default class ', 'class ').replaceAll('export function ', 'function ');
  return new Function('api', `const { ${Object.keys(ports).join(',')} } = api; ${code}; return ${result};`)(ports);
}
async function scene(autoHideTabs = true, buttons = false) {
  const clones = {} as HerdrClones;
  for (const kind of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const) clones[kind] = { name: `spider-${kind}`, clonedFrom: { name: kind, version: '0.1.12' }, files: { 'main.js': await readFile(new URL(`${kind}/main.js`, fixture), 'utf8'), 'mod.json': await readFile(new URL(`${kind}/mod.json`, fixture), 'utf8') } };
  const source = (await applyLookPatches(clones, patches as LookPatchSet)).tabs.files['main.js'];
  const ui = createUiModules(), kit = ui['gpui-kit'], base = ui['gpui-base'];
  const space = { id: 'one', name: 'Example', active: true, machine: undefined as string | undefined, tabs: [{ id: 'a', name: 'First', active: true }, { id: 'b', name: 'Second', active: false }] };
  const calls: unknown[] = [], overlays: unknown[] = [], storage = new Map<string, string>(), sharedValues = new Map<string, unknown>();
  let agentSource = async (): Promise<any[]> => [];
  const props = { autoHideTabs }, tabBlock = { id: 'tabs', window_drag: true, size: { px: autoHideTabs ? 6 : 42 } };
  const ports: Record<string, any> = { ...kit, ...base, globalThis: { window: { viewport_size: () => ({ width: 1200, height: 800 }) } },
    Popup: { new: (id: string, trigger: any) => kit.div().id(id).child(trigger) }, Popover: { new: (id: string) => kit.div().id(id) },
    InputState: { new: ({ value }: { value: string }) => ({ text: value, handlers: {} as Record<string, Function>, value() { return this.text; }, on(name: string, handler: Function) { this.handlers[name] = handler; }, focus() {}, set_selected_range() {} }) }, Input: { new: (input: unknown) => Object.assign(kit.div(), { input }) },
    ...createHostModule({ props: () => props, spaces: () => [space], panes: () => [], focused: () => ({ pane: 'p1', terminal: 't1' }),
      layout: () => ({ traffic_lights: [-60, -60], children: [tabBlock, { id: 'sidebar', size: { px: 44 } }] }), window: () => ({ platform: buttons ? 'windows' : 'macos', buttons, titlebar: 'none', fullscreen: false }), settings: () => ({ zoom: 1 }), shared: (key: string) => sharedValues.get(key) ?? null,
      theme: () => colors, keys: () => [], knownAgents: () => agentSource(), run: (name: string, args: unknown) => calls.push([name, args]), openOverlay: (spec: unknown) => overlays.push(spec), closeOverlay() {}, setShared(key: string, value: unknown) { sharedValues.set(key, value); },
    }), localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } };
  delete ports.Tabs;
  try { Object.assign(ports, compile(await readFile(new URL('../../assets/tabs/autohide.js', import.meta.url), 'utf8'), ports, '({ initTabAutoHide, renderTabAutoHide, closeTabAutoHide })')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const cx: any = { notify: vi.fn(), stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn: (fn: Function) => fn(cx), timer: { after: (ms: number, fn: Function) => { const id = setTimeout(() => fn(cx), ms); return { cancel: () => clearTimeout(id) }; } } };
  const Tabs = compile(source, ports, 'Tabs'), view = initView(new Tabs(), cx);
  const render = () => view.render(cx);
  const byId = (id: string) => nodes(render()).find(node => node.styles.id?.[0] === id);
  const event = (id: string, key: string, ...args: unknown[]) => { const node = byId(id); const style = node?.styles[key]; const handler = node?.mouseEvents?.[`${key}:${args[0]}`] ?? style?.find((value: unknown) => typeof value === 'function'); if (!handler) throw new Error(`Missing ${key} on ${id}`); handler(...(key === 'on_mouse_down' || key === 'on_mouse_up' ? args.slice(1) : args), cx); };
  const enter = () => event('tabs-strip', 'on_hover', true);
  const leave = () => { event('tabs-strip', 'on_hover', false); if (byId('tabs-revealed')) event('tabs-revealed', 'on_hover', false); };
  const full = () => Boolean(byId('tabs-revealed'));
  // The bar is fading away: still drawn, already transparent.
  const leaving = () => full() && byId('tabs-slide')?.styles.opacity?.[0] === 0;
  const typeIn = (id: string, text: string) => { const input = nodes(byId(id)).find(node => Object.hasOwn(node, 'input')).input; input.text = text; input.handlers.change({}, cx); };
  return { view, cx, space, props, calls, overlays, tabBlock, sharedValues, render, byId, event, enter, leave, full, leaving, typeIn, setAgentSource(source: () => Promise<any[]>) { agentSource = source; } };
}
const SLIDE = 140;
afterEach(() => vi.useRealTimers());

test('the resting strip replaces the tab row without resizing any terminal', async () => {
  const s = await scene();
  expect(s.byId('tabs-strip')?.styles.h).toEqual([6]);
  expect(s.byId('tab-a')).toBeUndefined();
  expect(s.tabBlock.window_drag).toBe(true);
  expect(s.calls).toEqual([]);
});
test('enter reveals a 42 pixel anchored row without a layout command', async () => {
  const s = await scene(); s.enter();
  expect(s.byId('tabs-revealed')?.styles.h).toEqual([42]);
  expect(s.byId('tab-a')).toBeDefined();
  expect(s.byId('tabs-popup')?.styles.anchor).toEqual(['top_left']);
  expect(s.calls).toEqual([]);
});
test('the overlay leaves room at the right edge instead of shifting over the sidebar', async () => {
  vi.useFakeTimers(); const s = await scene(); s.event('tabs-strip', 'on_size_change', { width: 792, height: 6 }); s.enter(); vi.advanceTimersByTime(16);
  expect(s.byId('tabs-slide')?.styles.w).toEqual([776]);
  s.event('tabs-strip', 'on_size_change', { width: 592, height: 6 });
  expect(s.byId('tabs-slide')?.styles.w).toEqual([576]); expect(s.byId('tabs-revealed')?.styles.w).toEqual([576]);
  expect(s.calls).toEqual([]);
});

test('the bar fades in with a short drop and floats as a rounded bordered panel', async () => {
  vi.useFakeTimers(); const s = await scene(); s.event('tabs-strip', 'on_size_change', { width: 792, height: 6 }); s.enter();
  const holder = () => s.byId('tabs-slide'), bar = () => s.byId('tabs-revealed');
  expect(holder()?.items.map((item: any) => item.styles.id?.[0])).toEqual(['tabs-revealed']);
  expect(holder()?.styles.opacity).toEqual([0]); expect(holder()?.styles.transition).toEqual(['opacity', { duration: SLIDE, easing: 'ease-out' }]);
  expect(s.byId('tabs-popup')?.styles.absolute).toBeDefined(); expect(s.byId('tabs-popup')?.styles.top).toEqual([4]);
  expect(s.byId('tabs-popup')?.styles.transition).toEqual(['top', { duration: SLIDE, easing: 'ease-out' }]);
  expect(holder()?.styles.w).toEqual([0]); expect(holder()?.styles.h).toEqual([0]); expect(bar()?.styles.invisible).toBeDefined();
  vi.advanceTimersByTime(16);
  expect(holder()?.styles.opacity).toEqual([1]); expect(s.byId('tabs-popup')?.styles.top).toEqual([10]);
  expect(bar()?.styles.rounded).toEqual([10]); expect(bar()?.styles.border_1).toBeDefined(); expect(bar()?.styles.border_color).toEqual(['#38383a']);
  // Eight pixels clear on both sides, so every corner shows.
  expect(s.byId('tabs-popup')?.styles.left).toEqual([8]); expect(bar()?.styles.w).toEqual([776]); expect(holder()?.styles.w).toEqual([776]);
  expect(bar()?.styles.h).toEqual([42]); expect(holder()?.styles.h).toEqual([42]);
});
test('the popup hit area follows only the visible bar through fade-out', async () => {
  vi.useFakeTimers(); const s = await scene(); s.event('tabs-strip', 'on_size_change', { width: 792, height: 6 });
  expect(s.byId('tabs-popup')?.styles.content).toBeUndefined();
  s.enter(); vi.advanceTimersByTime(16);
  expect(s.byId('tabs-slide')?.styles.w).toEqual([776]);
  expect(s.byId('tabs-slide')?.styles.h).toEqual([42]);
  expect(s.byId('tabs-revealed')?.styles.left ?? [0]).toEqual([0]);
  expect(s.byId('tabs-revealed')?.styles.top ?? [0]).toEqual([0]);
  s.leave(); vi.advanceTimersByTime(300);
  expect(s.byId('tabs-slide')?.styles.w).toEqual([776]);
  expect(s.byId('tabs-slide')?.styles.h).toEqual([42]);
  vi.advanceTimersByTime(SLIDE);
  expect(s.byId('tabs-popup')?.styles.content).toBeUndefined();
  expect(s.byId('tab-a')).toBeUndefined();
});
test('leaving fades the bar out before removing it and re-entry brings it back', async () => {
  vi.useFakeTimers(); const s = await scene(); s.enter(); vi.advanceTimersByTime(16); s.leave();
  vi.advanceTimersByTime(300); expect(s.leaving()).toBe(true);
  vi.advanceTimersByTime(SLIDE - 1); expect(s.full()).toBe(true);
  s.enter(); vi.advanceTimersByTime(SLIDE); expect(s.full()).toBe(true); expect(s.leaving()).toBe(false);
  vi.advanceTimersByTime(16); expect(s.byId('tabs-popup')?.styles.top).toEqual([10]);
  s.leave(); vi.advanceTimersByTime(300 + SLIDE); expect(s.full()).toBe(false);
});
test('leaving waits 300 milliseconds and re-entry cancels the pending hide', async () => {
  vi.useFakeTimers(); const s = await scene(); s.enter(); s.leave();
  vi.advanceTimersByTime(299); expect(s.full()).toBe(true);
  s.enter(); vi.advanceTimersByTime(1); expect(s.full()).toBe(true);
  s.leave(); vi.advanceTimersByTime(300); expect(s.leaving()).toBe(true); vi.advanceTimersByTime(SLIDE); expect(s.full()).toBe(false);
});
test('a context menu keeps the bar open until dismissal', async () => {
  vi.useFakeTimers(); const s = await scene(); s.enter();
  s.event('tab-a', 'on_mouse_down', 'right', {}); s.leave();
  vi.advanceTimersByTime(2000); expect(s.full()).toBe(true);
  expect(s.byId('tabs-context-menu')).toBeDefined();
  s.event('tabs-context-menu', 'on_key_down', { key: 'escape', modifiers: {}, stop_propagation() {} });
  vi.advanceTimersByTime(300); expect(s.leaving()).toBe(true); vi.advanceTimersByTime(SLIDE); expect(s.full()).toBe(false);
});
test('rename stays visible until save and sends the entered name', async () => {
  vi.useFakeTimers(); const s = await scene(); s.enter();
  s.event('tab-a', 'on_mouse_down', 'left', { click_count: 2 }); s.leave();
  vi.advanceTimersByTime(2000); expect(s.byId('tabs-rename')).toBeDefined();
  s.typeIn('tabs-rename', 'Updated name');
  s.event('tabs-rename-save', 'on_click', {});
  expect(s.calls).toContainEqual(['tab.rename', { id: 'a', name: 'Updated name' }]);
  vi.advanceTimersByTime(300); expect(s.leaving()).toBe(true); vi.advanceTimersByTime(SLIDE); expect(s.full()).toBe(false);
});
test.each(['   ', 'First', ' First '])('rename dismisses without sending the invalid or unchanged name %j', async name => {
  vi.useFakeTimers(); const s = await scene(); s.enter();
  s.event('tab-a', 'on_mouse_down', 'left', { click_count: 2 }); s.leave();
  s.typeIn('tabs-rename', name); s.event('tabs-rename-save', 'on_click', {});
  expect(s.calls.filter(([command]: any) => command === 'tab.rename')).toEqual([]);
  expect(s.byId('tabs-rename')).toBeUndefined();
  vi.advanceTimersByTime(300 + SLIDE); expect(s.full()).toBe(false);
});
test('the plus menu holds the row open until it closes', async () => {
  vi.useFakeTimers(); const s = await scene(); s.enter(); s.event('tab-new', 'on_click', {}); s.leave();
  vi.advanceTimersByTime(2000); expect(s.byId('tabs-new-menu')).toBeDefined();
  s.event('tabs-new-menu', 'on_key_down', { key: 'escape', modifiers: {} });
  vi.advanceTimersByTime(300); expect(s.leaving()).toBe(true); vi.advanceTimersByTime(SLIDE); expect(s.full()).toBe(false);
});
test('a second plus menu shows cached agents while refreshing instead of checking again', async () => {
  const s = await scene(), agent = { key: 'sample', name: 'Sample', installed: true, run: ['sh'], icon: 'shell.svg', tint: true };
  s.setAgentSource(async () => [agent]); s.enter(); s.event('tab-new', 'on_click', {});
  await Promise.resolve(); expect(s.byId('tabs-agent-sample')).toBeDefined();
  s.event('tabs-new-menu', 'on_key_down', { key: 'escape', modifiers: {} });
  let finish!: (agents: any[]) => void;
  s.setAgentSource(() => new Promise(resolve => { finish = resolve; })); s.event('tab-new', 'on_click', {});
  expect(s.byId('tabs-agent-sample')).toBeDefined();
  expect(nodes(s.byId('tabs-new-menu')).flatMap(node => node.items).filter(item => typeof item === 'string').join(' ')).not.toContain('Checking installed agents...');
  finish([{ ...agent, key: 'fresh', name: 'Fresh' }]); await Promise.resolve();
  expect(s.byId('tabs-agent-fresh')).toBeDefined(); expect(s.byId('tabs-agent-sample')).toBeUndefined();
});
test('the plus menu reads the stock cache for the active machine only', async () => {
  const s = await scene(), agent = { key: 'remote', name: 'Remote', installed: true, run: ['sh'], icon: 'shell.svg', tint: true };
  s.sharedValues.set('new-menu.agents', { '': [{ ...agent, key: 'local' }], 'remote.invalid': [agent] });
  s.space.machine = 'remote.invalid'; s.setAgentSource(() => new Promise(() => {}));
  s.enter(); s.event('tab-new', 'on_click', {});
  expect(s.byId('tabs-agent-remote')).toBeDefined(); expect(s.byId('tabs-agent-local')).toBeUndefined();
});
test('a reopened plus menu ignores results from an older request', async () => {
  const s = await scene(), resolve: ((agents: any[]) => void)[] = [];
  s.setAgentSource(() => new Promise(done => resolve.push(done)));
  s.enter(); s.event('tab-new', 'on_click', {});
  s.event('tabs-new-menu', 'on_key_down', { key: 'escape', modifiers: {} });
  s.event('tab-new', 'on_click', {});
  resolve[1]!([{ key: 'current', name: 'Current', installed: true, run: ['sh'], icon: 'shell.svg', tint: true }]);
  await Promise.resolve();
  expect(s.byId('tabs-agent-current')).toBeDefined();
  resolve[0]!([{ key: 'old', name: 'Old', installed: true, run: ['sh'], icon: 'shell.svg', tint: true }]);
  await Promise.resolve();
  expect(s.byId('tabs-agent-current')).toBeDefined();
  expect(s.byId('tabs-agent-old')).toBeUndefined();
});

test('a drag holds the bar open until release', async () => {
  vi.useFakeTimers(); const s = await scene(); s.enter(); s.event('tab-a', 'on_mouse_down', 'left', { click_count: 1 }); s.leave();
  vi.advanceTimersByTime(2000); expect(s.full()).toBe(true);
  s.event('tab-b', 'on_mouse_up', 'left', {});
  vi.advanceTimersByTime(300); expect(s.leaving()).toBe(true); vi.advanceTimersByTime(SLIDE); expect(s.full()).toBe(false);
  expect(s.calls).toContainEqual(['tab.move', { id: 'a', index: 2 }]);
});
test('releasing a drag over a terminal dismisses the bar without selecting a tab', async () => {
  vi.useFakeTimers(); const s = await scene(); s.enter();
  s.event('tab-a', 'on_mouse_down', 'left', { click_count: 1 }); s.leave();
  vi.advanceTimersByTime(2000); expect(s.full()).toBe(true);
  expect(s.byId('tabs-drag-capture')).toBeDefined();
  s.event('tabs-drag-capture', 'on_mouse_up', 'left', {});
  vi.advanceTimersByTime(300); expect(s.leaving()).toBe(true); vi.advanceTimersByTime(SLIDE); expect(s.full()).toBe(false);
  expect(s.calls).toEqual([]);
});

test('a keyboard tab change flashes for 1.5 seconds and rapid changes restart it', async () => {
  vi.useFakeTimers(); const s = await scene(); s.render();
  s.space.tabs[0]!.active = false; s.space.tabs[1]!.active = true; s.render();
  expect(s.full()).toBe(true); vi.advanceTimersByTime(1000);
  s.space.tabs[0]!.active = true; s.space.tabs[1]!.active = false; s.render();
  vi.advanceTimersByTime(1499); expect(s.full()).toBe(true);
  vi.advanceTimersByTime(1); expect(s.leaving()).toBe(true); vi.advanceTimersByTime(SLIDE); expect(s.full()).toBe(false);
});
test('a tab change during fade-out reveals the flash and hides after it ends', async () => {
  vi.useFakeTimers(); const s = await scene(); s.enter(); vi.advanceTimersByTime(16); s.leave();
  vi.advanceTimersByTime(350); expect(s.leaving()).toBe(true);
  s.space.tabs[0]!.active = false; s.space.tabs[1]!.active = true; s.render();
  vi.advanceTimersByTime(16); expect(s.byId('tabs-slide')?.styles.opacity).toEqual([1]);
  vi.advanceTimersByTime(1483); expect(s.byId('tabs-slide')?.styles.opacity).toEqual([1]);
  vi.advanceTimersByTime(1); expect(s.leaving()).toBe(true);
  vi.advanceTimersByTime(SLIDE); expect(s.full()).toBe(false);
});
test.each(['context', 'newMenu', 'renameTab', 'hold'] as const)('%s during fade-out reveals and holds the bar', async action => {
  vi.useFakeTimers(); const s = await scene(); s.enter(); vi.advanceTimersByTime(16); s.leave();
  vi.advanceTimersByTime(350);
  if (action === 'context') s.view.tabAuto.context(s.space.tabs[0], s.space, s.cx);
  else if (action === 'renameTab') s.view.tabAuto.renameTab(s.space.tabs[0], s.cx);
  else { if (action === 'hold') s.view.pressed = 0; s.view.tabAuto[action](s.cx); }
  vi.advanceTimersByTime(16); expect(s.byId('tabs-slide')?.styles.opacity).toEqual([1]);
  vi.advanceTimersByTime(2000); expect(s.byId('tabs-slide')?.styles.opacity).toEqual([1]);
});
test('the opt-out keeps the original row, stock menus and window buttons', async () => {
  const on = await scene(), off = await scene(false, true);
  expect(Boolean(on.byId('tab-a'))).not.toBe(Boolean(off.byId('tab-a')));
  expect(off.byId('tabs-strip')).toBeUndefined();
  expect(off.tabBlock.size.px).toBe(42);
  off.event('tab-new', 'on_click', {});
  expect(off.overlays).toEqual([{ mod: 'new-menu', kind: 'popup', width: 250, height: 512 }]);
  for (const [id, command] of [['minimize', 'window.minimize'], ['maximize', 'window.maximize'], ['close-window', 'window.close']] as const) {
    expect(off.byId(id)).toBeDefined();
    off.event(id, 'on_click', {});
    expect(off.calls).toContainEqual([command, undefined]);
  }
});
