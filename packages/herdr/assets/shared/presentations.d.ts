// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { ConsoleId, CoreId, Generation, RunId, SessionId, SpaceId, TabId, TerminalAddress } from '../../src/contracts.js';
import type { PaneAgentRow, PanePresentation, PaneTarget } from '../../src/panes/types.js';
export interface NativePresentationFact {
  address: TerminalAddress; space: SpaceId | null; tab: TabId | null; name: string | null;
  isAgent: boolean; labels: Readonly<Record<string, string>>;
}
export interface NavigationPresentation {
  kind: 'session' | 'terminal' | 'subagent' | 'console'; presentationId: string | null;
  generation: Generation | null; machineKey: string | null;
  sessionId: SessionId | null; runId: RunId | null; consoleId: ConsoleId | null;
  execution: PaneTarget | null; displayTerminal: TerminalAddress | null; unavailableReason: string | null;
  space: SpaceId | null; tab: TabId | null; name: string; machineLabel: string; status: string;
  cwd: string | null; children: NavigationPresentation[];
}
export interface PanePresentationProjectionInput {
  agents: readonly PaneAgentRow[]; presentations: readonly PanePresentation[]; native: readonly NativePresentationFact[];
  /** Selected local core; null or omitted preserves an unavailable row's machine key. */
  localCoreId?: CoreId | null;
  includeChildren?: boolean;
  includeRetained?: boolean;
}
export function projectPanePresentations(input: PanePresentationProjectionInput): NavigationPresentation[];
