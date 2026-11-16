// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { HerdrConfig, OwnerPlacement, SessionId, SpaceId, TabId } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { paneId } from '../panes/codec.js';
import type { AppPaneCapabilities, PaneAgentRow, PanePlacementStore, PlacementState } from '../panes/types.js';
import type { LayoutSnapshot } from './setup.js';

export type RemoteSessionSlot =
  | { kind: 'slot'; space: SpaceId; tab: TabId | null }
  | { kind: 'unplaced'; reason: string; space: SpaceId | null };
export interface RemoteSessionPlacementInput {
  row: PaneAgentRow; rows: readonly PaneAgentRow[];
  inventoryComplete: boolean; inventoryStale: boolean;
  config: HerdrConfig; state: PlacementState; layout: LayoutSnapshot; capabilities: AppPaneCapabilities;
}
const unplaced = (reason: string): RemoteSessionSlot => ({ kind: 'unplaced', reason, space: null });
function validId(value: string): boolean { try { paneId(value); return true; } catch { return false; } }
function existingSlot(layout: LayoutSnapshot, space: string, tab: string): RemoteSessionSlot | null {
  if (!validId(space) || !validId(tab)) return null;
  const spaces = layout.spaces.filter(item => item.id === space);
  if (spaces.length !== 1 || spaces[0].tabs.filter(item => item.id === tab).length !== 1 || layout.spaces.flatMap(item => item.tabs).filter(item => item.id === tab).length !== 1) return null;
  return { kind: 'slot', space: spaces[0].id, tab: tab as TabId };
}
function managedTab(state: PlacementState, space: SpaceId, tab: TabId): boolean {
  return state.presentations.some(p => p.visibility !== 'ended' && p.slot?.space === space && p.slot.tab === tab)
    || state.slots.some(s => s.space === space && s.tab === tab)
    || state.choices.some(c => c.space === space && c.tab === tab);
}
/** Selects a Mac destination only; it does not start a process or mutate the layout. */
export function selectRemoteSessionSlot(input: RemoteSessionPlacementInput): RemoteSessionSlot {
  const { row, rows, state, layout, config, capabilities } = input;
  if (row.unavailableReason !== null || !row.owner || !row.target || !row.generation) return unplaced('not-in-hc');
  const identities = rows.filter(candidate => candidate.sessionId === row.sessionId);
  if (identities.length > 1) return unplaced('session-id-conflict');
  const known = identities[0];
  if (!known || known.machineKey !== row.machineKey || known.generation !== row.generation || known.target?.coreId !== row.target.coreId || known.target?.terminalId !== row.target.terminalId || known.target?.createdMs !== row.target.createdMs) return unplaced('inventory-unavailable');
  const presentations = state.presentations.filter(p => p.role === 'agent' && p.target.sessionId === row.sessionId && p.visibility !== 'ended');
  if (presentations.length > 1) return unplaced('presentation-conflict');
  if (presentations[0]?.visibility === 'parked') return unplaced('parked');
  if (presentations[0]?.visibility === 'closing') return unplaced('closing');
  const choices = state.choices.filter(choice => choice.session === row.sessionId);
  if (choices.length > 1) return unplaced('choice-conflict');
  if (choices.length) return existingSlot(layout, choices[0].space, choices[0].tab) ?? unplaced('choice-unavailable');
  const presented = presentations[0]?.slot;
  if (presented) return existingSlot(layout, presented.space, presented.tab) ?? unplaced('slot-unavailable');
  const remembered = state.slots.filter(slot => slot.session === row.sessionId);
  if (remembered.length > 1) return unplaced('slot-conflict');
  if (remembered.length) return existingSlot(layout, remembered[0].space, remembered[0].tab) ?? unplaced('slot-unavailable');
  if (!row.name) return unplaced('no-placement-choice');
  const configured = config.spaces.flatMap(space => space.sessions.flatMap(selector =>
    'name' in selector && selector.name === row.name && (!selector.sessionId || selector.sessionId === row.sessionId) ? [{ space, selector }] : []));
  if (!configured.length) return unplaced('no-placement-choice');
  if (configured.length > 1) return unplaced('configuration-ambiguous');
  if (!input.inventoryComplete || input.inventoryStale) return unplaced('inventory-unavailable');
  const match = configured[0];
  if (!match.selector.sessionId && rows.filter(candidate => candidate.name === row.name).length !== 1) return unplaced('name-ambiguous');
  const spaces = layout.spaces.filter(space => space.name === match.space.name);
  if (spaces.length !== 1 || !validId(spaces[0].id) || layout.spaces.filter(space => space.id === spaces[0].id).length !== 1) return unplaced('configured-space-unavailable');
  const space = spaces[0];
  if ((match.space.layout ?? config.layout ?? 'panes') === 'tabs' && capabilities.backgroundTabCreation) return { kind: 'slot', space: space.id, tab: null };
  const tab = space.tabs.find(candidate => managedTab(state, space.id, candidate.id)) ?? space.tabs[0];
  return tab ? existingSlot(layout, space.id, tab.id) ?? unplaced('configured-space-unavailable') : { kind: 'unplaced', reason: 'configured-space-pending', space: space.id };
}
/** Call only after the app has acknowledged the user's manual placement. */
export async function rememberRemoteSessionPlacement(sessionId: SessionId, placement: OwnerPlacement, store: PanePlacementStore): Promise<void> {
  paneId(sessionId); paneId(placement.space); paneId(placement.tab); paneId(placement.pane);
  await store.update(state => ({ ...state, choices: [...state.choices.filter(choice => choice.session !== sessionId), { session: sessionId, space: placement.space, tab: placement.tab, revision: state.revision + 1 }] }));
}
export interface RemotePassivePlacementPorts {
  /** Returns an observed placement, or null before effects if background creation cannot be guaranteed. */
  createTabWithoutFocus(request: { space: SpaceId; focus: false }): Promise<OwnerPlacement | null>;
  /** Returns an observed placement, or null before effects if placing cannot be guaranteed to preserve focus. */
  placePaneWithoutFocus(request: { space: SpaceId; tab: TabId }): Promise<OwnerPlacement | null>;
}
export type RemotePassivePlacementResult =
  | { status: 'placed'; placement: OwnerPlacement }
  | { status: 'deferred'; reason: string; space: SpaceId | null };
/** The ports must preserve shown space, selected tab and keyboard focus; they must never start pi. */
export async function placeRemoteSessionWithoutFocus(slot: RemoteSessionSlot, capabilities: AppPaneCapabilities, ports: RemotePassivePlacementPorts): Promise<RemotePassivePlacementResult> {
  if (slot.kind === 'unplaced') return { status: 'deferred', reason: slot.reason, space: slot.space };
  paneId(slot.space); if (slot.tab !== null) paneId(slot.tab);
  if (slot.tab === null && !capabilities.backgroundTabCreation) return { status: 'deferred', reason: 'background-tab-unavailable', space: slot.space };
  const placement = slot.tab === null
    ? await ports.createTabWithoutFocus({ space: slot.space, focus: false })
    : await ports.placePaneWithoutFocus({ space: slot.space, tab: slot.tab });
  if (!placement) return { status: 'deferred', reason: 'no-focus-unavailable', space: slot.space };
  paneId(placement.space); paneId(placement.tab); paneId(placement.pane);
  if (placement.space !== slot.space || slot.tab !== null && placement.tab !== slot.tab) throw new HerdrError('pane-placement-mismatch', 'Observed placement differs from the selected destination');
  return { status: 'placed', placement };
}
