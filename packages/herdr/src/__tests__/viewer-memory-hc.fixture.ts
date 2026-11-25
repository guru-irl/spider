// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { HerdrError } from '../client/parse.js';
import type { HcClient, HcEvent, Owner, TerminalAddress, TerminalSummary } from '../contracts.js';

export async function createMemoryViewerHarness(): Promise<HerdrHarness> {
  const h = await createHerdrHarness('fake');
  const terminal = { coreId: 'fixture-core', terminalId: 'owner', address: 'owner', socket: h.localSocket, sessionNamespace: h.namespace };
  h.owner = { sessionId: randomUUID(), generation: randomUUID(), terminal, cwd: h.root, sessionFile: null, name: 'fixture' } as Owner;
  const terminals = new Map<TerminalAddress, TerminalSummary>();
  const calls: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
  const listeners = new Set<(event: HcEvent) => void>();
  let sequence = 0;
  const ownerAddress = terminal.address as TerminalAddress;
  terminals.set(ownerAddress, { address: ownerAddress, parent: null, labels: {}, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null });
  const copy = (value: TerminalSummary): TerminalSummary => ({ ...value, labels: { ...value.labels } });
  const emit = (event: HcEvent) => { for (const listener of listeners) listener(event); };
  const lookup = (address: TerminalAddress) => {
    const value = terminals.get(address);
    if (!value) throw new HerdrError('not_found', 'Terminal not found');
    return value;
  };
  const hc: HcClient = {
    identity: async () => h.owner!.terminal,
    caller: async () => h.owner!.terminal,
    machines: async () => [],
    run: async request => {
      const address = `${request.on ? `${request.on}/` : ''}t${++sequence}` as TerminalAddress;
      const value: TerminalSummary = { address, parent: request.parent === undefined ? h.owner!.terminal.address : request.parent, labels: { ...request.labels }, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null };
      terminals.set(address, value);
      calls.push({ argv: ['run', ...Object.entries(request.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`])], env: {} });
      emit({ type: 'created', seq: sequence, terminal: address, data: copy(value) });
      return { address, coreId: h.owner!.terminal.coreId };
    },
    get: async address => copy(lookup(address)),
    read: async () => '',
    kill: async address => {
      const value = lookup(address);
      const finish = { exitCode: 0, reason: 'exited', signal: null, finishedAt: Date.now() };
      Object.assign(value, { state: 'finished', ...finish });
      emit({ type: 'finished', seq: ++sequence, terminal: address, data: finish });
    },
    rm: async address => {
      lookup(address); terminals.delete(address);
      emit({ type: 'removed', seq: ++sequence, terminal: address });
    },
    setLabels: async (address, changes) => {
      const value = lookup(address), labels = { ...value.labels };
      for (const [key, change] of Object.entries(changes)) if (change === null) delete labels[key]; else labels[key] = change;
      value.labels = labels;
    },
    fileRead: async () => { throw new Error('Unexpected file read'); },
    fileWrite: async () => { throw new Error('Unexpected file write'); },
    events: () => {
      const own = new Set<(event: HcEvent) => void>();
      return {
        ready: Promise.resolve(),
        lookup: async address => { const value = terminals.get(address); return value ? copy(value) : null; },
        subscribe: listener => {
          own.add(listener); listeners.add(listener);
          queueMicrotask(() => { if (own.has(listener)) listener({ type: 'snapshot', seq: sequence, terminals: [...terminals.values()].map(copy) }); });
          return () => { own.delete(listener); listeners.delete(listener); };
        },
        dispose: () => { for (const listener of own) listeners.delete(listener); own.clear(); },
      };
    },
  };
  h.hc = hc;
  h.calls = async () => calls;
  return h;
}
