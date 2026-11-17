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

test('a nested subagent viewer remains beneath its parent run', () => {
  const f = feed();
  f.runs.rows.push({ ...f.runs.rows[0], id: 'nested' as RunId, name: 'Nested' });
  const parent = { ...terminal('parent-viewer', 'subagent-viewer', { 'spider.run': 'run' }), parent: 'agent' };
  const child = { ...terminal('child-viewer', 'subagent-viewer', { 'spider.run': 'nested' }), parent: 'parent-viewer' };
  const result = projectAgentChildren([parent, child], [f], 'agent', contract, { now: 2000 });
  expect(result.map(row => [row.key, row.parentKey, row.depth])).toEqual([
    ['run', null, 0], ['nested', 'run', 1],
  ]);
});

test('resumed subagents nest correctly when the child viewer is listed first', () => {
  const f = feed();
  f.runs.rows.push({ ...f.runs.rows[0], id: 'nested' as RunId, name: 'Nested' });
  const parent = { ...terminal('parent-viewer', 'subagent-viewer', { 'spider.run': 'run' }), parent: 'old-owner' };
  const child = { ...terminal('child-viewer', 'subagent-viewer', { 'spider.run': 'nested' }), parent: 'parent-viewer' };
  for (const terminals of [[child, parent], [parent, child]]) {
    const result = projectAgentChildren(terminals, [f], 'agent', contract, { now: 2000 });
    expect(result.map(row => [row.key, row.parentKey, row.depth])).toEqual([
      ['run', null, 0], ['nested', 'run', 1],
    ]);
  }
});

test('a retained parent of a live nested subagent stays in the compact tree', () => {
  const f = feed();
  f.runs.rows[0].status = 'done'; f.runs.rows[0].finishedAt = 1500;
  f.runs.rows.push({ ...f.runs.rows[0], id: 'nested' as RunId, name: 'Nested', status: 'running', finishedAt: null });
  const parent = { ...terminal('parent-viewer', 'subagent-viewer', { 'spider.run': 'run' }), parent: 'agent', state: 'finished' as const, finishedAt: 1500, exitCode: 0, reason: 'exited' };
  const child = { ...terminal('child-viewer', 'subagent-viewer', { 'spider.run': 'nested' }), parent: 'parent-viewer' };
  const summary: { hiddenFinished?: number } = {};
  const result = projectAgentChildren([parent, child], [f], 'agent', contract, { now: 2000, finishedSummary: summary });
  expect(result.map(row => [row.key, row.parentKey, row.depth])).toEqual([
    ['run', null, 0], ['nested', 'run', 1],
  ]);
  expect(summary.hiddenFinished).toBe(0);
});

test('the compact tree retains every finished ancestor of a live nested subagent', () => {
  const f = feed(), template = f.runs.rows[0];
  template.status = 'done'; template.finishedAt = 1500;
  f.runs.rows.push({ ...template, id: 'middle' as RunId, name: 'Middle' },
    { ...template, id: 'nested' as RunId, name: 'Nested', status: 'running', finishedAt: null });
  const viewer = (address: string, run: string, parent: string, finished: boolean): AgentTerminal => ({
    ...terminal(address, 'subagent-viewer', { 'spider.run': run }), parent,
    ...(finished ? { state: 'finished' as const, finishedAt: 1500, exitCode: 0, reason: 'exited' } : {}),
  });
  const summary: { hiddenFinished?: number } = {};
  const result = projectAgentChildren([viewer('first-viewer', 'run', 'agent', true),
    viewer('middle-viewer', 'middle', 'first-viewer', true), viewer('last-viewer', 'nested', 'middle-viewer', false)],
  [f], 'agent', contract, { now: 2000, finishedSummary: summary });
  expect(result.map(row => [row.key, row.parentKey, row.depth])).toEqual([
    ['run', null, 0], ['middle', 'run', 1], ['nested', 'middle', 2],
  ]);
  expect(summary.hiddenFinished).toBe(0);
});

test('a subagent without parentage evidence stays at the owner root', () => {
  const f = feed();
  f.runs.rows.push({ ...f.runs.rows[0], id: 'nested' as RunId, name: 'Nested' });
  const result = projectAgentChildren([], [f], 'agent', contract, { now: 2000 });
  expect(result.map(row => [row.key, row.parentKey, row.depth])).toEqual([
    ['run', null, 0], ['nested', null, 0],
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
  expect(r.find(row => row.key === 'console:remote.invalid/child-console')).toMatchObject({ kind: 'console', parentKey: 'run', depth: 1, name: 'remote.invalid',
    action: { kind: 'ipc', request: { op: 'openJob', jobId: 'console:remote.invalid/child-console' } } });
  const visible = selectAgentChildren(r, []);
  expect(visible.some(row => row.key === 'main-job' || row.key === 'child-job')).toBe(false);
  expect(selectAgentChildren(r, ['console:remote.invalid/child-console']).some(row => row.key === 'child-job')).toBe(true);
});

const idle = (t: AgentTerminal): AgentTerminal => ({ ...t, status: null });

test('a machine console shows working while one of its commands runs, and idle otherwise', () => {
  const busy = rows([idle(job('main-job')), idle(consoleTerminal('main-console')), idle(consoleTerminal('other-console', { 'spider.run': 'run' }))]);
  expect(busy.find(row => row.key === 'console:remote.invalid/main-console')).toMatchObject({ status: 'working' });
  expect(busy.find(row => row.key === 'console:remote.invalid/other-console')).toMatchObject({ status: 'idle' });
  expect(rows([idle(consoleTerminal('main-console'))])[0]).toMatchObject({ key: 'console:remote.invalid/main-console', status: 'idle' });
  const finished = { ...idle(job('main-job')), state: 'finished' as const, exitCode: 0, reason: 'exited' };
  expect(rows([finished, idle(consoleTerminal('main-console'))]).find(row => row.kind === 'console')).toMatchObject({ status: 'idle' });
});

test('a disconnected session keeps its machine console disconnected even while a command runs', () => {
  const stale = projectAgentChildren([idle(job('main-job')), idle(consoleTerminal('main-console'))], [feed()], 'agent', contract, { now: 2000 + 60 * 60 * 1000 });
  expect(stale.find(row => row.kind === 'console')).toMatchObject({ status: 'disconnected' });
});

test('a console without a machine label remains a console and is not a top-level agent', () => {
  const local = terminal('local-console', 'remote-console');
  local.parent = 'agent';
  const result = rows([local]);
  expect(result.find(row => row.key === 'console:local-console')).toMatchObject({ kind: 'console', machine: null });
  expect(filterTopLevelAgents([{ address: 'agent' }, { address: 'local-console' }], [local], contract)).toEqual([{ address: 'agent' }]);
});

test('console names identify machines even when agent names are long', () => {
  const f = feed(); f.runs.rows[0].name = 'A very long worker name that would hide the machine';
  const terminals = [consoleTerminal('a', { 'spider.run': 'run' }), consoleTerminal('b', { 'spider.run': 'run', 'spider.machine': 'box-2.invalid' }), consoleTerminal('c', { 'spider.run': 'run', 'spider.machine': 'box-3.invalid' })];
  const consoles = projectAgentChildren(terminals, [f], 'agent', contract, { now: 2000 }).filter(row => row.kind === 'console');
  expect(consoles.map(row => row.name)).toEqual(['remote.invalid', 'box-2.invalid', 'box-3.invalid']);
  expect(consoles.map(row => row.description)).toEqual([
    'A very long worker name that would hide the machine console on remote.invalid',
    'A very long worker name that would hide the machine console on box-2.invalid',
    'A very long worker name that would hide the machine console on box-3.invalid',
  ]);
});

test('unavailable terminal machines disable console, command, and viewer actions until ready', () => {
  const viewer = terminal('remote.invalid/viewer', 'subagent-viewer', { 'spider.run': 'run' });
  const terminals = [consoleTerminal('main-console'), job('main-job'), viewer];
  const project = (layout: 'unavailable' | 'loading' | 'ready') => projectAgentChildren(terminals, [feed()], 'agent', contract, { now: 2000, machines: [{ name: 'remote.invalid', layout }] });
  const offline = project('unavailable');
  for (const key of ['console:remote.invalid/main-console', 'main-job', 'run']) {
    expect(offline.find(row => row.key === key)).toMatchObject({ status: 'unreachable', action: null });
  }
  const stale = projectAgentChildren(terminals, [feed()], 'agent', contract, { now: 12 * 60 * 60 * 1000, machines: [{ name: 'remote.invalid', layout: 'unavailable' }] });
  expect(stale.find(row => row.kind === 'console')).toMatchObject({ status: 'unreachable', action: null });
  for (const layout of ['loading', 'ready'] as const) {
    const online = project(layout);
    expect(online.find(row => row.kind === 'console')).toMatchObject({ status: 'working', action: { kind: 'ipc' } });
    expect(online.find(row => row.kind === 'remote')).toMatchObject({ status: 'working', action: { kind: 'ipc' } });
    expect(online.find(row => row.kind === 'subagent')).toMatchObject({ status: 'working', action: { kind: 'ipc' } });
  }
});

test.each([['done', 'done'], ['failed', 'error'], ['cancelled', 'cancelled']] as const)('an unavailable viewer keeps the local saved view of a %s run', (runStatus, status) => {
  const f = feed(); Object.assign(f.runs.rows[0], { status: runStatus, finishedAt: 1500, viewer: 'remote.invalid/viewer' });
  const viewer = terminal('remote.invalid/viewer', 'subagent-viewer', { 'spider.run': 'run' });
  const project = (terminals: AgentTerminal[]) => projectAgentChildren(terminals, [f], 'agent', contract, { now: 2000, machines: [{ name: 'remote.invalid', layout: 'unavailable' }] }).find(row => row.key === 'run');
  for (const terminals of [[viewer], []]) expect(project(terminals)).toMatchObject({ status, outcome: runStatus, retained: true, action: { kind: 'ipc', request: { op: 'openRun', runId: 'run' } } });
});

test('a finished run without a local endpoint cannot open an unavailable surviving viewer', () => {
  const f = feed(); Object.assign(f.runs.rows[0], { status: 'done', finishedAt: 1500, viewer: 'remote.invalid/viewer' });
  f.lifecycle = 'closed'; f.ipc = null;
  const viewer = terminal('remote.invalid/viewer', 'subagent-viewer', { 'spider.run': 'run' });
  const row = projectAgentChildren([viewer], [f], 'agent', contract, { now: 2000, machines: [{ name: 'remote.invalid', layout: 'unavailable' }] }).find(row => row.key === 'run');
  expect(row).toMatchObject({ status: 'unreachable', action: null });
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
