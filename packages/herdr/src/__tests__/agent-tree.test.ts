// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { projectAgentChildren, filterTopLevelAgents, selectAgentChildren } from '../../assets/agents/children.js';
import { HerdrLabelContract } from '../contracts.js';
import type { RunId, SessionFeed } from '../contracts.js';
import type { AgentTerminal } from '../../assets/agents/children.js';
import { createHerdrHarness } from './testutil.js';
const contract = HerdrLabelContract;
function feed(owner: SessionFeed['owner'] = { sessionId: 'session', generation: 'generation', terminal: { address: 'agent', terminalId: 'agent', coreId: 'core', socket: '/fixture/socket', sessionNamespace: 'fixture' }, cwd: '/fixture', name: 'Main agent', sessionFile: null } as SessionFeed['owner']): SessionFeed {
  return { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: 2000, owner, lifecycle: 'live', placement: null,
    status: { native: 'working', effective: 'working', message: null }, runs: { rows: [{ id: 'run' as RunId, ownerSessionId: owner.sessionId, name: 'Builder', status: 'running', childMode: 'rpc', canSteer: true, viewer: null, startedAt: 1000, finishedAt: null, result: null }], total: 1, truncated: false },
    todos: { rows: [], total: 0, truncated: false }, triggers: [], approvals: [], notifications: [], errors: [], ipc: { address: '/fixture/ipc', capabilityFile: '/fixture/cap' },
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' } } as SessionFeed;
}
function terminal(address: string, kind: string, extra: Record<string, string> = {}): AgentTerminal {
  return { address, state: 'live', status: 'working', parent: null, name: address, labels: { 'spider.session': 'session', 'spider.owner-core': 'core', 'spider.owner-terminal': 'agent', 'spider.kind': kind, ...extra } };
}
const job = (id: string, extra = {}) => terminal(`remote.invalid/${id}`, 'exec', { 'spider.job': id, 'spider.machine': 'remote.invalid', ...extra });
const consoleTerminal = (id: string, extra = {}) => terminal(`remote.invalid/${id}`, 'remote-console', { 'spider.machine': 'remote.invalid', ...extra });
const rows = (terminals: AgentTerminal[]) => projectAgentChildren(terminals, [feed()], 'agent', contract, { now: 2000 });

test.each(['exec', 'exec-file', 'batch'])('a %s action with spider.job is listed and opens through openJob', kind => {
  const t = terminal('remote.invalid/job', kind, { 'spider.job': 'job' });
  expect(rows([t]).find(r => r.key === 'job')).toMatchObject({ kind: 'remote', depth: 0, action: { kind: 'ipc', request: { op: 'openJob', jobId: 'job' } } });
  expect(filterTopLevelAgents([{ address: 'agent' }, { address: t.address }], [t], contract)).toEqual([{ address: 'agent' }]);
});

test('a job nests under its matching named run even without a native viewer', () => {
  expect(rows([job('child-job', { 'spider.run': 'run' })]).map(r => [r.key, r.name, r.depth, r.parentKey])).toEqual([
    ['run', 'Builder', 0, null], ['child-job', 'remote.invalid/child-job', 1, 'run'],
  ]);
});

test('unmatched or foreign run labels leave jobs under their own session', () => {
  const f = feed(); f.runs.rows[0].ownerSessionId = 'other-session' as never;
  const r = projectAgentChildren([job('child-job', { 'spider.run': 'run' })], [f], 'agent', contract, { now: 2000 });
  expect(r).toHaveLength(1); expect(r[0]).toMatchObject({ key: 'child-job', depth: 0, parentKey: null });
});

test('session and run consoles own only the same agent and machine jobs', () => {
  const ts = [job('main-job'), job('child-job', { 'spider.run': 'run' }), job('other-machine', { 'spider.run': 'run', 'spider.machine': 'other.invalid' }),
    consoleTerminal('main-console'), consoleTerminal('child-console', { 'spider.run': 'run' })];
  const r = rows(ts);
  expect(r.find(row => row.key === 'main-job')).toMatchObject({ parentKey: 'console:remote.invalid/main-console', depth: 1, machine: 'remote.invalid' });
  expect(r.find(row => row.key === 'child-job')).toMatchObject({ parentKey: 'console:remote.invalid/child-console', depth: 2 });
  expect(r.find(row => row.key === 'other-machine')).toMatchObject({ parentKey: 'run', depth: 1 });
  expect(r.find(row => row.key === 'console:remote.invalid/child-console')).toMatchObject({ kind: 'console', parentKey: 'run', depth: 1, name: 'Builder · remote.invalid',
    action: { kind: 'ipc', request: { op: 'openJob', jobId: 'console:remote.invalid/child-console' } } });
  const visible = selectAgentChildren(r, []);
  expect(visible.some(row => row.key === 'main-job' || row.key === 'child-job')).toBe(false);
  expect(selectAgentChildren(r, ['console:remote.invalid/child-console']).some(row => row.key === 'child-job')).toBe(true);
});

test('finished jobs disappear from the sidebar while their machine console keeps history', () => {
  const done = { ...job('done'), state: 'finished' as const, finishedAt: 1500, exitCode: 23, reason: 'exited' };
  expect(rows([done, consoleTerminal('console')]).map(row => row.key)).toEqual(['console:remote.invalid/console', 'run']);
});

test('expanding one console keeps other agents and consoles visible', () => {
  const r = rows([job('child-job', { 'spider.run': 'run' }), job('main-job'), consoleTerminal('child-console', { 'spider.run': 'run' }), consoleTerminal('main-console')]);
  const visible = selectAgentChildren(r, ['console:remote.invalid/child-console']).map(row => row.key);
  expect(visible).toContain('run');
  expect(visible).toContain('console:remote.invalid/child-console');
  expect(visible).toContain('child-job');
  expect(visible).toContain('console:remote.invalid/main-console');
  expect(visible).not.toContain('main-job');
});

test('expanding both consoles reveals both jobs and preserves their ancestors', () => {
  const r = rows([job('child-job', { 'spider.run': 'run' }), job('main-job'), consoleTerminal('child-console', { 'spider.run': 'run' }), consoleTerminal('main-console')]);
  const visible = selectAgentChildren(r, ['console:remote.invalid/child-console', 'console:remote.invalid/main-console']);
  expect(visible).toEqual(r);
  expect(visible.map(row => row.key)).toEqual(expect.arrayContaining(['run', 'child-job', 'main-job', 'console:remote.invalid/child-console', 'console:remote.invalid/main-console']));
});

async function realLabelScenario(mode: 'fake' | 'hc') {
  const h = await createHerdrHarness(mode);
  try {
    await h.start(); const o = h.owner!;
    const handle = await h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(() => {}, 1000)'], cwd: h.root, on: 'remote.invalid' as never,
      labels: { 'spider.kind': 'exec', 'spider.job': 'launched-job', 'spider.session': o.sessionId, 'spider.owner-core': o.terminal.coreId, 'spider.owner-terminal': o.terminal.terminalId, 'spider.run': 'run', 'spider.machine': 'remote.invalid' }, background: true, outliveParent: true, noNotify: true });
    const snapshot = await h.hc.get(handle.address);
    const r = projectAgentChildren([snapshot], [feed(o)], o.terminal.address, contract, { now: 2000 });
    expect(r.map(row => [row.key, row.depth])).toEqual([['run', 0], ['launched-job', 1]]);
    expect(r[1].action).toMatchObject({ kind: 'ipc', request: { op: 'openJob', jobId: 'launched-job' } });
  } finally { await h.close(); }
  expect(await h.remainingOwnedResources()).toEqual([]);
}
test('fake hc launch labels produce a visible job under its run', () => realLabelScenario('fake'), 30000);
test.skipIf(process.env.SPIDER_HERDR_E2E !== '1')('real isolated hc launch labels produce a visible job; requires SPIDER_HERDR_E2E=1', () => realLabelScenario('hc'), 30000);
