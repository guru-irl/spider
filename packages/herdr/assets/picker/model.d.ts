// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { NavigationTarget, SpaceSnapshot } from '../shared/navigation.js';

type Row = { id: string; label: string; enabled: boolean };
export type PickerRow =
  | (Row & { kind: 'heading'; enabled: false })
  | (Row & { kind: 'space'; space: string })
  | (Row & { kind: 'tab'; space: string; tab: string })
  | (Row & { kind: 'target'; target: NavigationTarget; depth: number })
  | (Row & { kind: 'new-tab'; machine: '' } & ({ enabled: true; space: string } | { enabled: false; space: null }))
  | (Row & { kind: 'new-space'; machine: '' });
export function pickerRows(spaces: readonly SpaceSnapshot[], targets: readonly NavigationTarget[], filter: string): PickerRow[];
export function selectPickerRow(rows: readonly PickerRow[], selectedId: string | null, direction: -1 | 0 | 1): string | null;
