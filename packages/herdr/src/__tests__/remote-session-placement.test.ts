// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { HerdrConfig, OwnerPlacement, SessionId, SpaceId, TabId } from '../contracts.js';
import type { AppPaneCapabilities, PaneAgentRow, PanePresentation, PlacementState } from '../panes/types.js';
import type { LayoutSnapshot } from '../spaces/setup.js';
import { createPanePlacementStore } from '../panes/store.js';
import { readAppPaneCapabilities } from '../panes/capabilities.js';
import { placeRemoteSessionWithoutFocus, rememberRemoteSessionPlacement, selectRemoteSessionSlot } from '../spaces/remote-placement.js';

function row(sessionId = 'session-1', name = 'Builder', machineKey = 'box-1.invalid'): PaneAgentRow {
  const terminal = { coreId: `core-${machineKey}`, terminalId: 't1', address: `core-${machineKey}/t1`, socket: '/home/example/core.sock', sessionNamespace: 'fixture' };
  return { sessionId, generation: 'gen-1', name, owner: { sessionId, generation: 'gen-1', terminal, cwd: '/home/example/work', sessionFile: null, name }, target: { coreId: terminal.coreId, terminalId: 't1', address: terminal.address, createdMs: 42, identityLabels: {}, alias: machineKey, machineId: null, kind: 'session', sessionId, generation: 'gen-1', homeEpoch: null, runId: null, consoleId: null, name, cwd: '/home/example/work' }, status: 'working', updatedAt: 1, machineKey, unavailableReason: null, children: [], consoles: [] } as unknown as PaneAgentRow;
}
const state = (): PlacementState => ({ version: 2, revision: 0, slots: [], attempts: [], presentations: [], choices: [], launches: [] });
const config = (layout: 'panes' | 'tabs' = 'panes'): HerdrConfig => ({ layout, spaces: [{ name: 'Work', sessions: [{ name: 'Builder' }] }] } as HerdrConfig);
const tab = (id: string) => ({ id: id as TabId, name: id, ownerSessionId: null, terminal: null });
const layout = (): LayoutSnapshot => ({ spaces: [{ id: 'space-work' as SpaceId, name: 'Work', tabs: [tab('tab-first'), tab('tab-work')] }, { id: 'space-personal' as SpaceId, name: 'Personal', tabs: [tab('tab-chosen')] }] });
const caps = (backgroundTabCreation = false): AppPaneCapabilities => ({ backgroundTabCreation, explicitTargetSwap: false, noFocusConversion: false, commandDigest: 'a'.repeat(64) });
function input(overrides: Partial<Parameters<typeof selectRemoteSessionSlot>[0]> = {}) {
  const r = row();
  return { row: r, rows: [r], inventoryComplete: true, inventoryStale: false, config: config(), state: state(), layout: layout(), capabilities: caps(), ...overrides };
}

test('unique configured name uses its Mac space and managed tab', () => {
  const saved = state(); saved.slots.push({ session: 'other', space: 'space-work', tab: 'tab-work' });
  expect(selectRemoteSessionSlot(input({ state: saved }))).toEqual({ kind: 'slot', space: 'space-work', tab: 'tab-work' });
});
test('unmatched box agent remains unplaced', () => {
  const r = row('session-1', 'Unmatched');
  expect(selectRemoteSessionSlot(input({ row: r, rows: [r] }))).toEqual({ kind: 'unplaced', reason: 'no-placement-choice', space: null });
});
test('duplicate name requires session id', () => {
  const one = row(), two = row('session-2', 'Builder', 'box-2.invalid');
  expect(selectRemoteSessionSlot(input({ row: one, rows: [one, two] }))).toMatchObject({ kind: 'unplaced', reason: 'name-ambiguous' });
  const exact = config(); exact.spaces[0].sessions = [{ name: 'Builder', sessionId: 'session-1' }];
  expect(selectRemoteSessionSlot(input({ row: one, rows: [one, two], config: exact }))).toEqual({ kind: 'slot', space: 'space-work', tab: 'tab-first' });
  expect(selectRemoteSessionSlot(input({ row: two, rows: [one, two], config: exact }))).toEqual({ kind: 'unplaced', reason: 'no-placement-choice', space: null });
});
test('stale or incomplete inventories never silently choose by name', () => {
  expect(selectRemoteSessionSlot(input({ inventoryComplete: false }))).toMatchObject({ kind: 'unplaced' });
  expect(selectRemoteSessionSlot(input({ inventoryStale: true }))).toMatchObject({ kind: 'unplaced' });
  const exact = config(); exact.spaces[0].sessions = [{ name: 'Builder', sessionId: 'session-1' }];
  expect(selectRemoteSessionSlot(input({ config: exact, inventoryStale: true }))).toMatchObject({ kind: 'unplaced' });
});
test('session id conflicts cannot use even a saved choice', () => {
  const one = row(), two = row('session-1', 'Other', 'box-2.invalid');
  const saved = state(); saved.choices.push({ session: one.sessionId, space: 'space-personal' as SpaceId, tab: 'tab-chosen' as TabId, revision: 1 });
  expect(selectRemoteSessionSlot(input({ row: one, rows: [one, two], state: saved }))).toMatchObject({ kind: 'unplaced', reason: 'session-id-conflict' });
});
test('a row absent from the current inventory grants no placement', () => {
  expect(selectRemoteSessionSlot(input({ rows: [] }))).toMatchObject({ kind: 'unplaced', reason: 'inventory-unavailable' });
});
test('manual tab choice survives moves reload and rename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-placement-'));
  try {
    const path = join(root, 'roam', 'placement'), first = createPanePlacementStore(path);
    const placement = { space: 'space-personal', tab: 'tab-chosen', pane: 'pane-1' } as OwnerPlacement;
    await rememberRemoteSessionPlacement('session-1' as SessionId, placement, first);
    const restarted = createPanePlacementStore(path), saved = await restarted.read(), moved = row('session-1', 'Renamed', 'box-2.invalid');
    const selected = selectRemoteSessionSlot(input({ row: moved, rows: [moved], state: saved }));
    expect(selected).toEqual({ kind: 'slot', space: 'space-personal', tab: 'tab-chosen' });
    expect(saved.choices).toHaveLength(1);
    expect(saved.choices[0]).toMatchObject({ session: 'session-1', space: 'space-personal', tab: 'tab-chosen' });
    await rememberRemoteSessionPlacement('session-1' as SessionId, { ...placement, space: 'space-work' as SpaceId, tab: 'tab-work' as TabId }, restarted);
    const movedAgain = await first.read();
    expect(movedAgain.choices).toHaveLength(1);
    expect(selectRemoteSessionSlot(input({ row: moved, rows: [moved], state: movedAgain }))).toEqual({ kind: 'slot', space: 'space-work', tab: 'tab-work' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('deleted chosen tab stays unplaced until a fresh choice', () => {
  const r = row(), saved = state(); saved.choices.push({ session: r.sessionId, space: 'space-personal' as SpaceId, tab: 'deleted-tab' as TabId, revision: 1 });
  expect(selectRemoteSessionSlot(input({ state: saved }))).toMatchObject({ kind: 'unplaced', reason: 'choice-unavailable' });
  expect(saved.choices[0].tab).toBe('deleted-tab');
});
test('an acknowledged manual choice remains stable while another source is stale', () => {
  const saved = state(); saved.choices.push({ session: 'session-1' as SessionId, space: 'space-personal' as SpaceId, tab: 'tab-chosen' as TabId, revision: 1 });
  expect(selectRemoteSessionSlot(input({ state: saved, inventoryStale: true }))).toEqual({ kind: 'slot', space: 'space-personal', tab: 'tab-chosen' });
});
test('a remembered presentation uses its slot without guessing after deletion', () => {
  const r = row(), saved = state();
  saved.presentations.push({ role: 'agent', target: r.target, visibility: 'visible', slot: { space: 'space-personal', tab: 'tab-chosen', pane: null } } as PanePresentation);
  expect(selectRemoteSessionSlot(input({ state: saved }))).toEqual({ kind: 'slot', space: 'space-personal', tab: 'tab-chosen' });
  saved.presentations[0].slot!.tab = 'deleted-tab' as TabId;
  expect(selectRemoteSessionSlot(input({ state: saved }))).toMatchObject({ kind: 'unplaced', reason: 'slot-unavailable' });
});
test('remembered roaming slot beats configured name', () => {
  const saved = state(); saved.slots.push({ session: 'session-1', space: 'space-personal', tab: 'tab-chosen' });
  expect(selectRemoteSessionSlot(input({ state: saved }))).toEqual({ kind: 'slot', space: 'space-personal', tab: 'tab-chosen' });
});
test('parked intent stays unplaced after a terminal changes', () => {
  const r = row(), saved = state();
  saved.presentations.push({ role: 'agent', target: { ...r.target!, terminalId: 'old-terminal' }, visibility: 'parked', slot: { space: 'space-personal', tab: 'tab-chosen', pane: null } } as unknown as PanePresentation);
  saved.choices.push({ session: r.sessionId, space: 'space-personal' as SpaceId, tab: 'tab-chosen' as TabId, revision: 1 });
  expect(selectRemoteSessionSlot(input({ state: saved }))).toMatchObject({ kind: 'unplaced', reason: 'parked' });
});
test('display-only rows never obtain a placement even with remembered choices', () => {
  const r = { ...row(), generation: null, owner: null, target: null, unavailableReason: 'not-in-hc', children: [], consoles: [] } as PaneAgentRow;
  const saved = state(); saved.choices.push({ session: r.sessionId, space: 'space-personal' as SpaceId, tab: 'tab-chosen' as TabId, revision: 1 });
  expect(selectRemoteSessionSlot(input({ row: r, rows: [r], state: saved }))).toEqual({ kind: 'unplaced', reason: 'not-in-hc', space: null });
});
test('display-only rows cannot trigger passive creation or placement', async () => {
  const r = { ...row(), generation: null, owner: null, target: null, unavailableReason: 'not-in-hc', children: [], consoles: [] } as PaneAgentRow;
  const selected = selectRemoteSessionSlot(input({ row: r, rows: [r] }));
  const createTabWithoutFocus = vi.fn(), placePaneWithoutFocus = vi.fn();
  expect(await placeRemoteSessionWithoutFocus(selected, caps(true), { createTabWithoutFocus, placePaneWithoutFocus })).toEqual({ status: 'deferred', reason: 'not-in-hc', space: null });
  expect(createTabWithoutFocus).not.toHaveBeenCalled(); expect(placePaneWithoutFocus).not.toHaveBeenCalled();
});
test('tabs layout uses a passive new tab only with the capability', () => {
  expect(selectRemoteSessionSlot(input({ config: config('tabs'), capabilities: caps(true) }))).toEqual({ kind: 'slot', space: 'space-work', tab: null });
  expect(selectRemoteSessionSlot(input({ config: config('tabs'), capabilities: caps(false) }))).toEqual({ kind: 'slot', space: 'space-work', tab: 'tab-first' });
});
test('fallback prefers a managed tab over the first tab', () => {
  const saved = state(); saved.slots.push({ session: 'other', space: 'space-work', tab: 'tab-work' });
  expect(selectRemoteSessionSlot(input({ state: saved, config: config('tabs'), capabilities: caps(false) }))).toEqual({ kind: 'slot', space: 'space-work', tab: 'tab-work' });
});
test('later app command metadata takes the same capability path', () => {
  const later = readAppPaneCapabilities({ version: '9.0.0', commands: [{ name: 'tab.new', args: [{ name: 'focus', required: false }] }] });
  expect(selectRemoteSessionSlot(input({ config: config('tabs'), capabilities: later }))).toEqual({ kind: 'slot', space: 'space-work', tab: null });
});
test('space without a tab keeps configured assignment pending', () => {
  const snapshot = layout(); snapshot.spaces[0].tabs = [];
  expect(selectRemoteSessionSlot(input({ layout: snapshot, config: config('tabs'), capabilities: caps(false) }))).toEqual({ kind: 'unplaced', reason: 'configured-space-pending', space: 'space-work' });
});
test('capable passive tab creation keeps shown space and focus', async () => {
  const selected = selectRemoteSessionSlot(input({ config: config('tabs'), capabilities: caps(true) }));
  const view = { shownSpace: 'space-personal', selectedTab: 'tab-chosen', focusedPane: 'pane-1' };
  const before = { ...view };
  const placement = { space: 'space-work', tab: 'tab-new', pane: 'pane-new' } as OwnerPlacement;
  const createTabWithoutFocus = vi.fn(async (request: { space: SpaceId; focus: false }) => { if (request.focus !== false) view.shownSpace = 'space-work'; return placement; });
  const placePaneWithoutFocus = vi.fn();
  expect(await placeRemoteSessionWithoutFocus(selected, caps(true), { createTabWithoutFocus, placePaneWithoutFocus })).toEqual({ status: 'placed', placement });
  expect(createTabWithoutFocus).toHaveBeenCalledWith({ space: 'space-work', focus: false });
  expect(placePaneWithoutFocus).not.toHaveBeenCalled(); expect(view).toEqual(before);
});
test('fallback reuses an existing configured space tab without focus', async () => {
  const selected = selectRemoteSessionSlot(input({ config: config('tabs'), capabilities: caps(false) }));
  const placement = { space: 'space-work', tab: 'tab-first', pane: 'pane-new' } as OwnerPlacement;
  const createTabWithoutFocus = vi.fn(), placePaneWithoutFocus = vi.fn(async () => placement);
  expect(await placeRemoteSessionWithoutFocus(selected, caps(false), { createTabWithoutFocus, placePaneWithoutFocus })).toEqual({ status: 'placed', placement });
  expect(createTabWithoutFocus).not.toHaveBeenCalled();
  expect(placePaneWithoutFocus).toHaveBeenCalledWith({ space: 'space-work', tab: 'tab-first' });
});
test('unsupported no-focus placement defers without stealing focus', async () => {
  const selected = selectRemoteSessionSlot(input({ config: config('tabs'), capabilities: caps(false) }));
  const createTabWithoutFocus = vi.fn(), placePaneWithoutFocus = vi.fn(async () => null);
  expect(await placeRemoteSessionWithoutFocus(selected, caps(false), { createTabWithoutFocus, placePaneWithoutFocus })).toMatchObject({ status: 'deferred' });
  expect(createTabWithoutFocus).not.toHaveBeenCalled(); expect(placePaneWithoutFocus).toHaveBeenCalledTimes(1);
});
test('pending assignment and unavailable background creation do not call the app', async () => {
  const createTabWithoutFocus = vi.fn(), placePaneWithoutFocus = vi.fn();
  expect(await placeRemoteSessionWithoutFocus({ kind: 'unplaced', reason: 'configured-space-pending', space: 'space-work' as SpaceId }, caps(false), { createTabWithoutFocus, placePaneWithoutFocus })).toEqual({ status: 'deferred', reason: 'configured-space-pending', space: 'space-work' });
  expect(await placeRemoteSessionWithoutFocus({ kind: 'slot', space: 'space-work' as SpaceId, tab: null }, caps(false), { createTabWithoutFocus, placePaneWithoutFocus })).toMatchObject({ status: 'deferred' });
  expect(createTabWithoutFocus).not.toHaveBeenCalled(); expect(placePaneWithoutFocus).not.toHaveBeenCalled();
});
test('invalid layout identifiers never reach a placement port', async () => {
  const snapshot = layout(); snapshot.spaces[0].id = '../bad' as SpaceId;
  expect(selectRemoteSessionSlot(input({ layout: snapshot }))).toMatchObject({ kind: 'unplaced' });
  const createTabWithoutFocus = vi.fn(), placePaneWithoutFocus = vi.fn();
  await expect(placeRemoteSessionWithoutFocus({ kind: 'slot', space: '../bad' as SpaceId, tab: 'tab-work' as TabId }, caps(false), { createTabWithoutFocus, placePaneWithoutFocus })).rejects.toThrow();
  expect(placePaneWithoutFocus).not.toHaveBeenCalled(); expect(createTabWithoutFocus).not.toHaveBeenCalled();
});
test('a mismatched app acknowledgement is never accepted', async () => {
  const selected = { kind: 'slot', space: 'space-work' as SpaceId, tab: 'tab-work' as TabId } as const;
  await expect(placeRemoteSessionWithoutFocus(selected, caps(false), { createTabWithoutFocus: vi.fn(), placePaneWithoutFocus: vi.fn(async () => ({ space: 'space-work', tab: 'other', pane: 'pane-1' } as OwnerPlacement)) })).rejects.toThrow();
});
test('manual selection is remembered only after placement acknowledgement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-placement-'));
  try {
    const store = createPanePlacementStore(join(root, 'roam', 'placement'));
    const selected = { kind: 'slot', space: 'space-work' as SpaceId, tab: 'tab-work' as TabId } as const;
    let acknowledge!: (value: OwnerPlacement) => void;
    const placed = new Promise<OwnerPlacement>(resolve => { acknowledge = resolve; });
    const pending = placeRemoteSessionWithoutFocus(selected, caps(false), { createTabWithoutFocus: vi.fn(), placePaneWithoutFocus: () => placed }).then(async result => {
      if (result.status === 'placed') await rememberRemoteSessionPlacement('session-1' as SessionId, result.placement, store);
    });
    expect((await store.read()).choices).toEqual([]);
    acknowledge({ space: 'space-work', tab: 'tab-work', pane: 'pane-1' } as OwnerPlacement); await pending;
    expect((await store.read()).choices).toMatchObject([{ session: 'session-1', space: 'space-work', tab: 'tab-work' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('conflicting configured selectors do not guess a destination', () => {
  const duplicate = config(); duplicate.spaces.push({ name: 'Personal', sessions: [{ name: 'Builder' }] });
  expect(selectRemoteSessionSlot(input({ config: duplicate }))).toMatchObject({ kind: 'unplaced', reason: 'configuration-ambiguous' });
});
test('a duplicated tab identifier cannot authorize a remembered choice', () => {
  const saved = state(); saved.choices.push({ session: 'session-1' as SessionId, space: 'space-personal' as SpaceId, tab: 'tab-chosen' as TabId, revision: 1 });
  const snapshot = layout(); snapshot.spaces[0].tabs.push(tab('tab-chosen'));
  expect(selectRemoteSessionSlot(input({ state: saved, layout: snapshot }))).toMatchObject({ kind: 'unplaced' });
});
test('a duplicated space identifier cannot authorize configured placement', () => {
  const snapshot = layout(); snapshot.spaces[1].id = snapshot.spaces[0].id;
  expect(selectRemoteSessionSlot(input({ layout: snapshot }))).toMatchObject({ kind: 'unplaced' });
});
test('duplicate configured spaces do not guess a destination', () => {
  const snapshot = layout(); snapshot.spaces.push({ id: 'space-other' as SpaceId, name: 'Work', tabs: [tab('tab-other')] });
  expect(selectRemoteSessionSlot(input({ layout: snapshot }))).toMatchObject({ kind: 'unplaced' });
});
