// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { encodePaneServiceReply } from './codec.js';
import type { MachineChoice, PaneAgentRow, PaneServiceSnapshot, PaneTerminalFacts, PlacementState } from './types.js';
export function paneSnapshot(state: PlacementState, machines: readonly MachineChoice[], inventory: { rows: readonly PaneAgentRow[]; complete: boolean }, facts: Readonly<Record<string, PaneTerminalFacts>>): PaneServiceSnapshot {
  const live = state.presentations.filter(p => p.visibility !== 'ended');
  const presentations = live.slice(0, 256), rows = inventory.rows.slice(0, 256);
  const targetFacts = Object.fromEntries(presentations.flatMap(p => {
    const key = `${p.target.coreId}/${p.target.terminalId}`;
    return facts[key] ? [[key, facts[key]]] : [];
  }));
  const reply: PaneServiceSnapshot = { version: 1, kind: 'snapshot', revision: state.revision, machines, presentations, rows, targetFacts,
    complete: inventory.complete && inventory.rows.length <= 256 && live.length <= 256, omittedRows: inventory.rows.length - rows.length };
  while (Buffer.byteLength(JSON.stringify(reply)) > 1024 * 1024) {
    reply.complete = false;
    if (rows.length) { rows.pop(); reply.omittedRows++; continue; }
    const key = Object.keys(targetFacts).at(-1);
    if (key) { delete targetFacts[key]; continue; }
    if (presentations.length) { presentations.pop(); continue; }
    break;
  }
  encodePaneServiceReply(reply); return reply;
}
