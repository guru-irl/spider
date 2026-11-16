// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { ChildRow } from './children.js';

export type ConsoleSidebarRow =
  | { kind: 'child'; row: ChildRow }
  | { kind: 'console-group'; key: string; parentKey: string | null; depth: number; count: number; expanded: boolean };
export function projectConsoleGroups(rows: readonly ChildRow[], ownerId: string, expandedGroups: ReadonlySet<string>, liveKeys?: ReadonlySet<string>): ConsoleSidebarRow[];
export function toggleConsoleGroup(expanded: ReadonlySet<string>, key: string): Set<string>;
