// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { OwnerPlacement } from '../../../herdr/src/contracts.js';
import type { PaneAgentRow, PanePlacementStore, PanePresentation, PaneTarget } from '../../../herdr/src/panes/types.js';
import { hash } from '../../../herdr/src/sessions/registry.js';
export async function reconcilePaneRegistrations(input: { store: PanePlacementStore; localCoreId: string; rows: readonly PaneAgentRow[]; nativePlacement(target: PaneTarget): Promise<OwnerPlacement | null> }): Promise<void> {
  for (const row of input.rows) {
    const target = row.target;
    if (!target || !row.owner || row.unavailableReason !== null || !row.generation || target.kind !== 'session') continue;
    if (input.rows.filter(other => other.sessionId === row.sessionId).length !== 1) continue;
    const state = await input.store.read();
    const existing = state.presentations.find(p => p.target.coreId === target.coreId && p.target.terminalId === target.terminalId);
    if (existing) {
      if (existing.target.createdMs !== target.createdMs || existing.visibility === 'closing' || existing.visibility === 'ended') continue;
      if (existing.target.kind === 'terminal') {
        if (Object.entries(existing.target.identityLabels).some(([key, value]) => target.identityLabels[key] !== value)) continue;
      } else if (existing.target.kind !== 'session' || existing.target.sessionId !== row.sessionId || existing.target.generation === row.generation) continue;
      await input.store.update(current => ({ ...current, presentations: current.presentations.map(p => p.id === existing.id && p.revision === existing.revision ? { ...p, target, role: 'agent', revision: p.revision + 1 } : p) }));
      continue;
    }
    if (state.presentations.some(p => p.target.sessionId === row.sessionId) || state.launches.some(launch => launch.operationId === target.identityLabels['spider.pane-operation'])) continue;
    const native = target.coreId === input.localCoreId;
    const slot = native ? await input.nativePlacement(target) : null;
    if (native && !slot) continue;
    const p: PanePresentation = { id: 'session-' + hash(JSON.stringify([row.sessionId, row.generation])), revision: 1, mode: native ? 'native' : 'proxy', role: 'agent', target, proxy: null, slot, visibility: 'visible', launch: native ? 'acknowledged' : 'none', closeOperationId: null, conversion: null };
    await input.store.update(current => current.presentations.some(other => other.target.sessionId === row.sessionId) ? current : { ...current, presentations: [...current.presentations, p] });
  }
}
