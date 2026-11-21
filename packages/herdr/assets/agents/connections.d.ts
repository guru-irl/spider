// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

export type ConnectionState = 'connected' | 'disconnected' | 'needs-login' | 'unknown';
export interface NativeMachineState { state?: unknown; why?: unknown }
export interface MachineRecord {
  name: string; state: string; id?: string; target?: string; via?: boolean; session?: string; temporary?: boolean; why?: string;
}
export interface MachineRepair { machine: MachineRecord; removed: boolean; busy: boolean; error: string | null }
export interface MachineConnectionManager {
  readonly machines: readonly MachineRecord[];
  readonly snapshot: readonly { name: string | null; state: string; why?: string }[];
  readonly coreId: string | null;
  readonly observed: boolean;
  repair(name: string): MachineRepair | null;
  refresh(): Promise<void>;
  reconnect(name: string): Promise<void>;
  close(): void;
}
export function machineRebuilt(machine: NativeMachineState | null | undefined): boolean;
export function machineState(machine: NativeMachineState | null | undefined): ConnectionState;
export function machineConnection(machine: string | null, snapshot: readonly { name: string | null; state: string; why?: string }[] | null): ConnectionState;
export function createMachineConnections(ports: {
  hc(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  notify(): void;
}): MachineConnectionManager;
