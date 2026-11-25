// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { HerdrError } from '../client/parse.js';
import type { CoreId, Generation, HcClient, HcEvent, Owner, SessionId, TerminalAddress, TerminalId, TerminalSummary } from '../contracts.js';
import type { OwnedResource } from './testutil.js';

// The process-backed placement tests remain responsible for the HC boundary.
export async function createInProcessViewerHarness(): Promise<{
  root: string; owner: Owner; hc: HcClient; start(): Promise<void>; close(): Promise<void>; remainingOwnedResources(): Promise<OwnedResource[]>;
}> {
  const base = resolve('.spider/scratch/h');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'viewer-'));
  const coreId = 'viewer-core' as CoreId;
  const core = { coreId, socket: join(root, 'core.sock'), sessionNamespace: 'fixture' };
  const terminal = { ...core, terminalId: 'owner' as TerminalId, address: 'owner' as TerminalAddress };
  const owner: Owner = { sessionId: 'viewer-session' as SessionId, generation: 'viewer-generation' as Generation, terminal, cwd: root, sessionFile: null, name: 'fixture' };
  const terminals = new Map<TerminalAddress, TerminalSummary>();
  const listeners = new Set<(event: HcEvent) => void>();
  let sequence = 0, streams = 0, closed = false;
  const emit = (event: HcEvent) => { for (const listener of listeners) listener(event); };
  const get = (address: TerminalAddress): TerminalSummary => {
    const value = terminals.get(address);
    if (!value) throw new HerdrError('not_found', 'No such fixture terminal');
    return value;
  };
  const unavailable = (): never => { throw new Error('Unexpected in-process viewer harness operation'); };
  const unsupported = async (): Promise<never> => unavailable();
  const hc: HcClient = {
    identity: async () => core,
    caller: async () => terminal,
    machines: unsupported,
    run: async request => {
      const address = `viewer-${++sequence}` as TerminalAddress;
      const value: TerminalSummary = { address, parent: request.parent ?? null, labels: { ...request.labels }, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null };
      terminals.set(address, value); emit({ type: 'created', seq: sequence, terminal: address, data: value });
      return { address, coreId };
    },
    get: async address => get(address),
    read: unsupported,
    kill: async address => {
      const previous = get(address), finish = { exitCode: 0, reason: 'exited', signal: null, finishedAt: Date.now() };
      terminals.set(address, { ...previous, state: 'finished', ...finish });
      emit({ type: 'finished', seq: ++sequence, terminal: address, data: finish });
    },
    rm: async address => {
      get(address); terminals.delete(address); emit({ type: 'removed', seq: ++sequence, terminal: address });
    },
    setLabels: async (address, changes) => {
      const previous = get(address), labels = { ...previous.labels };
      for (const [key, value] of Object.entries(changes)) { if (value === null) delete labels[key]; else labels[key] = value; }
      terminals.set(address, { ...previous, labels });
    },
    fileRead: unsupported, fileWrite: unsupported,
    events: () => {
      streams++;
      const own = new Set<(event: HcEvent) => void>();
      let disposed = false, initialized = false, ready!: () => void;
      const promise = new Promise<void>(resolve => { ready = resolve; });
      const snapshot = (listener: (event: HcEvent) => void) => {
        if (!disposed && own.has(listener)) listener({ type: 'snapshot', seq: sequence, terminals: [...terminals.values()] });
      };
      queueMicrotask(() => { initialized = true; for (const listener of own) snapshot(listener); ready(); });
      return {
        ready: promise,
        lookup: async address => terminals.get(address) ?? null,
        subscribe: listener => {
          if (disposed) return unavailable();
          own.add(listener); listeners.add(listener);
          if (initialized) queueMicrotask(() => snapshot(listener));
          return () => { own.delete(listener); listeners.delete(listener); };
        },
        dispose: () => {
          if (disposed) return;
          disposed = true; streams--; for (const listener of own) listeners.delete(listener); own.clear();
        },
      };
    },
  };
  return {
    root, owner, hc,
    start: async () => { if (closed) throw new Error('The viewer harness is closed'); },
    close: async () => { if (!closed) { terminals.clear(); await rm(root, { recursive: true, force: true }); closed = true; } },
    remainingOwnedResources: async () => streams ? [{ kind: 'event-stream', id: String(streams) }] : [],
  };
}
