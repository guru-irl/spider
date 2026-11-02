// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
export interface MovePlacement { space: string; tab: string; pane: string }
export type MoveDestination = { kind: 'new'; space?: string } | { kind: 'tab'; space?: string; tab: string } | { kind: 'hide' };
export interface MovePorts {
  placement(address: string): Promise<MovePlacement | null>;
  targetPane(tab: string): Promise<string | null>;
  tabExists?(tab: string): Promise<boolean>;
  run(name: string, args: Record<string, unknown>): Promise<{ error?: { message?: string } } | null | undefined> | { error?: { message?: string } } | null | undefined;
  adopt?(terminal: string, target: { space: string | undefined; tab: string }): Promise<void>;
  createTab?(space: string): Promise<MovePlacement>;
  changed(placement: MovePlacement | null): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  timeoutMs?: number;
}
export function moveTerminal(terminal: string, destination: MoveDestination, ports: MovePorts): Promise<MovePlacement | null>;
export interface MenuTarget { kind: 'subagent' | 'command' | 'session' | 'terminal' | 'mod'; pane?: boolean; active?: boolean; machine?: string | null; terminal?: string | null; key?: string; unmanaged?: boolean; ownsSession?: boolean; descriptor?: { generation: string; [key: string]: unknown } | null }
export interface MenuSpace { id: string; name: string; machine?: string | null; tabs: readonly { id: string; name: string }[] }
export interface MenuGroup { id: string; name: string; tabs: { id: string; name: string }[] }
export type MenuItem = { kind: 'action'; id: 'new' | 'hide' | 'kill'; label: string; disabled?: boolean } | { kind: 'tabs'; id: 'tabs'; label: string; groups: MenuGroup[]; disabled?: boolean } | { kind: 'separator' };
export function menuItems(target: MenuTarget, spaces: readonly MenuSpace[], currentSpace: string | null, currentTab: string | null): MenuItem[];
export function classifyPane(pane: unknown, terminal: unknown, feeds: readonly unknown[], contract: unknown, freshAfter: number): MenuTarget;
export function journalOwnsTerminal(text: string | null, terminal: string): boolean;
export function moveTarget(target: MenuTarget, destination: MoveDestination, ports: { ipc(descriptor: unknown, request: unknown): Promise<unknown>; movePlain(terminal: string | null | undefined, destination: MoveDestination): Promise<unknown> }): Promise<unknown>;
export function stopSessionTarget(target: MenuTarget, ports: { ipc(descriptor: unknown, request: unknown): Promise<unknown> }): Promise<void>;
export function killTarget(target: MenuTarget, ports: { ipc(descriptor: unknown, request: unknown): Promise<unknown>; run(name: string, args: Record<string, unknown>): unknown; confirm(spec: Record<string, unknown>): unknown }): Promise<void>;
