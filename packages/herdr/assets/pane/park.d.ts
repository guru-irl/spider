// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { AgentTerminal } from '../agents/children.js';
import type { HerdrLabelContract } from '../../src/contracts.js';
export function parkFocusedTerminal(
  focus: { pane: string | null; terminal: string | null } | null,
  terminals: readonly AgentTerminal[],
  contract: HerdrLabelContract,
  run: (name: string, args: Record<string, unknown>) => null,
  report?: (message: string) => void,
): boolean;
