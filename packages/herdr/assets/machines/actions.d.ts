// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { MachineChoice, PaneOpenIntent, PanePlace } from '../../src/panes/types.js';
import type { PickerFacts } from './picker.js';

export interface PickerOpenPorts {
  facts(): PickerFacts;
  openOverlay(mod: string, props: { continuation: string; machineKey: string | null; intent: PaneOpenIntent }): void;
  config: { nodePath: string; cliPath: string };
}
export interface MenuTicket { token: string; operationId: string }
export interface TicketStore { shared(key: string): unknown; setShared(key: string, value: unknown): unknown; now?(): number }
export interface MenuSelection { token: string; operationId: string; intent: PaneOpenIntent; machineKey: string; alias: string | null; coreId: MachineChoice['coreId']; machineId: string | null; expires: number }
export function capturePaneIntent(facts: PickerFacts, place: PanePlace): PaneOpenIntent;
export function openMachinePicker(intent: PaneOpenIntent | { place: PanePlace; program: 'menu' }, ports: PickerOpenPorts): void;
export function issueMenuTicket(intent: PaneOpenIntent, machine: MachineChoice, store: TicketStore): MenuTicket;
export function peekMenuTicket(ticket: MenuTicket, store: TicketStore): MenuSelection | null;
export function consumeMenuTicket(ticket: MenuTicket, store: TicketStore): MenuSelection | null;
export function openPickerFromHost(input: { place: PanePlace; program: PaneOpenIntent['program'] | 'menu'; pane?: string; space?: string }, host: typeof import('herdr')): void;
export function chooseMenuProgram(ticket: MenuTicket | null | undefined, program: PaneOpenIntent['program'], space: string | undefined, host: typeof import('herdr')): Promise<void>;
export function selectMachine(rows: readonly MachineChoice[], filter: string, preferredKey: string | null): string | null;
