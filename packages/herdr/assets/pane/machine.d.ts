// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { div } from 'gpui-kit';
import type { TerminalAddress } from '../../src/contracts.js';
import type { PanePresentation, PaneTerminalFacts } from '../../src/panes/types.js';

export interface PaneHeaderFacts {
  address: TerminalAddress | null;
  programIsAgent: boolean;
  nativeTitle: string;
  nativeStatus: string | null;
  nativeCwd: string | null;
  labels: Readonly<Record<string, string>>;
}
export interface MachineFact { label: string; known: boolean }
export function panePresentation(pane: PaneHeaderFacts, presentations: readonly PanePresentation[]): PanePresentation | null;
export function paneMachineFact(pane: PaneHeaderFacts, presentations: readonly PanePresentation[]): MachineFact | null;
export function paneTargetFacts(pane: PaneHeaderFacts, presentations: readonly PanePresentation[], targetFacts: Readonly<Record<string, PaneTerminalFacts>>): PaneTerminalFacts | null;
export function resolvePaneHeaderFacts(pane: PaneHeaderFacts, presentations: readonly PanePresentation[], targetFacts: Readonly<Record<string, PaneTerminalFacts>>): { name: string; status: string | null; cwd: string | null; machine: MachineFact | null };
export function renderMachinePill(fact: MachineFact, theme: Record<string, string>, font: string): ReturnType<typeof div>;
export function initPaneHeaderProjection(view: object, cx: unknown, host: typeof import('herdr')): void;
export function closePaneHeaderProjection(view: object): void;
