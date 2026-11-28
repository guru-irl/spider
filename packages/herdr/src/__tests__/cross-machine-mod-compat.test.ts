// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { loadPublishedSpacesARecipe, loadSpacesAFiles, replaySpacesARecipe, type SpacesAFragments, type SpacesAVersion } from './spaces-a-fixture.js';
import { replaySpacesBRecipe } from './spaces-b-fixture.js';
import { createUiModules } from './strict-mod-api.mjs';
import { identityPill } from '../../assets/shared/look.js';
import { middlePath } from '../../assets/shared/feed.js';
import * as actions from '../../assets/machines/actions.js';

const fragments = (version: SpacesAVersion): SpacesAFragments => JSON.parse(readFileSync(new URL('../../assets/look/cross-machine-patches.json', import.meta.url), 'utf8')).versions[version];
const flat = (root: any): any[] => root && typeof root === 'object' ? [root, ...(root.items ?? []).flatMap(flat)] : [];
const byId = (root: any, id: string) => flat(root).find(node => node.styles?.id?.[0] === id);
const texts = (root: any): string[] => typeof root === 'string' ? [root] : root && typeof root === 'object' ? (root.items ?? []).flatMap(texts) : [];
const cx: any = { focus_handle: () => ({ focus() {} }), stop_propagation() {}, notify() {}, spawn(fn: Function) { return Promise.resolve().then(() => fn(cx)); } };
const inertCx: any = { ...cx, spawn() {} };
const local = { key: 'local', alias: null, label: 'This computer', coreId: 'core-local', machineId: null, state: 'connected' };
const remote = { key: 'box-2.invalid', alias: 'box-2.invalid', label: 'box-2.invalid', coreId: 'core-remote', machineId: 'machine-2', state: 'connected' };

function environment() {
  const ui = createUiModules(), calls: any[] = [], values = new Map<string, any>();
  const state: any = { props: {}, focus: { space: 's1', tab: 'tab-1', pane: 'pane-1', terminal: 't1' },
    spaces: [{ id: 's1', machine: null, active: true, tabs: [{ id: 'tab-1', name: 'tb1', active: true }] }],
    panes: [{ pane: 'pane-1', tab: 'tab-1', terminal: 't1', title: 'Terminal', cwd: '/home/example', status: null, focused: true, program: { name: 'shell', shell: true } }],
    agents: [{ key: 'pi', name: 'Pi', icon: 'pi.svg', installed: true, run: ['pi', '--local'] }], failAgents: false };
  const theme = Object.fromEntries(['dim','foreground','muted','hover','chrome','border','raised','selected','popover','working','blocked','done','ansi1'].map(k => [k, '#777777']));
  const host: any = {
    props: () => state.props, focused: () => state.focus, spaces: () => state.spaces, panes: () => state.panes,
    terminals: () => [{ address: 't1', labels: {} }], theme: () => theme, home: () => '/home/example',
    window: () => ({ platform: 'macos', buttons: false }), keys: () => [], settings: () => ({ zoom: 1 }), layout: () => ({}),
    shared: (k: string) => values.get(k), setShared: (k: string, v: unknown) => values.set(k, v),
    run: (...args: unknown[]) => calls.push(['run', ...args]), notify: (...args: unknown[]) => calls.push(['notify', ...args]),
    openOverlay: (spec: any) => { calls.push(['overlay', spec]); return 'overlay'; }, closeOverlay: (...args: unknown[]) => calls.push(['close', ...args]),
    knownAgents: async (arg: any) => { calls.push(['knownAgents', arg]); if (state.failAgents) throw new Error('offline'); return state.agents; },
    appHome: () => '/fixture/app', readTextFile: async () => JSON.stringify({ version: 1, nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs' }),
    exec: async (_cmd: string, args: string[]) => { const req = JSON.parse(args.at(-1)!); calls.push(['request', req]);
      return { code: 0, stdout: JSON.stringify(req.op === 'snapshot' ? { version: 1, kind: 'snapshot', machines: [local, remote] } : { version: 1, kind: 'outcome', outcome: { status: 'complete' } }) }; },
    nextCommand: () => new Promise(() => {}),
  };
  const machineSource = readFileSync(new URL('../../assets/pane/machine.js', import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
  const machine = new Function('div', `${machineSource}; return { panePresentation, paneTargetFacts, resolvePaneHeaderFacts, renderMachinePill, initPaneHeaderProjection, closePaneHeaderProjection };`)(ui['gpui-kit'].div);
  const ports: any = { ...ui['gpui-kit'], ...ui['gpui-base'], ...host, herdrApi: host, machineHerdr: host, ...actions, ...machine, middlePath, identityPill,
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) }, localStorage: { getItem: () => null, setItem() {} },
    initTabAutoHide: (view: any) => { view.tabAuto = { wrapTab: (_tab: any, el: any) => el, wrapNew: (el: any) => el, newMenu: () => calls.push(['oldMenu']), release() {} }; },
    renderTabAutoHide: (_view: any, row: any) => row, closeTabAutoHide() {}, parkFocusedTerminal() {} };
  return { host, ports, calls, state };
}
function view(source: string, className: string, ports: any, context: any = cx) {
  const code = source.replace(/^(?:(?:\/\* spider-look:[a-z0-9-]+ \*\/)\s*)*import .*;\s*$/gm, '').replace('export default class ', 'class ');
  const Ctor = new Function('ports', `const {${Object.keys(ports).filter(key => key !== className).join(',')}}=ports;${code};return ${className};`)(ports);
  const result = new Ctor(); result.init({}, context); return result;
}

test.each(['{', 'null', '[]'])('0.1.18 tabs render and switch tabs with invalid saved panels %s', saved => {
  const h = environment();
  h.ports.localStorage.getItem = (key: string) => key === 'panels' ? saved : null;
  h.ports.layout = () => ({ id: 'root', children: [{ id: 'panel', hidden: true, children: [{ id: 'panel-body' }] }] });
  const output = replaySpacesBRecipe('0.1.18', loadSpacesAFiles('0.1.18'), fragments('0.1.18'));
  const root = view(output.tabs!['main.js']!, 'Tabs', h.ports, inertCx).render(inertCx);
  expect(byId(root, 'tab-tab-1')).toBeDefined();
  const scroll = byId(root, 'tab-scroll');
  expect(scroll.styles.track_scroll).toBeDefined();
  root.events.on_scroll_wheel({ delta_lines: { y: -1 } }, cx);
  expect(h.calls).toContainEqual(['run', 'tab.next']);
});

for (const version of ['0.1.13', '0.1.16', '0.1.18'] as const) {
  test(`${version}: B replay verifies A, exact anchors and repeated output`, () => {
    const clean = loadSpacesAFiles(version), recipe = loadPublishedSpacesARecipe(version), b = fragments(version);
    const afterA = replaySpacesARecipe(version, clean, recipe.aFragments, recipe);
    for (const [mod, records] of Object.entries(b)) for (const patch of records) {
      expect(patch.replacement).not.toBe('');
      expect(afterA[mod]![patch.file]!.split(patch.anchor)).toHaveLength(2);
    }
    const output = replaySpacesBRecipe(version, clean, b);
    expect(replaySpacesBRecipe(version, output, b)).toEqual(output);
    const changed = structuredClone(afterA);
    changed.pane!['main.js'] += '\nchanged A output';
    expect(() => replaySpacesBRecipe(version, changed, b)).toThrow();
    for (const marker of ['controlled-session-close', 'spider-header-name', 'style-2', 'a-pane-park']) expect(output.pane!['main.js']).toContain(`/* spider-look:${marker} */`);
  });

  test.each([false, true])(`${version}: tab plus shows machines before new menu (autohide %s)`, autoHide => {
    const h = environment(); h.state.props = { autoHideTabs: autoHide };
    const output = replaySpacesBRecipe(version, loadSpacesAFiles(version), fragments(version));
    const tabs = view(output.tabs!['main.js']!, 'Tabs', h.ports, inertCx);
    const root = tabs.render(inertCx); byId(root, 'tab-new').events.on_click({}, cx);
    expect(h.calls.filter(c => c[0] === 'overlay').map(c => c[1].mod)).toEqual(['spider-machine-picker']);
    expect(h.calls.find(c => c[0] === 'overlay')[1].props.continuation).toBe('menu');
    expect(h.calls.filter(c => c[0] === 'run' || c[0] === 'oldMenu')).toEqual([]);
    if (version !== '0.1.13') expect(byId(root, 'tab-scroll').styles.track_scroll).toBeDefined();
  });

  test(`${version}: header split buttons preserve their clicked anchor`, () => {
    const h = environment(); h.state.props = { pane: 'pane-1' };
    const output = replaySpacesBRecipe(version, loadSpacesAFiles(version), fragments(version));
    const pane = view(output.pane!['main.js']!, 'Pane', h.ports, inertCx); pane.hovered = true;
    for (const [id, place] of [['ph-r-pane-1', 'right'], ['ph-d-pane-1', 'down']] as const) {
      h.calls.length = 0; byId(pane.render(cx), id).events.on_click({}, cx);
      expect(h.calls.filter(c => c[0] === 'overlay').map(c => c[1].mod)).toEqual(['spider-machine-picker']);
      expect(h.calls.find(c => c[0] === 'overlay')[1].props.intent).toMatchObject({ place, anchor: { space: 's1', tab: 'tab-1', pane: 'pane-1' } });
      expect(h.calls.filter(c => c[0] === 'run')).toEqual([]);
    }
  });

  test(`${version}: menu split and new-tab entries await a machine`, () => {
    const h = environment(); const output = replaySpacesBRecipe(version, loadSpacesAFiles(version), fragments(version));
    h.state.props = { tab: 'pane', target: { pane: 'pane-1', terminal: 't1' }, overlay: 'old' };
    const menu = view(output.menu!['main.js']!, 'Menu', h.ports, inertCx);
    for (const [label, place] of [['Split right', 'right'], ['Split down', 'down']] as const) {
      h.calls.length = 0;
      flat(menu.render(cx)).find(node => /^mi-\d+$/.test(node.styles?.id?.[0]) && texts(node).includes(label)).events.on_click({}, cx);
      expect(h.calls.filter(c => c[0] === 'overlay').map(c => c[1].mod)).toEqual(['spider-machine-picker']);
      expect(h.calls.find(c => c[0] === 'overlay')[1].props.intent).toMatchObject({ place, anchor: { pane: 'pane-1' } });
      expect(h.calls.filter(c => c[0] === 'run')).toEqual([]);
    }
    h.state.props = { tab: 'tab', target: { id: 'tab-1', space: 's1' }, overlay: 'old' };
    h.calls.length = 0; byId(menu.render(cx), 'mi-1').events.on_click({}, cx);
    expect(h.calls.filter(c => c[0] === 'overlay').map(c => c[1].mod)).toEqual(['spider-machine-picker']);
    expect(h.calls.filter(c => c[0] === 'run')).toEqual([]);
  });

  test(`${version}: layout terminal block has no split action`, () => {
    const h = environment(); h.state.panes = [];
    h.state.props = { tab: 'pane', target: { pane: 'layout-block', terminal: 't1' }, overlay: 'old' };
    const output = replaySpacesBRecipe(version, loadSpacesAFiles(version), fragments(version));
    const menu = view(output.menu!['main.js']!, 'Menu', h.ports, inertCx);
    expect(texts(menu.render(cx))).not.toContain('Split right');
    expect(texts(menu.render(cx))).not.toContain('Split down');
  });

  test(`${version}: selected menu probes destination and sends only the agent key`, async () => {
    const h = environment();
    const intent = { operationId: 'menu-operation', space: 's1', place: 'tab' as const, anchor: null, program: { kind: 'shell' as const } } as any;
    const ticket = actions.issueMenuTicket(intent, remote as any, h.host);
    h.state.props = { machineTicket: ticket, overlay: 'menu' };
    h.state.agents = [{ key: 'pi', name: 'Pi', icon: 'pi.svg', installed: true, run: ['pi', '--session', '/home/example/session.jsonl'] }];
    const output = replaySpacesBRecipe(version, loadSpacesAFiles(version), fragments(version));
    const menu = view(output['new-menu']!['main.js']!, 'NewMenu', h.ports);
    await vi.waitFor(() => expect(h.calls.find(c => c[0] === 'knownAgents')).toBeDefined());
    await vi.waitFor(() => expect(byId(menu.render(), 'pi')).toBeDefined());
    expect(h.calls.find(c => c[0] === 'knownAgents')[1]).toEqual({ on: 'box-2.invalid' });
    byId(menu.render(), 'pi').events.on_click();
    await vi.waitFor(() => expect(h.calls.filter(c => c[0] === 'request' && c[1].op === 'open')).toHaveLength(1));
    const request = h.calls.find(c => c[0] === 'request' && c[1].op === 'open')[1];
    expect(request).toMatchObject({ machineKey: 'box-2.invalid', intent: { program: { kind: 'agent', key: 'pi' } } });
    expect(JSON.stringify(request)).not.toContain('--session');
    byId(menu.render(), 'pi').events.on_click();
    await Promise.resolve();
    expect(h.calls.filter(c => c[0] === 'request' && c[1].op === 'open')).toHaveLength(1);
  });

  test(`${version}: menu without a selection ticket opens a picker`, async () => {
    const h = environment(); h.state.props = { overlay: 'menu' };
    const output = replaySpacesBRecipe(version, loadSpacesAFiles(version), fragments(version));
    const menu = view(output['new-menu']!['main.js']!, 'NewMenu', h.ports);
    await vi.waitFor(() => expect(byId(menu.render(), 'pi')).toBeDefined());
    byId(menu.render(), 'terminal').events.on_click();
    expect(h.calls.filter(c => c[0] === 'overlay').map(c => c[1].mod)).toEqual(['spider-machine-picker']);
    expect(h.calls.filter(c => c[0] === 'run')).toEqual([]);
  });

  test(`${version}: direct new-menu keyboard agent selection opens a picker`, async () => {
    const h = environment(); h.state.props = { overlay: 'menu' };
    const output = replaySpacesBRecipe(version, loadSpacesAFiles(version), fragments(version));
    const menu = view(output['new-menu']!['main.js']!, 'NewMenu', h.ports);
    await vi.waitFor(() => expect(byId(menu.render(), 'pi')).toBeDefined());
    menu.render().events.on_key_down({ key: '1', modifiers: {} });
    const opened = h.calls.filter(c => c[0] === 'overlay');
    expect(opened.map(c => c[1].mod)).toEqual(['spider-machine-picker']);
    expect(opened[0][1].props.intent.program).toEqual({ kind: 'agent', key: 'pi' });
    expect(h.calls.filter(c => c[0] === 'run')).toEqual([]);
  });

  test(`${version}: expired menu selection cannot open or fall back to another picker`, async () => {
    const h = environment(); let now = 1000; h.host.now = () => now;
    const intent = { operationId: 'old-operation', space: 's1', place: 'tab', anchor: null, program: { kind: 'shell' } } as any;
    const ticket = actions.issueMenuTicket(intent, remote as any, h.host); now += 60_001;
    h.state.props = { overlay: 'menu', machineTicket: ticket };
    const output = replaySpacesBRecipe(version, loadSpacesAFiles(version), fragments(version));
    const menu = view(output['new-menu']!['main.js']!, 'NewMenu', h.ports);
    byId(menu.render(), 'terminal').events.on_click();
    await Promise.resolve();
    expect(h.calls.filter(c => c[0] === 'overlay' || c[0] === 'request' || c[0] === 'run')).toEqual([]);
    expect(h.calls.filter(c => c[0] === 'notify')).toHaveLength(1);
    expect(h.calls.filter(c => c[0] === 'knownAgents')).toEqual([]);
  });

  test(`${version}: new-menu retains its failure message`, async () => {
    const h = environment(); h.state.failAgents = true; h.state.agents = []; h.state.props = { overlay: 'menu' };
    const output = replaySpacesBRecipe(version, loadSpacesAFiles(version), fragments(version));
    const menu = view(output['new-menu']!['main.js']!, 'NewMenu', h.ports);
    await vi.waitFor(() => expect(texts(menu.render())).toContain(version === '0.1.13' ? 'Could not load agents' : 'Could not check installed agents'));
  });
}
