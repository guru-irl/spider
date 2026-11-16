// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { loadSpacesAFiles, type SpacesAVersion } from './spaces-a-fixture.js';
import { replaySpacesBRecipe } from './spaces-b-fixture.js';
import { createUiModules } from './strict-mod-api.mjs';
import { identityPill } from '../../assets/shared/look.js';
import { middlePath } from '../../assets/shared/feed.js';

const ui = createUiModules();
const flat = (root: any): any[] => root && typeof root === 'object' ? [root, ...(root.items ?? []).flatMap(flat)] : [];
const texts = (root: any): string[] => typeof root === 'string' ? [root] : root && typeof root === 'object' ? (root.items ?? []).flatMap(texts) : [];
const byId = (root: any, id: string) => flat(root).find(node => node.styles?.id?.[0] === id);
const cx: any = { notify() {}, stop_propagation() {}, spawn() {} };
const colors = { foreground: '#eeeeee', dim: '#999999', muted: '#aaaaaa', hover: '#ffffff14', chrome: '#161618', working: '#eeeeee', blocked: '#ffff00', ansi1: '#ff0000', done: '#00ff00' };
function machine() {
  const source = readFileSync(new URL('../../assets/pane/machine.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
  return new Function('div', `${source}; return { paneMachineFact, panePresentation, paneTargetFacts, resolvePaneHeaderFacts, renderMachinePill, initPaneHeaderProjection, closePaneHeaderProjection };`)(ui['gpui-kit'].div);
}
const target: any = { coreId: 'core-remote', terminalId: 't7', address: 'core-remote/t7', createdMs: 42, identityLabels: { 'spider.session': 'session-1' }, alias: 'box-1.invalid', machineId: 'machine-1', kind: 'session', sessionId: 'session-1', generation: 'gen-1', homeEpoch: 1, runId: null, consoleId: null, name: 'Planner', cwd: '/old' };
const presentation: any = { id: 'pres-1', revision: 1, mode: 'proxy', role: 'agent', target, proxy: 'proxy-1', slot: { space: 's1', tab: 'tab-1', pane: 'pane-1' }, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null };
const proxyLabels: any = { 'spider.kind': 'pane-proxy', 'spider.pane-id': 'pres-1', 'spider.target-core': 'core-remote', 'spider.target-terminal': 't7' };
const header: any = { address: 'proxy-1', programIsAgent: false, nativeTitle: 'Node attach', nativeStatus: null, nativeCwd: '/mac/wrong', labels: proxyLabels };
const facts = (status = 'working', patch: any = {}) => ({ terminal: { address: 'core-remote/t7', labels: { 'spider.session': 'session-1' } }, createdMs: 42, title: 'π - Planner - project', app: 'pi', status, currentCwd: '/home/example/work', identityLabels: { 'spider.session': 'session-1' }, ...patch });
const keyed = (row: any) => ({ [JSON.stringify(['core-remote', 't7'])]: row });

function render(version: SpacesAVersion, options: { p?: any; labels?: any; presentations?: any[]; targetFacts?: any; bottom?: boolean; hover?: boolean } = {}) {
  const m = machine();
  const patches = JSON.parse(readFileSync(new URL('../../assets/look/cross-machine-patches.json', import.meta.url), 'utf8'));
  const source = replaySpacesBRecipe(version, loadSpacesAFiles(version), patches.versions[version]).pane!['main.js']!;
  const p = { pane: 'pane-1', tab: 'tab-1', terminal: 'proxy-1', title: 'Node attach', cwd: '/mac/wrong', status: null, program: { name: 'node', icon: 'node.svg' }, focused: true, ...options.p };
  const labels = options.labels ?? proxyLabels;
  const host: any = { panes: () => [p], props: () => ({ pane: 'pane-1' }), terminals: () => [{ address: p.terminal, labels }], theme: () => colors, home: () => '/not-home', run() {}, openOverlay() {}, nextCommand: () => new Promise(() => {}),
    layout: () => ({ content: { tab: 'active', pane: { header: { position: options.bottom ? 'bottom' : 'top' } } } }) };
  const ports: any = { ...ui['gpui-kit'], ...ui['gpui-base'], ...host, herdrApi: host, middlePath, identityPill, ...m, openPickerFromHost() {}, parkFocusedTerminal() {} };
  const code = source.replace(/^(?:(?:\/\* spider-look:[a-z0-9-]+ \*\/)\s*)*import .*;\s*$/gm, '').replace('export default class ', 'class ');
  const Pane = new Function('ports', `const {${Object.keys(ports).join(',')}}=ports;${code};return Pane;`)(ports);
  const pane = new Pane(); pane.init({}, cx); pane.hovered = !!options.hover;
  pane.machineSnapshot = { presentations: options.presentations ?? [presentation], targetFacts: options.targetFacts ?? keyed(facts()) };
  return pane.render(cx);
}

test('local agent has This computer after its name pill', () => {
  const localHeader = { ...header, address: 'local-t1', programIsAgent: true, nativeTitle: 'π - Planner - project', nativeStatus: 'working', nativeCwd: '/home/example/work', labels: {} };
  expect(machine().paneMachineFact(localHeader, [])).toEqual({ label: 'This computer', known: true });
  expect(machine().resolvePaneHeaderFacts(localHeader, [], {})).toMatchObject({ name: localHeader.nativeTitle, status: 'working', cwd: '/home/example/work' });
  for (const version of ['0.1.13', '0.1.16'] as const) {
    const root = render(version, { p: { terminal: 'local-t1', title: localHeader.nativeTitle, cwd: localHeader.nativeCwd, status: 'working', program: { key: 'pi', name: 'pi', agent: true } }, labels: {}, presentations: [], targetFacts: {} });
    expect(texts(root).slice(0, 3)).toEqual(['Planner', 'This computer', '/home/example/work']);
  }
});

test('a local reported agent gets a pill even when detected as a shell', () => {
  for (const version of ['0.1.13', '0.1.16'] as const) {
    const root = render(version, { p: { terminal: 'local-t1', app: 'codex', title: 'Assistant', cwd: '/home/example/work', status: 'working', program: { name: 'shell', shell: true, agent: false } }, labels: {}, presentations: [], targetFacts: {} });
    expect(texts(root)).toContain('This computer');
  }
});

test('shell detected proxy uses remote metadata', () => {
  const m = machine(); const resolved = m.resolvePaneHeaderFacts(header, [presentation], keyed(facts()));
  expect(resolved).toEqual({ name: 'Planner', status: 'working', cwd: '/home/example/work', machine: { label: 'box-1.invalid', known: true } });
  const pill = m.renderMachinePill(resolved.machine, colors, 'JetBrains Mono');
  expect(texts(pill)).toEqual(['box-1.invalid']);
  expect(pill.styles.bg).toEqual(['#ffffff14']);
  expect(pill.styles.tooltip).toEqual(['box-1.invalid']);
});

test.each(['subagent', 'console'])('viewer and console name their actual execution machine: %s', role => {
  const row = { ...presentation, role }; const m = machine();
  expect(m.paneMachineFact(header, [row])).toEqual({ label: 'box-1.invalid', known: true });
  expect(m.paneMachineFact({ ...header, address: 'local', labels: { 'spider.kind': role === 'subagent' ? 'subagent-viewer' : 'remote-console' } }, [])).toEqual({ label: 'This computer', known: true });
});

test('missing proxy metadata never says local', () => {
  const m = machine();
  for (const labels of [proxyLabels, { 'spider.kind': 'pane-proxy' }, { ...proxyLabels, 'spider.target-core': 'core-other' }]) {
    const result = m.resolvePaneHeaderFacts({ ...header, labels }, [], {});
    expect(result.machine).toEqual({ label: 'Machine unavailable', known: false });
    expect(result.cwd).toBeNull();
    expect(result.status).toBeNull();
  }
  expect(m.paneMachineFact({ ...header, labels: { ...proxyLabels, 'spider.target-terminal': 'other' } }, [presentation])).toEqual({ label: 'Machine unavailable', known: false });
  expect(m.paneMachineFact({ ...header, address: 'local', labels: {}, programIsAgent: false }, [])).toBeNull();
  expect(m.paneMachineFact({ ...header, address: 'box-1.invalid/t7', labels: { 'spider.kind': 'remote-console' } }, [])).toEqual({ label: 'Machine unavailable', known: false });
  const missingAlias = { ...presentation, target: { ...target, alias: null } };
  expect(m.paneMachineFact(header, [missingAlias])).toEqual({ label: 'Machine unavailable', known: false });
  const mismatchedNative = { ...presentation, mode: 'native', target: { ...target, address: 'local-t1' } };
  expect(m.paneMachineFact({ ...header, address: 'local-t1', programIsAgent: true, labels: {} }, [mismatchedNative])).toEqual({ label: 'Machine unavailable', known: false });
});

test('restarted or mislabeled target facts cannot replace the bound header', () => {
  const m = machine();
  for (const bad of [facts('error', { createdMs: 43 }), facts('error', { identityLabels: {} }), facts('error', { terminal: { address: 'core-other/t7', labels: { 'spider.session': 'session-1' } } })]) {
    const resolved = m.resolvePaneHeaderFacts(header, [presentation], keyed(bad));
    expect(resolved.cwd).toBeNull(); expect(resolved.status).toBeNull();
    expect(resolved.name).not.toBe('Node attach');
  }
  expect(m.resolvePaneHeaderFacts(header, [presentation], { [JSON.stringify(['core-other', 't7'])]: facts() }).status).toBeNull();
});

test.each(['working', 'blocked', 'error', 'done'])('remote proxy header uses target name status and foreground cwd: %s', status => {
  for (const version of ['0.1.13', '0.1.16'] as const) for (const bottom of [false, true]) {
    const root = render(version, { targetFacts: keyed(facts(status)), bottom, hover: true });
    const visible = texts(root);
    expect(visible.slice(0, 3)).toEqual(['Planner', 'box-1.invalid', '/home/example/work']);
    expect(visible).not.toContain('Node attach'); expect(visible).not.toContain('/mac/wrong');
    if (status === 'blocked') expect(visible).toContain('Needs you');
    if (status === 'error') expect(visible).toContain('Error');
    if (status === 'working') expect(flat(root).some(node => node.styles.spin?.[0] === 900)).toBe(true);
    if (status === 'done') expect(flat(root).some(node => node.styles.bg?.[0] === colors.done)).toBe(true);
    expect(byId(root, 'ph-x-pane-1')).toBeDefined();
  }
});

test('unnamed native agents preserve their native name and status', () => {
  for (const version of ['0.1.13', '0.1.16'] as const) {
    const root = render(version, { p: { terminal: 'local-t1', title: 'π - project', cwd: '/home/example/work', status: 'blocked', program: { key: 'pi', name: 'pi', agent: true } }, labels: {}, presentations: [], targetFacts: {} });
    expect(texts(root).slice(0, 3)).toEqual(['pi', 'This computer', '/home/example/work']);
    expect(texts(root)).toContain('Needs you');
  }
});

test('missing proxy metadata renders unavailable without the local proxy cwd', () => {
  for (const version of ['0.1.13', '0.1.16'] as const) {
    const root = render(version, { presentations: [], targetFacts: {} });
    expect(texts(root)).toContain('Machine unavailable');
    expect(texts(root)).not.toContain('This computer');
    expect(texts(root)).not.toContain('/mac/wrong');
  }
});

test('new remote agents without a registered session keep an agent machine pill', () => {
  const identityLabels = { 'spider.pane-operation': 'op-new' };
  const row = { ...presentation, role: 'agent', target: { ...target, kind: 'terminal', sessionId: null, generation: null, identityLabels } };
  const source = facts('working', { identityLabels, terminal: { address: 'core-remote/t7', labels: identityLabels } });
  expect(row.target.identityLabels).not.toHaveProperty('spider.session');
  const projected = machine().resolvePaneHeaderFacts(header, [row], keyed(source));
  expect(projected.machine).toEqual({ label: 'box-1.invalid', known: true });
  expect(projected.name).toBe('Planner');
  for (const version of ['0.1.13', '0.1.16'] as const) {
    const root = render(version, { presentations: [row], targetFacts: keyed(source) });
    expect(texts(root).slice(0, 3)).toEqual(['Planner', 'box-1.invalid', '/home/example/work']);
  }
});

test('remote console header names the console execution machine', () => {
  const row = { ...presentation, role: 'console', target: { ...target, kind: 'console', consoleId: 'console-1' } };
  const source = facts('done', { title: 'Console', identityLabels: { 'spider.session': 'session-1', 'spider.kind': 'remote-console', 'spider.display-name': 'Console' } });
  for (const version of ['0.1.13', '0.1.16'] as const) {
    const root = render(version, { presentations: [row], targetFacts: keyed(source) });
    expect(texts(root).slice(0, 3)).toEqual(['Console', 'box-1.invalid', '/home/example/work']);
  }
});

test('long escaped names and parent pills retain order with shrinkable machine text', () => {
  const row = { ...presentation, role: 'subagent', target: { ...target, kind: 'subagent', runId: 'run-1' } };
  const source = facts('working', { title: 'Worker', identityLabels: { 'spider.session': 'session-1', 'spider.kind': 'subagent-viewer', 'spider.display-name': 'Child <&> long', 'spider.parent-name': 'Parent long' }, terminal: { address: 'core-remote/t7', labels: { 'spider.session': 'session-1' } } });
  for (const version of ['0.1.13', '0.1.16'] as const) {
    const root = render(version, { presentations: [row], targetFacts: keyed(source), hover: true });
    expect(texts(root).slice(0, 3)).toEqual(['Child <&> long', 'box-1.invalid', 'Parent long']);
    const pill = flat(root).find(node => texts(node).length === 1 && texts(node)[0] === 'box-1.invalid');
    expect(pill.styles.flex_shrink_1).toBeDefined();
    expect(byId(root, 'ph-x-pane-1')).toBeDefined();
  }
});

test('long escaped session names remain text and shrink without losing controls', () => {
  const name = 'Planner<&>'.repeat(40);
  for (const version of ['0.1.13', '0.1.16'] as const) {
    const root = render(version, { p: { terminal: 'local-t1', title: `π - ${name} - project`, program: { key: 'pi', name: 'pi', agent: true } }, labels: {}, presentations: [], targetFacts: {}, hover: true });
    expect(texts(root).slice(0, 2)).toEqual([name, 'This computer']);
    const pill = flat(root).find(node => node.styles?.tooltip?.[0] === name);
    expect(pill.styles.max_w).toEqual([220]); expect(pill.styles.flex_shrink_1).toBeDefined();
    expect(byId(root, 'ph-x-pane-1')).toBeDefined();
  }
});

test('projection refresh uses a bounded snapshot and retains last verified data on failure', async () => {
  const m = machine(); const jobs: Promise<any>[] = []; let tick: Function | undefined; let failures = false;
  const host: any = { checking: () => false, appHome: () => '/fixture/app', readTextFile: async () => JSON.stringify({ version: 1, nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs' }),
    exec: vi.fn(async (_node: string, args: string[], options: any) => { expect(options.timeout).toBe(5000); const req = JSON.parse(args.at(-1)!); expect(req.op).toBe('snapshot');
      if (failures) throw new Error('offline'); return { code: 0, stdout: JSON.stringify({ version: 1, kind: 'snapshot', presentations: [presentation], targetFacts: keyed(facts()) }) }; }) };
  const context: any = { notify: vi.fn(), spawn(fn: Function) { const job = Promise.resolve().then(() => fn(context)); jobs.push(job); return job; }, timer: { every(_ms: number, fn: Function) { tick = fn; return { cancel: vi.fn() }; } } };
  const view: any = {}; m.initPaneHeaderProjection(view, context, host); await jobs[0];
  expect(view.machineSnapshot.presentations[0].id).toBe('pres-1');
  failures = true; tick!(context); await jobs.at(-1);
  expect(view.machineSnapshot.presentations[0].id).toBe('pres-1');
  m.closePaneHeaderProjection(view);
});
