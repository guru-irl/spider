// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { View } from 'gpui-kit';
import type { OwnerPlacement, SpaceId } from '../../src/contracts.js';
import type { MachineChoice, PanePlace, PanePresentation, PaneTarget } from '../../src/panes/types.js';

export interface PickerFacts {
  operationId: string;
  space: SpaceId;
  focused: PanePresentation | null;
  nativeTarget: PaneTarget | null;
  focusedPlacement: OwnerPlacement | null;
  machines: readonly MachineChoice[];
}
export function machinePickerView(defaultPlace: PanePlace): typeof View;
