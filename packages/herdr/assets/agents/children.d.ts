// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { HerdrLabelContract, SessionFeed, IpcDescriptor, SessionIpcRequest } from '../../src/contracts.js';
export interface AgentTerminal { address: string; parent: string | null; state: 'live' | 'finished'; status: string | { state: string } | null; labels: Readonly<Record<string, string>>; name?: string | null; program?: { name?: string; icon?: string; tint?: boolean }; template?: string | null; exitCode?: number | null; finishedAt?: number | null; reason?: string | null; signal?: number | null; exit_code?: number | null; finished_ms?: number | null }
export interface ChildRow { key: string; kind: 'remote' | 'subagent' | 'console' | 'native'; address: string | null; originalAddress: string | null; name: string; status: string; outcome: string | null; completeness: 'unknown' | 'complete'; finishedAt: number | null; retained: boolean; depth: number; parentKey: string | null; machine: string | null; agentKey: string; terminal: AgentTerminal | null; action: { kind: 'peek'; terminal: string } | { kind: 'ipc'; descriptor: IpcDescriptor; request: SessionIpcRequest } | null }
export function projectAgentChildren(terminals: readonly AgentTerminal[], feeds: readonly SessionFeed[], ownerAddress: string, labelContract: HerdrLabelContract, options?: { now?: number; completedHours?: number; completedRows?: number }): ChildRow[];
export interface AgentFeedPorts { listSessionIds(root: string): Promise<readonly string[]>; readTextFile(path: string): Promise<string | null>; parseFeed(text: string): SessionFeed | null }
export function loadAgentFeeds(root: string, ports: AgentFeedPorts): Promise<{ feeds: SessionFeed[]; errors: string[]; truncated: boolean }>;
export function filterTopLevelAgents<T extends { address: string }>(agents: readonly T[], terminals: readonly AgentTerminal[], contract: HerdrLabelContract): T[];
export interface AgentFilters { machine: string | null; agent: string | null }
export function selectAgentChildren(rows: readonly ChildRow[], filters: AgentFilters, expandedConsoles?: readonly string[]): ChildRow[];
export interface AgentFilterOption { id: string; label: string }
export function agentFilterOptions(terminals: readonly AgentTerminal[], feeds: readonly SessionFeed[], contract: HerdrLabelContract): { machines: AgentFilterOption[]; agents: AgentFilterOption[] };
export function createAgentFilters(modId: string, ports: { read(key: string): unknown; write(key: string, value: AgentFilters): void }): { get(): AgentFilters; set(value: AgentFilters): void };
export interface MachineRow { name: string; status: 'connected' | 'disconnected' | 'unavailable' }
export function projectMachineRows(configured: readonly ({ name?: unknown; temporary?: unknown } | null)[] | null | undefined, inventory: readonly { name?: unknown; state?: unknown }[] | null | undefined): MachineRow[];
