// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { PaneServiceSnapshot } from '../../src/panes/types.js';
import type { PaneNavigationIndex } from './navigation.js';

type Exec = (program: string, args: string[], options?: { timeout: number }) => Promise<{ code: number; stdout: string }>;
interface PaneState {
  configured: boolean;
  index: PaneNavigationIndex | { snapshot: null; sources: ReadonlyMap<string, never>; hidden: ReadonlyMap<string, number>; key: string } | null;
  snapshot: PaneServiceSnapshot | null;
  unavailable: boolean;
}
type PaneConfig = { paneServiceConfigured?: boolean; nodePath: string; cliPath: string };
export function createPaneServiceState(config: PaneConfig, ports: {
  exec: Exec;
  timer: { every(ms: number, callback: () => void): { cancel(): void } };
  request(config: PaneConfig, exec: Exec, request: { op: 'snapshot' }): Promise<PaneServiceSnapshot>;
  index(snapshot: PaneServiceSnapshot): PaneNavigationIndex;
  refreshMs: number;
  staleMs: number;
  changed(): void;
}): { state(): PaneState; refresh(): Promise<void>; close(): void };
export function disableUnavailableRemoteActions<T extends { id: string; terminal?: string | null; machine?: string | null; ownerId?: string | null; action?: unknown }>(targets: T[], unavailable: boolean | undefined, localCoreId: string | undefined): T[];
