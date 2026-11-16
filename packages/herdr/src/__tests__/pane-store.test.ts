// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createPanePlacementStore, readPaneBinding, writePaneBinding } from '../panes/store.js';
import { parsePaneTarget } from '../panes/codec.js';
import type { PanePresentation } from '../panes/types.js';
import type { SessionId, SpaceId, TabId } from '../contracts.js';
import * as registry from '../sessions/registry.js';
import { invokeCli, createHcClient } from '../client/hc.js';
vi.mock('../client/hc.js', () => ({ invokeCli: vi.fn(() => { throw new Error('Unexpected hc effect'); }), createHcClient: vi.fn(() => { throw new Error('Unexpected hc client'); }) }));
beforeEach(() => { vi.mocked(invokeCli).mockClear(); vi.mocked(createHcClient).mockClear(); });
vi.mock('../sessions/registry.js', async importOriginal => {
  const actual = await importOriginal<typeof registry>();
  return { ...actual, writePrivateJson: vi.fn(actual.writePrivateJson) };
});
const roots: string[] = [];
afterEach(async () => { vi.mocked(registry.writePrivateJson).mockRestore(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const base = resolve('.spider/scratch/pane-store-tests'); await mkdir(base, { recursive: true });
  const globalRoot = await mkdtemp(join(base, 'state-')); roots.push(globalRoot);
  const root = join(globalRoot, 'roam', 'placement'); await mkdir(root, { recursive: true, mode: 0o700 });
  const file = join(root, 'roam-placement.json'); const binding = (id: string) => join(globalRoot, 'herdr', 'panes', 'bindings', `${id}.json`);
  const before = { version: 1, slots: [{ session: 'session-1', space: 'space-1', tab: 'tab-1' }], attempts: [{ session: 'session-1', remote: 'box-1.invalid/t7', core: 'core-remote', proxy: 't8', closed: true, localOwners: ['owner-key-1'] }] };
  const write = async (value: unknown) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return { root, panesRoot: join(globalRoot, 'herdr', 'panes'), globalRoot, file, binding, before, write, store: createPanePlacementStore(root) };
}
function presentation(revision = 1): PanePresentation {
  return { id: 'pane-1', revision, mode: 'proxy', role: 'agent', target: parsePaneTarget({ coreId: 'core-remote', terminalId: 't7', address: 'core-remote/t7', createdMs: 17, identityLabels: { 'spider.session': 'session-1' }, alias: 'box-1.invalid', machineId: null, kind: 'session', sessionId: 'session-1', generation: 'gen-1', homeEpoch: 2, runId: null, consoleId: null, name: 'Example', cwd: '/home/example/work' }), proxy: null, slot: { space: 'space-1' as SpaceId, tab: 'tab-1' as TabId, pane: null }, visibility: 'parked', launch: 'uncertain', closeOperationId: null, conversion: null };
}
test('v1 closed claim migrates to parked without relaunch', async () => {
  const h = await fixture(); await h.write(h.before);
  const after = await h.store.read();
  expect(after.version).toBe(2);
  expect(after.presentations.find(p => p.id === 't8')?.visibility).toBe('parked');
  expect(after.presentations[0].target).toMatchObject({ address: 'core-remote/t7', generation: null });
  expect(after.presentations[0].slot).toMatchObject({ space: 'space-1', tab: 'tab-1', pane: null });
  expect(after.slots).toEqual(h.before.slots); expect(after.attempts).toEqual(h.before.attempts);
  expect(vi.mocked(invokeCli).mock.calls).toEqual([]);
  expect(vi.mocked(createHcClient).mock.calls).toEqual([]);
  const migratedBytes = await readFile(h.file); const backup = await readFile(join(h.root, 'roam-placement.v1.json'));
  expect(JSON.parse(backup.toString())).toEqual(h.before);
  expect(await h.store.read()).toEqual(after);
  expect(await readFile(h.file)).toEqual(migratedBytes);
  expect((await stat(h.file)).mode & 0o777).toBe(0o600);
  expect((await stat(join(h.root, 'roam-placement.v1.json'))).mode & 0o777).toBe(0o600);
  expect((await stat(join(h.globalRoot, 'herdr', 'panes', 'bindings'))).mode & 0o777).toBe(0o700);
});
test('legacy proxy id reuse retains each distinct claim without guessing ownership', async () => {
  const h = await fixture(); const before = { ...h.before, attempts: [...h.before.attempts, { ...h.before.attempts[0], session: 'session-2', remote: 'box-2.invalid/t9', core: 'core-other', closed: false }] };
  await h.write(before); const after = await h.store.read();
  expect(after.attempts).toEqual(before.attempts);
  expect(after.presentations).toHaveLength(2);
  expect(new Set(after.presentations.map(p => p.id)).size).toBe(2);
  expect(after.presentations.map(p => p.target.generation)).toEqual([null, null]);
});
test('uncertain v1 claim remains uncertain', async () => {
  const h = await fixture(); const attempt = { ...h.before.attempts[0], proxy: null, closed: false, failure: { attempts: 2, retryable: false } };
  await h.write({ ...h.before, attempts: [attempt] });
  const after = await h.store.read(); expect(after.attempts).toEqual([attempt]); expect(after.presentations).toEqual([]); expect(after.launches).toEqual([]);
});
test('v1 failures local owners and absent slots are retained exactly', async () => {
  const h = await fixture(); const before = { version: 1, slots: [], attempts: [{ ...h.before.attempts[0], closed: false }, { session: 'session-2', remote: 'box-2.invalid/t9', core: 'core-other', proxy: null, closed: false, localOwners: ['owner-2'], failure: { attempts: 1, retryable: true } }] };
  await h.write(before); const after = await h.store.read(); expect(after.slots).toEqual([]); expect(after.attempts).toEqual(before.attempts); expect(after.presentations[0].slot).toBeNull();
});
test('interrupted binding publication repairs from authority', async () => {
  const h = await fixture(); const authority = presentation(7);
  const original = registry.writePrivateJson;
  const actual = await vi.importActual<typeof registry>('../sessions/registry.js');
  let interrupted = false;
  vi.mocked(original).mockImplementation(async (path, value) => {
    if (path === h.binding(authority.id) && !interrupted) { interrupted = true; return actual.writePrivateJson(path, value, async () => { throw new Error('interrupted rename'); }); }
    return actual.writePrivateJson(path, value);
  });
  await expect(h.store.update(state => ({ ...state, presentations: [authority] }))).rejects.toThrow('interrupted rename');
  expect(JSON.parse(await readFile(h.file, 'utf8')).presentations).toEqual([authority]);
  await h.store.read();
  const recovered = await readPaneBinding(h.panesRoot, authority.id);
  expect(recovered?.revision).toBe(authority.revision); expect(recovered?.visibility).toBe('parked');
  expect(JSON.parse(await readFile(h.binding(authority.id), 'utf8'))).toEqual(authority);
});
test('corrupt binding repairs from authority and v1 backup stays unchanged', async () => {
  const h = await fixture(); await h.write(h.before); const authority = await h.store.read();
  const backup = await readFile(join(h.root, 'roam-placement.v1.json'));
  await writeFile(h.binding('t8'), '{broken', { mode: 0o600 });
  expect(await h.store.read()).toEqual(authority);
  expect(await readPaneBinding(h.panesRoot, 't8')).toEqual(authority.presentations[0]);
  await h.store.update(state => ({ ...state, choices: [{ session: 'session-1' as SessionId, space: 'space-1' as SpaceId, tab: 'tab-1' as TabId, revision: 1 }] }));
  expect(await readFile(join(h.root, 'roam-placement.v1.json'))).toEqual(backup);
});
test('two writers retain acknowledged manual slots', async () => {
  const h = await fixture(); const other = createPanePlacementStore(h.root);
  const choice = (session: string, tab: string) => ({ session: session as SessionId, space: 'space-1' as SpaceId, tab: tab as TabId, revision: 1 });
  const afters = await Promise.all([h.store.update(state => ({ ...state, choices: [...state.choices, choice('session-1', 'tab-1')] })), other.update(state => ({ ...state, choices: [...state.choices, choice('session-2', 'tab-2')] }))]);
  expect(afters.map(s => s.revision).sort()).toEqual([1, 2]);
  expect((await h.store.read()).choices.sort((a, b) => a.session.localeCompare(b.session))).toEqual([choice('session-1', 'tab-1'), choice('session-2', 'tab-2')]);
});
test('unsafe or future state refuses before write', async () => {
  const h = await fixture(); const future = { version: 99, revision: 17, private: 'retain' }; await h.write(future);
  const bytes = await readFile(h.file); let changes = 0;
  await expect(h.store.update(state => { changes++; return state; })).rejects.toThrow();
  expect(changes).toBe(0); expect(await readFile(h.file)).toEqual(bytes);
  await h.write(h.before); await chmod(h.file, 0o644);
  await expect(h.store.read()).rejects.toThrow(); expect(await readFile(h.file, 'utf8')).toBe(JSON.stringify(h.before));
});
test('symlinked state backup bindings and locks refuse without changing targets', async () => {
  for (const kind of ['state', 'backup', 'bindings', 'lock']) {
    const h = await fixture(); await h.write(h.before);
    const outside = join(h.globalRoot, 'outside'); await mkdir(outside, { mode: 0o700 });
    const target = join(outside, 'target.json'); await writeFile(target, 'retained', { mode: 0o600 });
    if (kind === 'state') { await rm(h.file); await symlink(target, h.file); }
    if (kind === 'backup') await symlink(target, join(h.root, 'roam-placement.v1.json'));
    if (kind === 'bindings') { const dir = join(h.globalRoot, 'herdr', 'panes'); await mkdir(dir, { recursive: true, mode: 0o700 }); await symlink(outside, join(dir, 'bindings')); }
    if (kind === 'lock') { await mkdir(join(h.root, 'locks'), { mode: 0o700 }); await symlink(outside, join(h.root, 'locks', registry.hash('roam-placement'))); }
    await expect(h.store.read()).rejects.toThrow(); expect(await readFile(target, 'utf8')).toBe('retained');
  }
});
test('a corrupt file is not an empty store', async () => {
  const h = await fixture(); await writeFile(h.file, '{broken', { mode: 0o600 });
  await expect(h.store.read()).rejects.toThrow(); expect(await readFile(h.file, 'utf8')).toBe('{broken');
  await h.write({ ...h.before, attempts: [{ ...h.before.attempts[0], failure: { attempts: 3, retryable: true } }] });
  await expect(h.store.read()).rejects.toThrow();
});
test('serialized null is corrupt state and cannot erase claims', async () => {
  const h = await fixture(); await writeFile(h.file, 'null', { mode: 0o600 });
  await expect(h.store.read()).rejects.toThrow();
  expect(await readFile(h.file, 'utf8')).toBe('null');
});
test('an unsafe binding file refuses before authoritative update', async () => {
  const h = await fixture(); const p = presentation();
  await h.store.update(state => ({ ...state, presentations: [p] })); const bytes = await readFile(h.file);
  await chmod(h.binding(p.id), 0o644);
  await expect(h.store.update(state => ({ ...state, presentations: [{ ...p, revision: 2 }] }))).rejects.toThrow();
  expect(await readFile(h.file)).toEqual(bytes);
});
test('the store owns revision increments even for an in-place callback', async () => {
  const h = await fixture(); const first = await h.store.update(state => state);
  const second = await h.store.update(state => { state.revision = 99; return state; });
  expect(second.revision).toBe(first.revision + 1);
});
test('an invalid v1 update does not migrate or replace authority', async () => {
  const h = await fixture(); await h.write(h.before); const bytes = await readFile(h.file);
  await expect(h.store.update(state => ({ ...state, presentations: [presentation(), presentation()] }))).rejects.toThrow();
  expect(await readFile(h.file)).toEqual(bytes);
  await expect(stat(join(h.root, 'roam-placement.v1.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
test('target launch claim survives without inventing a terminal', async () => {
  const h = await fixture(); const observed = presentation();
  observed.target.identityLabels = { ...observed.target.identityLabels, 'spider.pane-operation': 'operation-1' };
  const intent = { operationId: 'operation-1', space: 'space-1' as SpaceId, place: 'tab' as const, anchor: null, program: { kind: 'shell' as const } };
  const claim = { operationId: 'operation-1', coreId: 'core-remote' as typeof observed.target.coreId, machineKey: 'box-1.invalid', intent, folder: { cwd: null, reason: 'home' as const }, state: 'uncertain' as const, target: null, failure: null };
  await h.store.update(state => ({ ...state, launches: [claim] }));
  const restarted = createPanePlacementStore(h.root); const uncertain = await restarted.read();
  expect(uncertain.launches).toEqual([claim]); expect(uncertain.presentations).toEqual([]);
  const promote = () => restarted.update(state => state.launches[0].state === 'observed' ? state : ({ ...state, launches: [{ ...claim, state: 'observed', target: observed.target }], presentations: [observed] }));
  await promote(); await promote(); const after = await restarted.read();
  expect(after.presentations).toHaveLength(1); expect(after.launches[0]).toMatchObject({ state: 'observed', target: observed.target });
});
test('invalid updates and stale bindings cannot overwrite authoritative state', async () => {
  const h = await fixture(); const p = presentation(2);
  await h.store.update(state => ({ ...state, presentations: [p] })); const bytes = await readFile(h.file);
  await expect(h.store.update(state => ({ ...state, presentations: [p, p] }))).rejects.toThrow(); expect(await readFile(h.file)).toEqual(bytes);
  await expect(writePaneBinding(h.panesRoot, { ...p, revision: 1 })).rejects.toThrow();
  await writePaneBinding(h.panesRoot, p); expect(await readPaneBinding(h.panesRoot, p.id)).toEqual(p);
  expect(await readPaneBinding(h.panesRoot, 'unknown')).toBeNull(); await expect(readPaneBinding(h.panesRoot, '../escape')).rejects.toThrow();
});
test('binding and placement roots never write each other\'s authority files', async () => {
  const h = await fixture(); await h.store.update(state => state);
  const bytes = await readFile(h.file);
  await writePaneBinding(h.panesRoot, presentation());
  expect(await readFile(h.file)).toEqual(bytes);
  await expect(stat(join(h.root, 'bindings'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(h.panesRoot, 'roam-placement.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const bindingBytes = await readFile(h.binding('pane-1'));
  await h.store.update(state => ({ ...state, choices: [{ session: 'session-1' as SessionId, space: 'space-1' as SpaceId, tab: 'tab-1' as TabId, revision: 1 }] }));
  expect(await readFile(h.binding('pane-1'))).toEqual(bindingBytes);
});
test('removing a presentation also removes its binding projection', async () => {
  const h = await fixture(); const p = presentation();
  await h.store.update(state => ({ ...state, presentations: [p] }));
  expect(await readPaneBinding(h.panesRoot, p.id)).toEqual(p);
  await h.store.update(state => ({ ...state, presentations: [] }));
  expect(await readPaneBinding(h.panesRoot, p.id)).toBeNull();
  expect((await createPanePlacementStore(h.root).read()).presentations).toEqual([]);
});
test('pending conversion survives restart without changing parked intent', async () => {
  const h = await fixture(); const p = presentation();
  const pending: PanePresentation = { ...p, conversion: { state: 'waiting-focus', destination: p.target, source: { ...p.slot!, pane: 'pane-source' as import('../contracts.js').PaneId }, sourceFocused: false } };
  await h.store.update(state => ({ ...state, presentations: [pending] }));
  expect((await createPanePlacementStore(h.root).read()).presentations).toEqual([pending]);
});
