// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createAppClient } from '../client/app.js';
import { createHcClient } from '../client/hc.js';
import { HerdrError } from '../client/parse.js';
import { createTerminalRegistry, hash } from '../sessions/registry.js';
import { inspectRoamPlacement } from '../roam-placement.js';
import { parsePaneTarget } from '../panes/codec.js';
import type { PaneTarget } from '../panes/types.js';
import { createPanePlacementStore } from '../panes/store.js';
import { createRoamPlacement, rememberRoamSlot } from '../roam-placement.js';
import { createClientFixture } from './testutil.js';
import type { AppClient, HcClient, Owner, SpaceId, TabId } from '../contracts.js';

const ready = (terminal: string) => ({ origin: "hub-operation" as const, opId: 'op', sessionId: 'session-1', epoch: 1, cwd: '/work', file: '/work/session.jsonl', core: 'remote-core', terminal });
const slot = { space: 's1' as SpaceId, tab: 'tb1' as TabId };
async function fixture() {
  const f = await createClientFixture();
  const stateRoot = join(f.root, 'roam', 'placement');
  const hc = createHcClient({ binary: f.hcBinary, env: f.localEnv });
  const app = createAppClient({ binary: f.appBinary, env: f.localEnv });
  const registry = createTerminalRegistry(stateRoot);
  const owner = { sessionId: 'session-1', generation: 'g1', terminal: { coreId: 'local-core', terminalId: 't1', address: 't1', socket: f.localSocket, sessionNamespace: f.namespace }, cwd: '/work', sessionFile: null, name: null } as Owner;
  await registry.record({ owner, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: f.root, extensionArguments: [] } });
  await writeFile(join(f.root, 'app.json'), JSON.stringify({ focusedPane: 'p1', spaces: [{ id: 's1', tabs: [{ id: 'tb1', terminals: [{ terminal: 't1', pane: 'p1' }] }] }] }));
  const delegations: Array<{ target: PaneTarget; slot: unknown }> = [];
  let available = true;
  const presentation = {
    async resolveTarget(row: ReturnType<typeof ready>) {
      if (!available) return null;
      if (!row.terminal.includes('/') && !(await hc.machines()).some(machine => machine.id === row.core && machine.state === 'connected')) return null;
      return parsePaneTarget({ coreId: row.core, terminalId: row.terminal.split('/').at(-1), address: row.core + '/' + row.terminal.split('/').at(-1), createdMs: 10,
        identityLabels: { 'spider.session': row.sessionId, 'spider.generation': 'g1' }, alias: 'box-1.invalid', machineId: null,
        kind: 'session', sessionId: row.sessionId, generation: 'g1', homeEpoch: row.epoch, runId: null, consoleId: null, name: null, cwd: '/work' });
    },
    async presentReadyTarget(target: PaneTarget) {
      const slot = (await createPanePlacementStore(stateRoot).read()).slots.find(slot => slot.session === target.sessionId);
      delegations.push({ target, slot: slot ? { space: slot.space, tab: slot.tab } : null });
      return { status: 'complete' as const, reason: 'service-presented', presentation: null };
    },
  };
  const create = (client: AppClient | null = app) => createRoamPlacement({ hc, app: client, registry, hcBinary: f.hcBinary, stateRoot, presentation });
  const legacy = async (address = 't2', remote = 'box-1.invalid/t5') => {
    const core = JSON.parse(await readFile(join(f.root, 'core.json'), 'utf8'));
    core.terminals.push({ address, parent: null, pid: process.pid, labels: { 'spider.kind': 'roam-proxy', 'spider.session': 'session-1', 'spider.owner-terminal': remote, 'spider.owner-core': 'remote-core', 'herdr.space': 's1', 'herdr.tab': 'tb1' }, state: 'live', status: null, exit_code: null, reason: null, signal: null, finished_ms: null });
    await f.configure({ terminals: core.terminals });
    await createPanePlacementStore(stateRoot).update(state => ({ ...state, attempts: [...state.attempts, { session: 'session-1', remote, core: 'remote-core', proxy: address, closed: false, localOwners: [hash(JSON.stringify([owner.terminal.coreId, owner.terminal.terminalId, owner.terminal.socket, owner.terminal.sessionNamespace]))] }] }));
    const layout = JSON.parse(await readFile(join(f.root, 'app.json'), 'utf8'));
    layout.spaces[0].tabs[0].terminals.push({ terminal: address, pane: 'p-' + address });
    await writeFile(join(f.root, 'app.json'), JSON.stringify(layout));
  };
  const close = async () => { await hc.dispose(); await f.close(); };
  const runs = async () => (await f.calls()).filter(call => call.argv[0] === 'run');
  return { f, hc, app, registry, stateRoot, create, close, runs, delegations, presentation, legacy, unavailable: () => { available = false; } };
}


function delegated(terminal = 't5', space = 's1', tab = 'tb1', core = 'remote-core', session = 'session-1') {
  return { target: { coreId: core, terminalId: terminal, address: `${core}/${terminal}`, createdMs: 10,
    identityLabels: { 'spider.session': session, 'spider.generation': 'g1' }, alias: 'box-1.invalid', machineId: null, kind: 'session', sessionId: session, generation: 'g1', homeEpoch: 1,
    runId: null, consoleId: null, name: null, cwd: '/work' }, slot: { space, tab } };
}
test('closed app and core never auto-start', async () => {
  const h = await fixture();
  try {
    await h.f.stopCore();
    const placement = h.create(null);
    await expect(placement.reconcile([ready('box-1.invalid/t5')])).rejects.toMatchObject({ code: 'core-unavailable' });
    const startAppOrCoreCalls = await h.f.calls();
    expect(startAppOrCoreCalls).toEqual([]);
    expect(await readFile(join(h.f.root, 'app-calls.jsonl'), 'utf8')).toBe('');
  } finally { await h.close(); }
}, 5000);

test('placement delegates each readiness without launching a legacy proxy', async () => {
  const h = await fixture();
  try {
    const p = h.create();
    expect(await p.reconcile([ready('box-1.invalid/t5')])).toEqual({ pending: [] });
    expect(await p.reconcile([ready('box-1.invalid/t5')])).toEqual({ pending: [] });
    expect(h.delegations).toEqual([delegated(), delegated()]);
    expect(await h.runs()).toEqual([]);
    expect(h.delegations[0].target.sessionId).toBe('session-1');
    expect(h.delegations[0].target.generation).toBe('g1');
    expect(h.delegations[0].target.homeEpoch).toBe(1);
    expect(h.delegations[0].target.coreId).toBe('remote-core');
    expect(h.delegations[0].target.address).toBe('remote-core/t5');
    const layout = JSON.parse(await readFile(join(h.f.root, 'app.json'), 'utf8'));
    expect(layout.focusedPane).toBe('p1');
    const appCalls = (await readFile(join(h.f.root, 'app-calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
    expect(appCalls.every(call => call[0] !== 'do')).toBe(true);
    await h.create().reconcile([ready('box-1.invalid/t6')]);
    expect(h.delegations).toEqual([delegated(), delegated(), delegated('t6')]);
    expect((await h.f.calls()).filter(call => ['kill', 'rm', 'label'].includes(call.argv[0]) && call.argv[1].includes('/'))).toEqual([]);
    expect((await stat(join(h.stateRoot, 'roam-placement.json'))).mode & 0o777).toBe(0o600);
  } finally { await h.close(); }
}, 5000);

test('prunes only proven-removed slots and retains active or unknown sessions', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    await rememberRoamSlot(h.stateRoot, 'removed-session', slot);
    await rememberRoamSlot(h.stateRoot, 'unknown-session', slot);
    await rememberRoamSlot(h.stateRoot, 'pending-session', slot);
    const p = createRoamPlacement({ hc: h.hc, app: null, registry: h.registry, hcBinary: h.f.hcBinary, stateRoot: h.stateRoot,
      removedSessions: async sessions => new Set(sessions.filter(session => session !== 'unknown-session')) });
    expect(await p.reconcile([{ ...ready('unresolved'), sessionId: 'pending-session' }])).toEqual({ pending: ['unresolved'] });
    const state = JSON.parse(await readFile(join(h.stateRoot, 'roam-placement.json'), 'utf8')) as { slots: Array<{ session: string }> };
    expect(state.slots.map(entry => entry.session).sort()).toEqual(['pending-session', 'session-1', 'unknown-session']);
    expect(await h.runs()).toEqual([]);
  } finally { await h.close(); }
}, 5000);

test('prunes a proven-removed slot with a stale terminal association', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    await h.hc.rm(h.f.address('t1'));
    const p = createRoamPlacement({ hc: h.hc, app: null, registry: h.registry, hcBinary: h.f.hcBinary, stateRoot: h.stateRoot,
      removedSessions: async sessions => new Set(sessions) });
    expect(await p.reconcile([])).toEqual({ pending: [] });
    const state = JSON.parse(await readFile(join(h.stateRoot, 'roam-placement.json'), 'utf8')) as { slots: Array<{ session: string }> };
    expect(state.slots).toEqual([]);
    expect(await h.registry.list()).toHaveLength(1);
    expect(await h.runs()).toEqual([]);
  } finally { await h.close(); }
}, 5000);

test('retains a slot when its associated terminal cannot be observed', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    const hc: HcClient = { ...h.hc, async get() { throw new HerdrError('core-unavailable', 'fixture unavailable'); } };
    const p = createRoamPlacement({ hc, app: null, registry: h.registry, hcBinary: h.f.hcBinary, stateRoot: h.stateRoot,
      removedSessions: async sessions => new Set(sessions) });
    expect(await p.reconcile([])).toEqual({ pending: [] });
    const state = JSON.parse(await readFile(join(h.stateRoot, 'roam-placement.json'), 'utf8')) as { slots: Array<{ session: string }> };
    expect(state.slots.map(entry => entry.session)).toEqual(['session-1']);
    expect(await h.runs()).toEqual([]);
  } finally { await h.close(); }
}, 5000);

test('pruning a removed slot preserves the closed proxy claim for that terminal', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'removed-session', slot);
    const row = { ...ready('box-1.invalid/t5'), sessionId: 'removed-session' };
    const p = createRoamPlacement({ hc: h.hc, app: null, registry: h.registry, hcBinary: h.f.hcBinary, stateRoot: h.stateRoot,
      removedSessions: async sessions => new Set(sessions) });
    expect(await p.reconcile([row])).toEqual({ pending: [row.terminal] });
    await h.legacy();
    await h.hc.rm(h.f.address('t2'));
    expect(await p.reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(await p.reconcile([])).toEqual({ pending: [] });
    const state = JSON.parse(await readFile(join(h.stateRoot, 'roam-placement.json'), 'utf8')) as { slots: Array<{ session: string }> };
    expect(state.slots.some(entry => entry.session === 'removed-session')).toBe(false);
    await rememberRoamSlot(h.stateRoot, 'removed-session', slot);
    expect(await p.reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(h.delegations).toEqual([]);
    expect(await h.runs()).toEqual([]);
  } finally { await h.close(); }
}, 5000);

test('pending placement survives app closure', async () => {
  const h = await fixture();
  try {
    const unplacedTerminal = 'box-1.invalid/t5';
    h.unavailable();
    expect(await h.create(null).reconcile([ready(unplacedTerminal)])).toEqual({ pending: [unplacedTerminal] });
    expect(await h.runs()).toHaveLength(0);
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    expect(await h.create(null).reconcile([ready(unplacedTerminal)])).toEqual({ pending: [unplacedTerminal] });
    expect(h.delegations).toEqual([]);
    expect(await h.create().reconcile([ready(unplacedTerminal)])).toEqual({ pending: [unplacedTerminal] });
    expect((await createPanePlacementStore(h.stateRoot).read()).slots).toEqual([{ session: 'session-1', ...slot }]);
  } finally { await h.close(); }
}, 5000);

test('a lost legacy launch reply stays pending without a second launcher', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    const store = createPanePlacementStore(h.stateRoot);
    const attempt = { session: 'session-1', remote: 'box-1.invalid/t5', core: 'remote-core', proxy: null, closed: false, localOwners: [], failure: { attempts: 1, retryable: false } };
    await store.update(state => ({ ...state, attempts: [attempt] }));
    const before = (await store.read()).attempts;
    const p = createRoamPlacement({ hc: h.hc, app: null, registry: h.registry, hcBinary: h.f.hcBinary, stateRoot: h.stateRoot });
    const row = ready('box-1.invalid/t5');
    expect(await p.reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(await p.reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(h.delegations).toEqual([]);
    expect(await h.runs()).toEqual([]);
    expect((await store.read()).attempts).toEqual(before);
    expect(await inspectRoamPlacement(h.stateRoot)).toEqual([{ session: 'session-1', remote: 'box-1.invalid/t5', status: 'uncertain' }]);
    expect((await store.read()).slots).toEqual([{ session: 'session-1', ...slot }]);
  } finally { await h.close(); }
}, 5000);

test('concurrent reconciliations delegate without legacy launches', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    await Promise.all([h.create(null).reconcile([ready('box-1.invalid/t5')]), h.create(null).reconcile([ready('box-1.invalid/t5')])]);
    expect(h.delegations).toEqual([delegated(), delegated()]);
    expect(await h.runs()).toEqual([]);
  } finally { await h.close(); }
}, 5000);

test('a moved proxy teaches the slot for the next terminal', async () => {
  const h = await fixture();
  try {
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    await h.legacy();
    const layout = JSON.parse(await readFile(join(h.f.root, 'app.json'), 'utf8'));
    const oldTab = layout.spaces[0].tabs[0];
    oldTab.terminals = oldTab.terminals.filter((row: { terminal: string }) => row.terminal !== 't2');
    layout.spaces.push({ id: 's2', tabs: [{ id: 'tb2', terminals: [{ terminal: 't2', pane: 'p2' }] }] });
    await h.hc.setLabels(h.f.address('t2'), { 'herdr.space': 's2', 'herdr.tab': 'tb2' });
    await writeFile(join(h.f.root, 'app.json'), JSON.stringify(layout));
    await h.create().reconcile([ready('box-1.invalid/t6')]);
    expect(h.delegations).toEqual([delegated(), delegated('t6', 's2', 'tb2')]);
    expect((await createPanePlacementStore(h.stateRoot).read()).slots).toContainEqual({ session: 'session-1', space: 's2', tab: 'tb2' });
  } finally { await h.close(); }
}, 5000);

test('only exited proxies with matching ownership are removed', async () => {
  const h = await fixture();
  try {
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    await h.legacy();
    const state = JSON.parse(await readFile(join(h.f.root, 'core.json'), 'utf8'));
    const proxy = state.terminals.find((item: { address: string }) => item.address === 't2');
    proxy.state = 'finished'; proxy.exit_code = 0; proxy.reason = 'exited'; proxy.finished_ms = 1234;
    proxy.labels['spider.session'] = 'another-session';
    await h.f.configure({ terminals: state.terminals });
    await h.create(null).reconcile([ready('box-1.invalid/t6')]);
    expect((await h.hc.get(h.f.address('t2'))).state).toBe('finished');
    await h.legacy('t3', 'box-1.invalid/t6');
    const state2 = JSON.parse(await readFile(join(h.f.root, 'core.json'), 'utf8'));
    const second = state2.terminals.find((item: { address: string }) => item.address === 't3');
    second.state = 'finished'; second.exit_code = 0; second.reason = 'exited'; second.finished_ms = 1234;
    await h.f.configure({ terminals: state2.terminals });
    await h.create(null).reconcile([ready('box-1.invalid/t7')]);
    await expect(h.hc.get(h.f.address('t3'))).rejects.toMatchObject({ code: 'not_found' });
    expect((await h.hc.get(h.f.address('t2'))).labels['spider.session']).toBe('another-session');
  } finally { await h.close(); }
}, 5000);


test('closing a pane without removing its terminal does not reopen it', async () => {
  const h = await fixture();
  try {
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    await h.legacy();
    const layout = JSON.parse(await readFile(join(h.f.root, 'app.json'), 'utf8'));
    layout.spaces[0].tabs[0].terminals = layout.spaces[0].tabs[0].terminals.filter((row: { terminal: string }) => row.terminal !== 't2');
    await h.hc.setLabels(h.f.address('t2'), { 'herdr.space': null, 'herdr.tab': null });
    await writeFile(join(h.f.root, 'app.json'), JSON.stringify(layout));
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    await expect(h.app.ownerPlacement(h.f.address('t2'))).rejects.toMatchObject({ code: 'owner-unplaced' });
    expect(h.delegations).toEqual([delegated(), delegated()]);
    expect((await h.hc.get(h.f.address('t2'))).state).toBe('live');
  } finally { await h.close(); }
}, 5000);

test('resolves an unqualified terminal by its connected core identity', async () => {
  const h = await fixture();
  try {
    await h.f.configure({ machines: [{ id: 'remote-core', name: 'box-1.invalid', host: 'box-1.invalid', target: 'box-1.invalid', state: 'connected', session: 'remote' }] });
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    expect(await h.create(null).reconcile([ready('t5')])).toEqual({ pending: [] });
    expect(h.delegations).toEqual([delegated()]);
  } finally { await h.close(); }
}, 5000);

test('an unresolved core remains pending without a launch', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    expect(await h.create(null).reconcile([ready('t5')])).toEqual({ pending: ['t5'] });
    expect(await h.runs()).toHaveLength(0);
  } finally { await h.close(); }
}, 5000);


test('a leading-dash alias never becomes an executable attach address', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    expect(await h.create(null).reconcile([ready('-box.invalid/t5')])).toEqual({ pending: [] });
    expect(h.delegations).toEqual([delegated()]);
    expect(await h.runs()).toEqual([]);
  } finally { await h.close(); }
}, 5000);

test('one remote terminal cannot acquire proxies for two sessions', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    await rememberRoamSlot(h.stateRoot, 'session-2', slot);
    h.presentation.resolveTarget = async row => row.sessionId === 'session-2' ? null : parsePaneTarget(delegated().target);
    const terminal = 'box-1.invalid/t5';
    const result = await h.create(null).reconcile([ready(terminal), { ...ready(terminal), sessionId: 'session-2' }]);
    expect(result.pending).toEqual([terminal]);
    expect(h.delegations).toEqual([delegated()]);
    expect(await h.runs()).toEqual([]);
  } finally { await h.close(); }
}, 5000);

test('cleanup leaves a terminal with a different remote core label alone', async () => {
  const h = await fixture();
  try {
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    await h.legacy();
    const state = JSON.parse(await readFile(join(h.f.root, 'core.json'), 'utf8'));
    const proxy = state.terminals.find((item: { address: string }) => item.address === 't2');
    proxy.state = 'finished'; proxy.exit_code = 0; proxy.reason = 'exited'; proxy.finished_ms = 1234;
    proxy.labels['spider.owner-core'] = 'another-core';
    await h.f.configure({ terminals: state.terminals });
    await h.create(null).reconcile([ready('box-1.invalid/t6')]);
    expect((await h.hc.get(h.f.address('t2'))).state).toBe('finished');
  } finally { await h.close(); }
}, 5000);


test('requires the resolved absolute hc binary', async () => {
  const h = await fixture();
  try {
    const registry = createTerminalRegistry(h.stateRoot);
    expect(() => createRoamPlacement({ hc: h.hc, app: null, registry, hcBinary: 'hc', stateRoot: h.stateRoot })).toThrow();
    expect(await h.f.calls()).toEqual([]);
  } finally { await h.close(); }
}, 5000);


test('uncertain legacy replies remain pending when the event stream is already open', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    const store = createPanePlacementStore(h.stateRoot);
    const attempt = { session: 'session-1', remote: 'box-1.invalid/t5', core: 'remote-core', proxy: null, closed: false, localOwners: [], failure: { attempts: 1, retryable: false } };
    await store.update(state => ({ ...state, attempts: [attempt] }));
    const before = (await store.read()).attempts;
    const p = createRoamPlacement({ hc: h.hc, app: null, registry: h.registry, hcBinary: h.f.hcBinary, stateRoot: h.stateRoot });
    const row = ready('box-1.invalid/t5');
    expect(await p.reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(await p.reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(h.delegations).toEqual([]);
    expect(await h.runs()).toEqual([]);
    expect((await store.read()).attempts).toEqual(before);
    expect(await inspectRoamPlacement(h.stateRoot)).toEqual([{ session: 'session-1', remote: 'box-1.invalid/t5', status: 'uncertain' }]);
    expect((await store.read()).slots).toEqual([{ session: 'session-1', ...slot }]);
  } finally { await h.close(); }
}, 5000);

test('a retryable legacy claim awaits service adoption instead of a legacy retry', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    const store = createPanePlacementStore(h.stateRoot);
    const attempt = { session: 'session-1', remote: 'box-1.invalid/t5', core: 'remote-core', proxy: null, closed: false, localOwners: [], failure: { attempts: 1, retryable: true } };
    await store.update(state => ({ ...state, attempts: [attempt] }));
    const before = (await store.read()).attempts;
    const p = createRoamPlacement({ hc: h.hc, app: null, registry: h.registry, hcBinary: h.f.hcBinary, stateRoot: h.stateRoot });
    const row = ready('box-1.invalid/t5');
    expect(await p.reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(await p.reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(h.delegations).toEqual([]);
    expect(await h.runs()).toEqual([]);
    expect((await store.read()).attempts).toEqual(before);
    expect(await inspectRoamPlacement(h.stateRoot)).toEqual([{ session: 'session-1', remote: 'box-1.invalid/t5', status: 'retryable' }]);
    expect((await store.read()).slots).toEqual([{ session: 'session-1', ...slot }]);
  } finally { await h.close(); }
}, 5000);

test('an exhausted legacy claim stays exhausted across placement instances', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    const store = createPanePlacementStore(h.stateRoot);
    const attempt = { session: 'session-1', remote: 'box-1.invalid/t5', core: 'remote-core', proxy: null, closed: false, localOwners: [], failure: { attempts: 2, retryable: true } };
    await store.update(state => ({ ...state, attempts: [attempt] }));
    const before = (await store.read()).attempts;
    const p = createRoamPlacement({ hc: h.hc, app: null, registry: h.registry, hcBinary: h.f.hcBinary, stateRoot: h.stateRoot });
    const row = ready('box-1.invalid/t5');
    expect(await p.reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(await p.reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(h.delegations).toEqual([]);
    expect(await h.runs()).toEqual([]);
    expect((await store.read()).attempts).toEqual(before);
    expect(await inspectRoamPlacement(h.stateRoot)).toEqual([{ session: 'session-1', remote: 'box-1.invalid/t5', status: 'exhausted' }]);
    expect((await store.read()).slots).toEqual([{ session: 'session-1', ...slot }]);
  } finally { await h.close(); }
}, 5000);

test('a lost legacy reply cannot become a safe spawn retry', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    const store = createPanePlacementStore(h.stateRoot);
    const attempt = { session: 'session-1', remote: 'box-1.invalid/t5', core: 'remote-core', proxy: null, closed: false, localOwners: [], failure: { attempts: 1, retryable: false } };
    await store.update(state => ({ ...state, attempts: [attempt] }));
    const before = (await store.read()).attempts;
    const p = createRoamPlacement({ hc: h.hc, app: null, registry: h.registry, hcBinary: h.f.hcBinary, stateRoot: h.stateRoot });
    const row = ready('box-1.invalid/t5');
    expect(await p.reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(await p.reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(h.delegations).toEqual([]);
    expect(await h.runs()).toEqual([]);
    expect((await store.read()).attempts).toEqual(before);
    expect(await inspectRoamPlacement(h.stateRoot)).toEqual([{ session: 'session-1', remote: 'box-1.invalid/t5', status: 'uncertain' }]);
    expect((await store.read()).slots).toEqual([{ session: 'session-1', ...slot }]);
  } finally { await h.close(); }
}, 5000);

test('an uncertain launch with no observable proxy remains pending without retrying', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    const store = createPanePlacementStore(h.stateRoot);
    const attempt = { session: 'session-1', remote: 'box-1.invalid/t5', core: 'remote-core', proxy: null, closed: false, localOwners: [], failure: { attempts: 1, retryable: false } };
    await store.update(state => ({ ...state, attempts: [attempt] }));
    const before = (await store.read()).attempts;
    const p = createRoamPlacement({ hc: h.hc, app: null, registry: h.registry, hcBinary: h.f.hcBinary, stateRoot: h.stateRoot });
    const row = ready('box-1.invalid/t5');
    expect(await p.reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(await p.reconcile([row])).toEqual({ pending: [row.terminal] });
    expect(h.delegations).toEqual([]);
    expect(await h.runs()).toEqual([]);
    expect((await store.read()).attempts).toEqual(before);
    expect(await inspectRoamPlacement(h.stateRoot)).toEqual([{ session: 'session-1', remote: 'box-1.invalid/t5', status: 'uncertain' }]);
    expect((await store.read()).slots).toEqual([{ session: 'session-1', ...slot }]);
  } finally { await h.close(); }
}, 5000);

test('refuses a nonprivate state directory before writing lock files', async () => {
  const h = await fixture();
  try {
    await chmod(h.stateRoot, 0o755);
    await expect(rememberRoamSlot(h.stateRoot, 'session-1', slot)).rejects.toMatchObject({ code: 'unsafe-state-path' });
    expect(await readdir(h.stateRoot)).not.toContain('locks');
  } finally { await h.close(); }
}, 5000);


test('refuses a nonprivate existing lock directory before writing into it', async () => {
  const h = await fixture();
  try {
    const locks = join(h.stateRoot, 'locks');
    await mkdir(locks, { mode: 0o700 }); await chmod(locks, 0o755);
    await expect(rememberRoamSlot(h.stateRoot, 'session-1', slot)).rejects.toMatchObject({ code: 'unsafe-state-path' });
    expect(await readdir(locks)).toEqual([]);
  } finally { await h.close(); }
}, 5000);


test('closing a moved proxy keeps its last slot for the next terminal', async () => {
  const h = await fixture();
  try {
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    await h.legacy();
    const layout = JSON.parse(await readFile(join(h.f.root, 'app.json'), 'utf8'));
    layout.spaces[0].tabs[0].terminals = layout.spaces[0].tabs[0].terminals.filter((row: { terminal: string }) => row.terminal !== 't2');
    layout.spaces.push({ id: 's2', tabs: [{ id: 'tb2', terminals: [{ terminal: 't2', pane: 'p2' }] }] });
    await h.hc.setLabels(h.f.address('t2'), { 'herdr.space': 's2', 'herdr.tab': 'tb2' });
    await writeFile(join(h.f.root, 'app.json'), JSON.stringify(layout));
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    layout.spaces[1].tabs[0].terminals = [];
    await h.hc.setLabels(h.f.address('t2'), { 'herdr.space': null, 'herdr.tab': null });
    await writeFile(join(h.f.root, 'app.json'), JSON.stringify(layout));
    await h.create().reconcile([ready('box-1.invalid/t6')]);
    expect(h.delegations).toEqual([delegated(), delegated('t5', 's2', 'tb2'), delegated('t6', 's2', 'tb2')]);
  } finally { await h.close(); }
}, 5000);


test('a newly observed local session terminal can update the remembered slot', async () => {
  const h = await fixture();
  try {
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    await h.legacy();
    const core = JSON.parse(await readFile(join(h.f.root, 'core.json'), 'utf8'));
    core.terminals = core.terminals.filter((item: { address: string }) => item.address !== 't2');
    core.terminals.push({ address: 't4', parent: null, pid: process.pid, labels: {}, state: 'live', status: null, exit_code: null, reason: null, signal: null, finished_ms: null });
    await h.f.configure({ terminals: core.terminals });
    const owner = { sessionId: 'session-1', generation: 'g2', terminal: { coreId: 'local-core', terminalId: 't4', address: 't4', socket: h.f.localSocket, sessionNamespace: h.f.namespace }, cwd: '/work', sessionFile: null, name: null } as Owner;
    await h.registry.record({ owner, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: h.f.root, extensionArguments: [] } });
    const layout = JSON.parse(await readFile(join(h.f.root, 'app.json'), 'utf8'));
    layout.spaces[0].tabs[0].terminals = layout.spaces[0].tabs[0].terminals.filter((row: { terminal: string }) => row.terminal !== 't2');
    layout.spaces.push({ id: 's3', tabs: [{ id: 'tb3', terminals: [{ terminal: 't4', pane: 'p4' }] }] });
    await writeFile(join(h.f.root, 'app.json'), JSON.stringify(layout));
    await h.create().reconcile([ready('box-1.invalid/t6')]);
    expect(h.delegations).toEqual([delegated(), delegated('t6', 's3', 'tb3')]);
  } finally { await h.close(); }
}, 5000);


test('changing a routing alias does not reopen the same core terminal', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    await h.create(null).reconcile([ready('box-1.invalid/t5')]);
    await h.create(null).reconcile([ready('alias.invalid/t5')]);
    expect(h.delegations).toEqual([delegated(), delegated()]);
  } finally { await h.close(); }
}, 5000);


test('a restarted remote core can reuse a terminal ID', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    await h.create(null).reconcile([ready('box-1.invalid/t5')]);
    await h.create(null).reconcile([{ ...ready('box-1.invalid/t5'), core: 'new-remote-core' }]);
    expect(h.delegations).toEqual([delegated(), delegated('t5', 's1', 'tb1', 'new-remote-core')]);
  } finally { await h.close(); }
}, 5000);


test('a returning app observes an existing legacy proxy without relaunch', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    await writeFile(join(h.f.root, 'scenario.json'), JSON.stringify({ appSteps: [{ argvPrefix: ['ls'], reply: { error: 'closed' } }] }));
    expect(await h.create().reconcile([ready('box-1.invalid/t5')])).toEqual({ pending: [] });
    expect(h.delegations).toEqual([delegated()]);
    await writeFile(join(h.f.root, 'scenario.json'), '{}');
    await h.legacy();
    expect(await h.app.ownerPlacement(h.f.address('t2'))).toMatchObject(slot);
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    expect(h.delegations).toEqual([delegated(), delegated()]);
  } finally { await h.close(); }
}, 5000);


test('refuses symlinked state without changing the target', async () => {
  const h = await fixture();
  try {
    const target = join(h.f.root, 'outside.json');
    await writeFile(target, 'untouched', { mode: 0o600 });
    await symlink(target, join(h.stateRoot, 'roam-placement.json'));
    await expect(rememberRoamSlot(h.stateRoot, 'session-1', slot)).rejects.toMatchObject({ code: 'unsafe-state-path' });
    expect(await readFile(target, 'utf8')).toBe('untouched');
  } finally { await h.close(); }
}, 5000);

test('roaming compatibility writes preserve generic placement state and revisions', async () => {
  const h = await fixture();
  try {
    const store = createPanePlacementStore(h.stateRoot);
    const choice = { session: 'session-1' as Owner['sessionId'], space: slot.space, tab: slot.tab, revision: 1 };
    await store.update(state => ({ ...state, choices: [choice] }));
    const before = await store.read();
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    const after = await store.read();
    expect(after.choices).toEqual([choice]);
    expect(after.slots).toEqual([{ session: 'session-1', ...slot }]);
    expect(after.version).toBe(2); expect(after.revision).toBeGreaterThan(before.revision);
  } finally { await h.close(); }
});

test('compatibility reconciliation preserves a slot saved concurrently by the pane service', async () => {
  const h = await fixture();
  try {
    const store = createPanePlacementStore(h.stateRoot), original = h.app.ownerPlacement;
    h.app.ownerPlacement = async terminal => { await store.update(state => ({ ...state, slots: [...state.slots.filter(s => s.session !== 'session-other'), { session: 'session-other', ...slot }] })); return original(terminal); };
    await h.create().reconcile([]);
    expect((await store.read()).slots).toContainEqual({ session: 'session-other', ...slot });
  } finally { await h.close(); }
});
