// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { PanePresentation, PlacementState } from './types.js';
export function prunePaneHistory(state: PlacementState, removed: readonly Pick<PanePresentation, 'id' | 'revision'>[]): PlacementState {
  const presentations = state.presentations.filter(p => p.visibility !== 'ended' && !removed.some(old => old.id === p.id && old.revision === p.revision));
  const retired = state.presentations.filter(p => !presentations.includes(p));
  if (!retired.length) return state;
  const gone = (session: string) => retired.some(p => p.target.sessionId === session) && !presentations.some(p => p.target.sessionId === session);
  return { ...state, presentations,
    slots: state.slots.filter(slot => !gone(slot.session)), attempts: state.attempts.filter(attempt => !gone(attempt.session)), choices: state.choices.filter(choice => !gone(choice.session)),
    launches: state.launches.filter(launch => launch.state !== 'observed' || !retired.some(p => p.target.coreId === launch.target?.coreId && p.target.terminalId === launch.target.terminalId && p.target.createdMs === launch.target.createdMs)
      || presentations.some(p => p.target.coreId === launch.target?.coreId && p.target.terminalId === launch.target.terminalId && p.target.createdMs === launch.target.createdMs)),
  };
}
