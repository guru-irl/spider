// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { ProcessTerminal, formatProgramStatus, type ProgramStatus } from '@earendil-works/pi-tui';
import type { PendingCounts, SessionFeed } from '../contracts.js';
export interface StatusTerminal { setProgramStatus(status: ProgramStatus): void }
export interface StatusAdapter { update(counts: PendingCounts): void; currentStatus(): SessionFeed['status'] | null; dispose(): void }
export interface DisabledCapability { disabled: true; reason: string }
function merge(native: ProgramStatus, counts: PendingCounts): ProgramStatus {
  if ((native.state !== 'idle' && native.state !== 'done') || !(counts.running + counts.queued + counts.paused)) return native;
  const message = [counts.running ? `${counts.running} subagent${counts.running === 1 ? '' : 's'} running` : '', counts.queued ? `${counts.queued} queued` : '', counts.paused ? `${counts.paused} paused` : ''].filter(Boolean).join(', ');
  return { ...native, state: 'working', message };
}
function validCache(value: unknown): value is ProgramStatus | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const status = value as Record<string, unknown>;
  return ['idle', 'working', 'blocked', 'done', 'error'].includes(String(status.state))
    && (status.message === undefined || typeof status.message === 'string')
    && (status.app === undefined || typeof status.app === 'string')
    && (status.kind === undefined || ['permission', 'question', 'auth'].includes(String(status.kind)));
}
const methodSource = (method: Function): string => Function.prototype.toString.call(method).replace(/\s+/g, '').replace(/'/g, '"');
const nativeSetters = new Set([
  methodSource(ProcessTerminal.prototype.setProgramStatus),
  'setProgramStatus(status){this.programStatus=status.state==="clear"?void0:status,this.programStatusSupported&&process.stdout.write(formatProgramStatus(status))}',
]);
const nativeReplays = new Set([
  methodSource(Reflect.get(ProcessTerminal.prototype, 'writeProgramStatus')),
  'writeProgramStatus(){this.programStatusSupported&&this.programStatus&&process.stdout.write(formatProgramStatus(this.programStatus))}',
]);
/** Detect this activation's actual instance, including pi's supported minified native shape. */
export function detectStatusTerminal(terminal: StatusTerminal): DisabledCapability | null {
  if (process.env.PI_PROGRAM_STATUS === '0') return { disabled: true, reason: 'program-status-disabled' };
  if (typeof terminal.setProgramStatus !== 'function'
    || !nativeSetters.has(methodSource(terminal.setProgramStatus))
    || typeof Reflect.get(terminal, 'writeProgramStatus') !== 'function'
    || !nativeReplays.has(methodSource(Reflect.get(terminal, 'writeProgramStatus')))
    || !validCache(Reflect.get(terminal, 'programStatus'))
    || formatProgramStatus({ state: 'idle' }) !== '\u001b]7501;state=idle\u001b\\') {
    return { disabled: true, reason: 'status-instance-unavailable' };
  }
  const descriptor = Object.getOwnPropertyDescriptor(terminal, 'setProgramStatus');
  if (!Object.isExtensible(terminal) || (descriptor && !descriptor.configurable)) return { disabled: true, reason: 'status-instance-unavailable' };
  return null;
}
export function installStatusAdapter(terminal: StatusTerminal, initial: PendingCounts): StatusAdapter | DisabledCapability {
  const disabled = detectStatusTerminal(terminal);
  if (disabled) return disabled;
  const original = terminal.setProgramStatus;
  const descriptor = Object.getOwnPropertyDescriptor(terminal, 'setProgramStatus');
  let native = Reflect.get(terminal, 'programStatus') as ProgramStatus | undefined;
  let counts = initial;
  let disposed = false;
  const emit = () => { if (native !== undefined) original.call(terminal, merge(native, counts)); };
  const wrapper = (status: ProgramStatus) => { native = status; emit(); };
  Object.defineProperty(terminal, 'setProgramStatus', { configurable: true, writable: true, value: wrapper });
  emit();
  return {
    update(next) { if (!disposed && terminal.setProgramStatus === wrapper) { counts = next; emit(); } },
    currentStatus() {
      if (disposed || terminal.setProgramStatus !== wrapper) return null;
      const effective = Reflect.get(terminal, 'programStatus');
      if (!validCache(effective)) return null;
      return { native: native && native.state !== 'clear' ? native.state : null,
        effective: effective && effective.state !== 'clear' ? effective.state : null, message: effective?.message ?? null };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (terminal.setProgramStatus !== wrapper) return;
      if (descriptor) Object.defineProperty(terminal, 'setProgramStatus', descriptor);
      else Reflect.deleteProperty(terminal, 'setProgramStatus');
      if (native !== undefined) original.call(terminal, native);
    },
  };
}
