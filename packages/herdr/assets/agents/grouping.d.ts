// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { HerdrLabelContract } from '../../src/contracts.js';
import type { NavigationTarget } from '../shared/navigation.js';
import type { AgentTerminal, ChildRow } from './children.js';

export type NativeAgent = {
  address: string; pane: string | null; space: string | null; space_name: string; tab: string | null; title: string; navigation?: NavigationTarget;
  program: { name: string; key?: string }; status: string; pinned: boolean; focused: boolean;
};
export type MachineGroup = { id: string; machine: string | null; label: string; members: NativeAgent[] };
export function agentMachine(agent: NativeAgent, terminals: readonly AgentTerminal[], contract: HerdrLabelContract, terminalIndex?: ReadonlyMap<string, AgentTerminal>): string | null;
export function groupAgentsByMachine(agents: readonly NativeAgent[], terminals: readonly AgentTerminal[], contract: HerdrLabelContract, knownMachines: readonly { name: string | null }[], terminalIndex?: ReadonlyMap<string, AgentTerminal>): MachineGroup[];
export function machineGroupCounts(children: readonly ChildRow[]): { subagents: number; consoles: number };
