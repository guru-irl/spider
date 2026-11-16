// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { Generation, HerdrLabelContract, IpcDescriptor, SessionFeed, SessionIpcRequest, SpaceId, TabId } from '../../src/contracts.js';
import type { PaneServiceSnapshot } from '../../src/panes/types.js';
import type { PaneUiRequest } from './feed.js';
import type { AgentTerminal } from '../agents/children.js';

export interface NativeAgent {
  address: string; pane: string; space: string; space_name: string; tab: string; title: string;
  program: { name: string; key?: string }; status: string; pinned: boolean; focused: boolean;
}
export interface SpaceSnapshot {
  id: string; index: number; name: string; machine?: string | null; active: boolean;
  tabs: { id: string; name: string; active: boolean; status: string | null }[];
}
export interface PaneSnapshot { pane: string; terminal: string | null; tab: string; cwd: string | null }
export type Destination = { space: SpaceId; tab: TabId } | null;
export interface NavigationSnapshot {
  paneSnapshot?: PaneServiceSnapshot | null;
  coreId: string; destination: Destination; agents: readonly NativeAgent[]; terminals: readonly AgentTerminal[];
  panes: readonly PaneSnapshot[]; spaces: readonly SpaceSnapshot[]; feeds: readonly SessionFeed[];
  contract: HerdrLabelContract; machines: readonly { name: string | null; layout: string; coreId?: string }[];
  now: number; completedHours: number; completedRows: number; includeChildren?: boolean;
}
export type NavigationAction =
  | { kind: 'pane'; request: PaneUiRequest }
  | { kind: 'focus'; pane: string }
  | { kind: 'ipc'; descriptor: IpcDescriptor; request: SessionIpcRequest | { op: 'openSession'; generation: Generation; destination: Destination } };
export interface NavigationTarget {
  id: string; kind: 'agent' | 'terminal' | 'subagent' | 'console'; ownerId: string | null;
  generation?: string | null; presentationId?: string | null; expectedRevision?: number | null;
  sessionId: string | null; terminal: string | null; pane: string | null;
  space: string | null; tab: string | null; name: string; path: string | null;
  status: string; machine: string | null; retained: boolean; action: NavigationAction | null; disabledReason?: string;
}
export function projectNavigation(snapshot: NavigationSnapshot): NavigationTarget[];
export function sessionDisplayName(agent: NativeAgent, terminal: AgentTerminal | null, feeds: readonly SessionFeed[]): string;

export function navigationAgents(snapshot: NavigationSnapshot): (Omit<NativeAgent, "pane" | "space" | "tab"> & { pane: string | null; space: string | null; tab: string | null; navigation: NavigationTarget })[];
