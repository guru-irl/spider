// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, it } from 'vitest';
import { HerdrLabelContract, type Owner, type RunSummary, type SessionFeed, type SpaceId, type TabId } from '../contracts.js';
import type { AgentTerminal } from '../../assets/agents/children.js';
import { projectNavigation, sessionDisplayName, type NativeAgent, type NavigationSnapshot, type SpaceSnapshot } from '../../assets/shared/navigation.js';
import { pickerRows, selectPickerRow } from '../../assets/picker/model.js';

const now = 1_000_000;
const local: SpaceSnapshot = { id: 's1', index: 1, name: 'Work', machine: null, active: true, tabs: [
  { id: 'tb1', name: 'Coding', active: true, status: null },
] };
const remote: SpaceSnapshot = { id: 's2', index: 2, name: 'Remote', machine: 'box-1.invalid', active: false, tabs: [
  { id: 'tb2', name: 'Remote tab', active: true, status: null },
] };
function owner(id: string, address: string, name: string | null, core = 'core'): Owner {
  return { sessionId: id, generation: `gen-${id}`, terminal: { coreId: core, terminalId: address.split('/').at(-1), address, socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: `/fixture/${id}`, sessionFile: null, name } as Owner;
}
function feed(value: Owner, runs: RunSummary[] = []): SessionFeed {
  return { version: 1, sessionId: value.sessionId, generation: value.generation, revision: 1, updatedAt: now, owner: value,
    lifecycle: 'live', placement: { spaceId: 's1' as SpaceId, spaceName: 'Work', spaceOrder: 1, tabId: 'tb1' as TabId },
    status: { native: 'working', effective: 'working', message: null },
    runs: { rows: runs, total: runs.length, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' },
    approvals: [], notifications: [], errors: [], ipc: { address: '/fixture/ipc.sock', capabilityFile: '/fixture/capability' } } as SessionFeed;
}
function terminal(address: string, parent: string | null = null, labels: Record<string, string> = {}): AgentTerminal {
  return { address, parent, labels, state: 'live', status: 'working' };
}
function agent(address: string, pane: string, title: string, space = 's1', tab = 'tb1'): NativeAgent {
  return { address, pane, space, tab, title, space_name: space === 's1' ? 'Work' : 'Remote',
    program: { name: 'pi' }, status: 'working', pinned: false, focused: false };
}
function run(id: string, sessionId: string, name: string, status: RunSummary['status'] = 'running', finishedAt: number | null = null): RunSummary {
  return { id, ownerSessionId: sessionId, name, status, childMode: 'rpc', canSteer: true, startedAt: now - 100,
    finishedAt, viewer: null, result: null } as RunSummary;
}
function snapshot(values: Partial<NavigationSnapshot> = {}): NavigationSnapshot {
  return { coreId: 'core', destination: { space: 's1', tab: 'tb1' } as NavigationSnapshot['destination'],
    agents: [], terminals: [], panes: [], spaces: [local, remote], feeds: [], contract: HerdrLabelContract,
    machines: [{ name: null, layout: 'ready' }, { name: 'box-1.invalid', layout: 'ready', coreId: 'remote-core' }, { name: 'box-2.invalid', layout: 'ready', coreId: 'box-2-core' }],
    now, completedHours: 24, completedRows: 50, ...values };
}
function targetLabels(rows: ReturnType<typeof pickerRows>): string[] {
  return rows.filter(row => row.kind === 'target').map(row => row.label);
}

describe('Go to navigation projections', () => {
  it('uses distinct spider names for agents sharing a tab', () => {
    const inputs = snapshot({ agents: [agent('t1', 'p1', 'Pi · Pi · Pi'), agent('t2', 'p2', 'Pi · Pi · Pi')],
      terminals: [terminal('t1'), terminal('t2')], feeds: [feed(owner('writer', 't1', 'Writer')), feed(owner('reviewer', 't2', 'Reviewer'))] });
    const targets = projectNavigation(inputs);
    expect(targetLabels(pickerRows(inputs.spaces, targets, ''))).toEqual(['Writer', 'Reviewer']);
    expect(targets.map(target => target.id)).toEqual(['session:writer', 'session:reviewer']);
  });

  it('falls back from a verified feed to display label and native title', () => {
    const writer = agent('t1', 'p1', 'Native name');
    const labelled = terminal('t1', null, { 'spider.display-name': 'Display name' });
    expect(sessionDisplayName(writer, labelled, [feed(owner('writer', 't1', 'Feed name'))])).toBe('Feed name');
    expect(sessionDisplayName(writer, labelled, [])).toBe('Display name');
    expect(sessionDisplayName(writer, terminal('t1'), [])).toBe('Native name');
  });

  it('does not reopen an unplaced child directly when the owner cannot place a viewer', () => {
    const work = feed(owner('writer', 't1', 'Writer'), [run('run-1', 'writer', 'Child')]); work.ipc = null;
    const viewer = terminal('view1', 't1', { 'spider.kind': 'subagent-viewer', 'spider.session': 'writer', 'spider.run': 'run-1' });
    const inputs = snapshot({ terminals: [terminal('t1'), viewer], feeds: [work] });
    expect(projectNavigation(inputs).find(target => target.id === 'run:writer:run-1')).toMatchObject({ action: null, disabledReason: 'Owning session unavailable' });
  });

  it('finds children under their owner even when the sidebar is folded', () => {
    const work = feed(owner('writer', 't1', 'Writer'), [run('run-1', 'writer', 'Check output')]);
    const viewer = terminal('view1', 't1', { 'spider.kind': 'subagent-viewer', 'spider.session': 'writer', 'spider.run': 'run-1' });
    const inputs = snapshot({ agents: [agent('t1', 'p1', 'Pi')], terminals: [terminal('t1'), viewer], feeds: [work] });
    const targets = projectNavigation(inputs);
    expect(targetLabels(pickerRows(inputs.spaces, targets, 'check OUTPUT'))).toEqual(['Writer', 'Check output']);
    expect(targets.find(target => target.id === 'run:writer:run-1')).toMatchObject({ ownerId: 'session:writer', action: { kind: 'ipc', request: { op: 'openRun', runId: 'run-1', generation: 'gen-writer' } } });
  });

  it('keeps a native child under its owner without duplicating it', () => {
    const child = { ...terminal('child', 't1'), name: 'Native child' };
    const inputs = snapshot({ agents: [agent('child', 'pc', 'Native child'), agent('t1', 'p1', 'Pi')],
      terminals: [terminal('t1'), child], panes: [{ pane: 'pc', terminal: 'child', tab: 'tb1', cwd: null }],
      feeds: [feed(owner('writer', 't1', 'Writer'))] });
    const targets = projectNavigation(inputs);
    expect(targets.filter(target => target.id === 'agent:child')).toHaveLength(1);
    expect(targets.find(target => target.id === 'agent:child')).toMatchObject({ ownerId: 'session:writer', name: 'Native child', action: { kind: 'focus', pane: 'pc' } });
    expect(targetLabels(pickerRows(inputs.spaces, targets, 'Native child'))).toEqual(['Writer', 'Native child']);
  });

  it('shows local spaces and refuses native remote agent focus', () => {
    const inputs = snapshot({ agents: [agent('box-1.invalid/t2', 'box-1.invalid/p2', 'Remote agent', 's2', 'tb2')],
      terminals: [terminal('box-1.invalid/t2')], panes: [{ pane: 'box-1.invalid/p2', terminal: 'box-1.invalid/t2', tab: 'tb2', cwd: null }] });
    const targets = projectNavigation(inputs);
    const rows = pickerRows(inputs.spaces, targets, '');
    expect(rows.filter(row => row.kind === 'space').map(row => row.label)).toEqual(['Work']);
    expect(targets.find(target => target.name === 'Remote agent')?.action).toBeNull();
    expect(targets.find(target => target.name === 'Remote agent')?.machine).toBe('box-1.invalid');
  });

  it.each([true, false])('keeps an unclaimed roaming proxy with a pane selectable (native agent: %s)', withAgent => {
    const proxy = terminal('proxy', null, { 'spider.kind': 'roam-proxy', 'spider.session': 'roamer',
      'spider.owner-core': 'remote-core', 'spider.owner-terminal': 'box-1.invalid/t2', 'spider.display-name': 'Roamer' });
    const inputs = snapshot({ agents: withAgent ? [agent('proxy', 'p3', 'Proxy')] : [], terminals: [proxy],
      panes: [{ pane: 'p3', terminal: 'proxy', tab: 'tb1', cwd: null }] });
    expect(projectNavigation(inputs)).toMatchObject([{ id: 'agent:proxy', name: 'Roamer', machine: 'box-1.invalid', action: { kind: 'focus', pane: 'p3' } }]);
  });

  it('focuses a locally visible proxy even if its owner machine is unavailable', () => {
    const proxy = terminal('proxy', null, { 'spider.kind': 'roam-proxy', 'spider.session': 'roamer',
      'spider.owner-core': 'remote-core', 'spider.owner-terminal': 'box-1.invalid/t2' });
    const inputs = snapshot({ terminals: [terminal('box-1.invalid/t2'), proxy], feeds: [feed(owner('roamer', 'box-1.invalid/t2', 'Roamer', 'remote-core'))],
      machines: [{ name: 'box-1.invalid', layout: 'unavailable', coreId: 'remote-core' }],
      panes: [{ pane: 'p3', terminal: 'proxy', tab: 'tb1', cwd: null }] });
    expect(projectNavigation(inputs)[0]).toMatchObject({ action: { kind: 'focus', pane: 'p3' } });
  });

  it('explains why a parked session without an endpoint cannot be reopened', () => {
    const value = feed(owner('writer', 't1', 'Writer')); value.ipc = null;
    const inputs = snapshot({ terminals: [terminal('t1')], feeds: [value] });
    expect(projectNavigation(inputs)[0]).toMatchObject({ action: null, disabledReason: 'Owning session unavailable' });
  });

  it('deduplicates roaming proxies by session and focuses the local pane', () => {
    const remoteOwner = owner('roamer', 'box-1.invalid/t2', 'Roamer', 'remote-core');
    const proxy = terminal('proxy', null, { 'spider.kind': 'roam-proxy', 'spider.session': 'roamer',
      'spider.owner-core': 'remote-core', 'spider.owner-terminal': 'box-1.invalid/t2' });
    const inputs = snapshot({ agents: [agent('box-1.invalid/t2', 'box-1.invalid/p2', 'Pi', 's2', 'tb2'), agent('proxy', 'p3', 'Proxy')],
      terminals: [terminal('box-1.invalid/t2'), proxy], feeds: [feed(remoteOwner)] });
    const targets = projectNavigation(inputs).filter(target => target.kind === 'agent');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ id: 'session:roamer', name: 'Roamer', machine: 'box-1.invalid', terminal: 'box-1.invalid/t2', action: { kind: 'focus', pane: 'p3' } });
  });

  it('focuses a feed-backed proxy pane when the native agent list omits the proxy', () => {
    const remoteOwner = owner('roamer', 'box-1.invalid/t2', 'Roamer', 'remote-core');
    const proxy = terminal('proxy', null, { 'spider.kind': 'roam-proxy', 'spider.session': 'roamer',
      'spider.owner-core': 'remote-core', 'spider.owner-terminal': 'box-1.invalid/t2' });
    const inputs = snapshot({ terminals: [terminal('box-1.invalid/t2'), proxy], feeds: [feed(remoteOwner)],
      panes: [{ pane: 'p3', terminal: 'proxy', tab: 'tb1', cwd: null }] });
    expect(projectNavigation(inputs).filter(target => target.kind === 'agent')).toMatchObject([
      { id: 'session:roamer', action: { kind: 'focus', pane: 'p3' } },
    ]);
  });

  it('qualifies a bare remote owner through the matching core before resolving its proxy', () => {
    const remoteOwner = owner('roamer', 't2', 'Roamer', 'remote-core');
    const proxy = terminal('proxy', null, { 'spider.kind': 'roam-proxy', 'spider.session': 'roamer',
      'spider.owner-core': 'remote-core', 'spider.owner-terminal': 'box-1.invalid/t2' });
    const inputs = snapshot({ agents: [agent('box-1.invalid/t2', 'box-1.invalid/p2', 'Pi', 's2', 'tb2'), agent('proxy', 'p3', 'Proxy')],
      terminals: [terminal('box-1.invalid/t2'), proxy], feeds: [feed(remoteOwner)] });
    const targets = projectNavigation(inputs);
    expect(targets.filter(target => target.kind === 'agent')).toHaveLength(1);
    expect(targets[0]).toMatchObject({ id: 'session:roamer', terminal: 'box-1.invalid/t2', machine: 'box-1.invalid', action: { kind: 'focus', pane: 'p3' } });
  });

  it('projects one parked primary without inventing a native agent', () => {
    const inputs = snapshot({ terminals: [terminal('t1')], feeds: [feed(owner('writer', 't1', 'Writer'))] });
    const targets = projectNavigation(inputs);
    expect(targets.filter(target => target.id === 'session:writer')).toHaveLength(1);
    expect(targets[0]).toMatchObject({ name: 'Writer', pane: null, terminal: 't1', action: {
      kind: 'ipc', descriptor: { sessionId: 'writer', generation: 'gen-writer' },
      request: { op: 'openSession', generation: 'gen-writer', destination: { space: 's1', tab: 'tb1' } },
    } });
    expect(targetLabels(pickerRows(inputs.spaces, targets, 'Writer'))).toEqual(['Writer']);
  });

  it('uses qualified remote parents and bare local parents without guessing unmapped parents', () => {
    const remoteFeed = feed(owner('remote', 'box-1.invalid/t1', 'Remote', 'remote-core'), [run('r1', 'remote', 'Remote child')]);
    const localFeed = feed(owner('local', 't1', 'Local'), [run('r2', 'local', 'Local child')]);
    const remoteChild = terminal('box-1.invalid/v1', 'box-1.invalid/t1', { 'spider.kind': 'subagent-viewer', 'spider.session': 'remote', 'spider.run': 'r1' });
    const localChild = terminal('v2', 't1', { 'spider.kind': 'subagent-viewer', 'spider.session': 'local', 'spider.run': 'r2' });
    const unknownChild = terminal('box-2.invalid/v3', 'unmapped', { 'spider.kind': 'subagent-viewer', 'spider.run': 'unknown' });
    const inputs = snapshot({ agents: [agent('box-1.invalid/t1', 'box-1.invalid/p1', 'Pi', 's2', 'tb2'), agent('t1', 'p1', 'Pi')],
      terminals: [terminal('box-1.invalid/t1'), terminal('t1'), remoteChild, localChild, unknownChild], feeds: [remoteFeed, localFeed] });
    const targets = projectNavigation(inputs);
    expect(targets.find(target => target.id === 'run:remote:r1')).toMatchObject({ name: 'Remote child', ownerId: 'session:remote' });
    expect(targets.find(target => target.id === 'run:local:r2')).toMatchObject({ name: 'Local child', ownerId: 'session:local' });
    expect(targets.some(target => target.name === 'unknown')).toBe(false);
  });

  it('names a console after its immediate owner and keeps its machine', () => {
    const work = feed(owner('writer', 't1', 'Writer'), [run('run-1', 'writer', 'Check output')]);
    const viewer = terminal('view1', 't1', { 'spider.kind': 'subagent-viewer', 'spider.session': 'writer', 'spider.run': 'run-1' });
    const console = terminal('box-1.invalid/c1', 'view1', { 'spider.kind': 'remote-console', 'spider.session': 'writer', 'spider.run': 'run-1', 'spider.machine': 'box-1.invalid' });
    const job = terminal('box-1.invalid/j1', 't1', { 'spider.kind': 'exec', 'spider.session': 'writer', 'spider.job': 'job-1', 'spider.machine': 'box-1.invalid' });
    const inputs = snapshot({ agents: [agent('t1', 'p1', 'Pi')], terminals: [terminal('t1'), viewer, console, job], feeds: [work] });
    const targets = projectNavigation(inputs);
    expect(targets.find(target => target.kind === 'console')).toMatchObject({ name: 'Check output console', machine: 'box-1.invalid', ownerId: 'run:writer:run-1' });
    expect(targets.some(target => target.terminal === 'box-1.invalid/j1')).toBe(false);
    expect(targetLabels(pickerRows(inputs.spaces, targets, 'box-1.INVALID'))).toEqual(['Writer', 'Check output', 'Check output console']);
    expect(targetLabels(pickerRows(inputs.spaces, targets, 'output console'))).toEqual(['Writer', 'Check output', 'Check output console']);
  });

  it('limits retained runs by age and count', () => {
    const runs = [run('recent', 'writer', 'Recent', 'done', now - 100), run('older', 'writer', 'Older', 'done', now - 200),
      run('expired', 'writer', 'Expired', 'done', now - 25 * 60 * 60 * 1000), run('live', 'writer', 'Live')];
    const inputs = snapshot({ agents: [agent('t1', 'p1', 'Pi')], terminals: [terminal('t1')], feeds: [feed(owner('writer', 't1', 'Writer'), runs)], completedRows: 1 });
    expect(projectNavigation(inputs).filter(target => target.kind === 'subagent').map(target => target.name)).toEqual(['Live', 'Recent']);
  });

  it('opens a retained run through its live owner when its old viewer machine is unavailable', () => {
    const work = feed(owner('writer', 't1', 'Writer'), [run('run-1', 'writer', 'Finished', 'done', now - 100)]);
    const viewer = terminal('box-1.invalid/view', 't1', { 'spider.kind': 'subagent-viewer', 'spider.session': 'writer', 'spider.run': 'run-1' });
    const inputs = snapshot({ agents: [agent('t1', 'p1', 'Pi')], terminals: [terminal('t1'), viewer], feeds: [work],
      machines: [{ name: null, layout: 'ready' }, { name: 'box-1.invalid', layout: 'unavailable' }] });
    expect(projectNavigation(inputs).find(target => target.id === 'run:writer:run-1')).toMatchObject({
      retained: true, machine: 'box-1.invalid', action: { kind: 'ipc', request: { op: 'openRun', runId: 'run-1', generation: 'gen-writer' } },
    });
  });

  it.each([false, true])('disables a reachable child when its owner machine is down (pane: %s)', withPane => {
    const work = feed(owner('remote', 'box-1.invalid/t1', 'Remote owner', 'remote-core'), [run('run-1', 'remote', 'Child')]);
    const viewer = terminal('box-2.invalid/view', 'box-1.invalid/t1', { 'spider.kind': 'subagent-viewer', 'spider.session': 'remote', 'spider.run': 'run-1' });
    const inputs = snapshot({ terminals: [terminal('box-1.invalid/t1'), viewer], feeds: [work],
      panes: withPane ? [{ pane: 'box-2.invalid/pane', terminal: 'box-2.invalid/view', tab: 'tb2', cwd: null }] : [],
      machines: [{ name: 'box-1.invalid', layout: 'unavailable', coreId: 'remote-core' }, { name: 'box-2.invalid', layout: 'ready', coreId: 'box-2-core' }] });
    const targets = projectNavigation(inputs), child = targets.find(target => target.id === 'run:remote:run-1');
    expect(child).toMatchObject({ machine: 'box-2.invalid', action: null, disabledReason: 'Owner on box-1.invalid is unreachable' });
    expect(pickerRows(inputs.spaces, targets, '').find(row => row.id === child?.id)).toMatchObject({ enabled: false });
  });

  it('keeps duplicate names separate and searches paths case insensitively', () => {
    const a = owner('writer-1', 't1', 'Writer'); a.cwd = '/fixture/ALPHA';
    const b = owner('writer-2', 't2', 'Writer'); b.cwd = '/fixture/beta';
    const inputs = snapshot({ agents: [agent('t1', 'p1', 'Pi'), agent('t2', 'p2', 'Pi')], terminals: [terminal('t1'), terminal('t2')], feeds: [feed(a), feed(b)] });
    const targets = projectNavigation(inputs);
    expect(targets.map(target => target.id)).toEqual(['session:writer-1', 'session:writer-2']);
    expect(targetLabels(pickerRows(inputs.spaces, targets, '/fixture/alpha'))).toEqual(['Writer']);
  });

  it('does not trust an unqualified owner from another core or an unverified proxy', () => {
    const wrongCore = feed(owner('old', 't1', 'Old name', 'old-core'));
    const proxy = terminal('proxy', null, { 'spider.kind': 'roam-proxy', 'spider.session': 'old', 'spider.owner-core': 'other-core', 'spider.owner-terminal': 't1' });
    const inputs = snapshot({ agents: [agent('t1', 'p1', 'Native'), agent('proxy', 'p3', 'Proxy')], terminals: [terminal('t1'), proxy], feeds: [wrongCore] });
    const targets = projectNavigation(inputs);
    expect(targets.map(target => target.name)).toEqual(['Native', 'Proxy']);
    expect(targets[1]).toMatchObject({ id: 'agent:proxy', action: { kind: 'focus', pane: 'p3' } });
    expect(targets[0].id).toBe('agent:t1');
    expect(targets[0].action).toEqual({ kind: 'focus', pane: 'p1' });
  });

  it('uses remote feed actions only when the machine core matches', () => {
    const remoteFeed = feed(owner('remote', 'box-1.invalid/t1', 'Remote', 'remote-core'), [run('r1', 'remote', 'Child')]);
    const inputs = snapshot({ agents: [agent('box-1.invalid/t1', 'box-1.invalid/p1', 'Native', 's2', 'tb2')],
      terminals: [terminal('box-1.invalid/t1')], feeds: [remoteFeed] });
    const targets = projectNavigation(inputs);
    expect(targets.find(target => target.id === 'session:remote')).toMatchObject({ name: 'Remote', action: { kind: 'pane', request: { op: 'open-existing', sessionId: 'remote', generation: 'gen-remote' } } });
    expect(targets.find(target => target.id === 'run:remote:r1')).toMatchObject({ action: { kind: 'pane', request: { op: 'open-auxiliary', generation: 'gen-remote', view: { kind: 'subagent', runId: 'r1' } } } });
  });

  it.each([{ name: 'missing', coreId: undefined }, { name: 'replaced', coreId: 'new-core' }])(
    'refuses native remote focus and drops feed actions when the remote core is $name', ({ coreId }) => {
      const remoteFeed = feed(owner('remote', 'box-1.invalid/t1', 'Old name', 'remote-core'), [run('r1', 'remote', 'Child')]);
      const inputs = snapshot({ agents: [agent('box-1.invalid/t1', 'box-1.invalid/p1', 'Native', 's2', 'tb2')],
        terminals: [terminal('box-1.invalid/t1')], feeds: [remoteFeed],
        machines: [{ name: 'box-1.invalid', layout: 'ready', ...(coreId ? { coreId } : {}) }] });
      expect(projectNavigation(inputs)).toMatchObject([{ id: 'agent:box-1.invalid/t1', name: 'Native', action: null }]);
      expect(projectNavigation(inputs)).toHaveLength(1);
    });

  it('refuses native remote focus and disables feed capabilities without a local core identity', () => {
    const remoteFeed = feed(owner('remote', 'box-1.invalid/t1', 'Old name', 'remote-core'), [run('r1', 'remote', 'Child')]);
    const inputs = snapshot({ coreId: '', agents: [agent('box-1.invalid/t1', 'box-1.invalid/p1', 'Native', 's2', 'tb2')],
      terminals: [terminal('box-1.invalid/t1')], feeds: [remoteFeed] });
    expect(projectNavigation(inputs)).toMatchObject([{ id: 'agent:box-1.invalid/t1', name: 'Native', action: null }]);
    expect(projectNavigation(inputs)).toHaveLength(1);
  });

  it('does not expose stale or closed feed capabilities', () => {
    const stale = feed(owner('writer', 't1', 'Writer')); stale.updatedAt = now - 20_001;
    const closed = feed(owner('other', 't2', 'Other')); closed.lifecycle = 'closed';
    const inputs = snapshot({ agents: [agent('t1', 'p1', 'Native')], terminals: [terminal('t1'), terminal('t2')], feeds: [stale, closed] });
    const targets = projectNavigation(inputs);
    expect(targets.map(target => target.name)).toEqual(['Native']);
    expect(targets.some(target => target.action?.kind === 'ipc')).toBe(false);
  });

  it('separates machine unavailability from the native status', () => {
    const inputs = snapshot({ agents: [agent('box-1.invalid/t2', 'box-1.invalid/p2', 'Remote', 's2', 'tb2')],
      terminals: [terminal('box-1.invalid/t2')], machines: [{ name: 'box-1.invalid', layout: 'unavailable' }] });
    expect(projectNavigation(inputs)[0]).toMatchObject({ status: 'working', machine: 'box-1.invalid', action: null });
  });
});

describe('Go to row selection', () => {
  it('leaves selection null with no enabled matches', () => {
    expect(selectPickerRow([], 'missing', 1)).toBeNull();
    const rows = pickerRows([], [], 'not found');
    expect(selectPickerRow(rows, 'missing', 0)).toBeNull();
  });

  it('keeps a stable selection and wraps only through enabled rows', () => {
    const inputs = snapshot({ agents: [agent('t1', 'p1', 'One'), agent('t2', 'p2', 'Two')], terminals: [terminal('t1'), terminal('t2')] });
    const rows = pickerRows(inputs.spaces, projectNavigation(inputs), '');
    const enabled = rows.filter(row => row.enabled).map(row => row.id);
    expect(selectPickerRow(rows, enabled[1], 0)).toBe(enabled[1]);
    expect(selectPickerRow(rows, enabled.at(-1)!, 1)).toBe(enabled[0]);
    expect(selectPickerRow(rows, enabled[0], -1)).toBe(enabled.at(-1));
    expect(selectPickerRow(rows, 'removed', 0)).toBe(enabled[0]);
  });

  it('offers creation only on verified local spaces after remote focus', () => {
    const spaces = [{ ...local, active: false }, { ...remote, active: true }];
    const rows = pickerRows(spaces, [], '');
    expect(rows.find(row => row.kind === 'new-tab')).toMatchObject({ machine: '', space: 's1', enabled: true });
    expect(rows.find(row => row.kind === 'new-space')).toMatchObject({ machine: '', enabled: true });
    expect(pickerRows([remote], [], '').find(row => row.kind === 'new-tab')?.enabled).toBe(false);
  });
});
