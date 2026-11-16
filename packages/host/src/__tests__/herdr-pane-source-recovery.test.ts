// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPaneSourceEffects } from '../herdr/pane-source.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import type { HcClient, Owner, TerminalAddress, TerminalSummary } from '../../../herdr/src/contracts.js';
import type { PaneSourceInventoryPorts } from '../herdr/pane-endpoint.js';
const boundary = vi.hoisted(() => ({ terminals: new Map<string, TerminalSummary>() }));
vi.mock('../session-run-db.js', () => ({ openSessionHistoryDb: () => ({ db: { prepare: () => ({ get: () => ({ name: 'Child', status: 'running', child_mode: 'rpc' }) }), close() {} } }) }));
vi.mock('../../../herdr/src/client/argv-client.js', () => ({ createArgvClient: () => ({ exec: async () => { throw new Error('Unexpected remote execution'); } }) }));
vi.mock('../../../herdr/src/client/hc.js', () => ({ invokeCli: async (_binary: string, args: string[]) => {
  if (args[0] === 'server') return { version: '0.1.18', core: { id: 'core-local' } };
  if (args[0] === 'get') {
    const address = args[1], terminal = boundary.terminals.get(address.split('/').at(-1)!);
    if (!terminal) throw new Error('Missing terminal');
    return { ...terminal, address, created_ms: 100, exit_code: terminal.exitCode, finished_ms: terminal.finishedAt, title: 'Child' };
  }
  throw new Error('Unexpected CLI call');
} }));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); boundary.terminals.clear(); });
async function fixture(failure: 'absent' | 'lost-reply') {
  const base = resolve('.spider/scratch/pane-source-recovery'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'f-')); roots.push(root);
  const owner = { sessionId: 'session-1', generation: 'gen-1', cwd: root, sessionFile: null, name: 'Builder', terminal: { coreId: 'core-local', terminalId: 'owner', address: 'owner', socket: '/owned/core.sock', sessionNamespace: 'fixture' } } as Owner;
  let attempts = 0;
  const hc = { identity: async () => ({ coreId: 'core-local', socket: '/owned/core.sock', sessionNamespace: 'fixture' }), machines: async () => [],
    run: vi.fn(async request => {
      attempts++;
      if (attempts === 1 && failure === 'absent') throw new Error('runtime unavailable');
      const address = 'viewer-1' as TerminalAddress;
      boundary.terminals.set(address, { address, parent: owner.terminal.address, state: 'live', labels: request.labels, status: null, exitCode: null, reason: null, signal: null, finishedAt: null, cols: 80, rows: 24 });
      if (attempts === 1 && failure === 'lost-reply') throw new Error('launch reply lost');
      return { address, coreId: 'core-local' };
    }),
    get: async (address: TerminalAddress) => boundary.terminals.get(String(address).split('/').at(-1)!),
    events: () => ({ ready: Promise.resolve(), subscribe: (listener: Parameters<ReturnType<HcClient['events']>['subscribe']>[0]) => { listener({ type: 'snapshot', seq: 1, terminals: [...boundary.terminals.values()] }); return () => {}; }, dispose() {} }),
    kill: vi.fn(async address => { const terminal = boundary.terminals.get(String(address).split('/').at(-1)!); if (terminal) terminal.state = 'finished'; }),
    rm: vi.fn(async address => { boundary.terminals.delete(String(address).split('/').at(-1)!); }),
  } as unknown as HcClient;
  const config = parseHerdrConfig({ mode: 'core-only', core: { binary: '/owned/hc', config: join(root, 'core.toml') }, globalRoot: root, agentDirectory: join(root, 'agent'), shellRc: join(root, 'shellrc'), machines: [] });
  const source = { readFeed: async () => ({ generation: owner.generation, runs: { rows: [] }, ipc: { address: '/owned/ipc', capabilityFile: '/owned/capability' } }) } as unknown as PaneSourceInventoryPorts;
  const effects = createPaneSourceEffects({ config, hc, source, resolveOwner: async () => owner, packageRoot: process.cwd(), env: { HC_SOCKET: '/owned/core.sock' } });
  const request = { version: 1 as const, op: 'launch-viewer' as const, sessionId: owner.sessionId, generation: owner.generation, runId: 'run-1' as never, leaseId: 'lease-1' };
  return { root, owner, effects, request, hc };
}
test('production recovers from a proved absent launch without stranding the display lease', async () => {
  const f = await fixture('absent');
  await expect(f.effects.launchViewer!(f.owner, f.request)).rejects.toThrow('runtime unavailable');
  expect((await readdir(join(f.root, 'herdr/panes/view-leases'))).filter(name => name.endsWith('.json'))).toEqual([]);
  expect(await f.effects.launchViewer!(f.owner, f.request)).toMatchObject({ kind: 'subagent', runId: 'run-1' });
  expect(f.hc.run).toHaveBeenCalledTimes(2);
});
test('production recovers a labelled viewer after a lost reply and removes its finished terminal on close', async () => {
  const f = await fixture('lost-reply');
  expect(await f.effects.launchViewer!(f.owner, f.request)).toMatchObject({ kind: 'subagent', address: 'core-local/viewer-1' });
  expect(f.hc.run).toHaveBeenCalledTimes(1);
  expect(await f.effects.stopViewer!(f.request.leaseId)).toMatchObject({ status: 'complete' });
  expect(boundary.terminals.size).toBe(0);
  expect((await readdir(join(f.root, 'herdr/panes/view-leases'))).filter(name => name.endsWith('.json'))).toEqual([]);
});
