// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { OwnerPlacement } from '../../src/contracts.js';
import type { PaneActionOutcome, PanePresentation, PaneServiceRequest, PaneServiceSnapshot, PaneTarget } from '../../src/panes/types.js';
import type { PaneHeaderFacts } from './machine.js';

export interface PaneActionContext { pane: OwnerPlacement; header: PaneHeaderFacts; presentation: PanePresentation | null; unknownProxy?: boolean }
export interface PendingPaneConfirmation {
  operationId: string; presentationId: string; expectedRevision: number;
  coreId: PaneTarget['coreId']; terminalId: PaneTarget['terminalId']; createdMs: number; expires: number;
}
export interface PaneActionPorts {
  shared(key: string): unknown;
  setShared(key: string, value: unknown): unknown;
  request(request: PaneServiceRequest): Promise<PaneActionOutcome>;
  resolveTarget(pending: PendingPaneConfirmation): Promise<PaneTarget | null>;
  openConfirm(spec: unknown): void;
  notify(message: string): void;
  nativeClose(context: PaneActionContext): void;
  nativePark(context: PaneActionContext): void;
  run(name: string, args?: Record<string, unknown>): unknown;
  nextCommand(): Promise<string>;
  now?(): number;
  operationId?(): string;
}
export function handlePaneCommand(command: string, context: PaneActionContext | null, ports: PaneActionPorts): Promise<void>;
export function capturePaneAction(host: typeof import('herdr'), paneId: string, snapshot: Pick<PaneServiceSnapshot, 'presentations'> | null): PaneActionContext | null;
export function paneActionPorts(host: typeof import('herdr'), nativeClose: (context: PaneActionContext) => void, nativePark: (context: PaneActionContext) => void): PaneActionPorts;
export function routeMenuPaneCommand(command: 'close' | 'park', target: { pane: string; terminal?: string }, host: typeof import('herdr')): Promise<void>;
