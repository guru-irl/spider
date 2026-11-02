// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, test } from 'vitest';
import type { SessionFeed, CoreId, TerminalId, TerminalAddress, SpaceId, RunSummary } from '../contracts.js';
import { projectFailedCommands, projectMachineProblems, projectNotifications, projectPace, projectSessionFacts, projectSpacePanel, notificationText } from '../../assets/mods/spider/data.js';

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
function feed(id: string, patch: Partial<SessionFeed> = {}): SessionFeed {
  return {
    version: 1, sessionId: id as SessionFeed['sessionId'], generation: 'g' as SessionFeed['generation'], revision: 1, updatedAt: NOW - 1000,
    owner: { sessionId: id as SessionFeed['sessionId'], generation: 'g' as SessionFeed['generation'],
      terminal: { coreId: 'core' as CoreId, terminalId: id as TerminalId, address: id as TerminalAddress, socket: '/fixture/socket', sessionNamespace: 'fixture' },
      cwd: '/fixture', sessionFile: null, name: id },
    placement: { spaceId: 'space-3' as SpaceId, spaceName: 'three', spaceOrder: 0, tabId: null },
    lifecycle: 'live', status: { native: 'idle', effective: 'idle', message: null },
    runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'No counters' },
    approvals: [], notifications: [], ipc: { address: '/fixture/ipc', capabilityFile: '/fixture/capability' }, errors: [], ...patch,
  };
}
const job = (patch: Record<string, unknown> = {}) => ({ id: 'job-result:job-1', kind: 'job-result', scope: 'session', sessionId: 'planner', ownerAddress: 'planner', createdAt: NOW - 120000,
  title: 'Job job-1', body: 'Exit 1', action: { kind: 'focus-owner', sessionId: 'planner', address: 'planner' },
  job: { id: 'job-1', runId: null, commandPreview: 'make-test-build', machine: 'build.invalid', address: 'build.invalid/t9', exitCode: 1, signal: null, finishedAt: NOW - 120000, ...patch },
}) as SessionFeed['notifications'][number];

describe('failed commands', () => {
  test('the owning agent pill, the command, and a machine pill, without the exit code', () => {
    const [item] = projectFailedCommands([feed('planner', { notifications: [job({ commandPreview: 'make test build' })] })], NOW);
    expect(item).toMatchObject({ kind: 'failed', key: 'job:job-1', sessionId: 'planner', action: 'Output' });
    expect(item!.parts).toEqual([{ type: 'agent', icon: 'session', text: 'planner' }, { type: 'command', text: 'make test build' }, { type: 'text', text: 'failed' },
      { type: 'text', text: 'on' }, { type: 'machine', text: 'build.invalid' }]);
  });
  test('uses the command preview carried by the feed without terminal labels', () => {
    expect(projectFailedCommands([feed('planner', { notifications: [job()] })], NOW)[0]!.parts[1]).toEqual({ type: 'command', text: 'make-test-build' });
  });
  test('a subagent\'s command names the subagent; success, old failures and other spaces\' sessions are left out', () => {
    const owner = feed('planner', { runs: { rows: [{ id: 'run-7', ownerSessionId: 'planner', name: 'worker-3', status: 'running', childMode: 'rpc', canSteer: true, startedAt: NOW, finishedAt: null, viewer: null, result: null } as RunSummary], total: 1, truncated: false } });
    expect(projectFailedCommands([{ ...owner, notifications: [job({ runId: 'run-7' })] }], NOW)[0]!.parts[0]).toEqual({ type: 'agent', icon: 'subagent', text: 'worker-3' });
    expect(projectFailedCommands([{ ...owner, notifications: [job({ exitCode: 0 }), job({ finishedAt: NOW - 25 * 3600000 }), job({ exitCode: null })] }], NOW)).toEqual([]);
    expect(projectFailedCommands([feed('elsewhere', { notifications: [job()] })], NOW)).toEqual([]);
    expect(projectFailedCommands([{ ...owner, notifications: [job({ exitCode: null, signal: 9 })] }], NOW)[0]!.parts.map(part => part.text)).toEqual(['planner', 'make-test-build', 'failed', 'on', 'build.invalid']);
  });
});

describe('machine problems', () => {
  test('disconnected and unreachable machines become items with a machine pill; connected and temporary ones do not', () => {
    const items = projectMachineProblems([{ name: 'build.invalid' }, { name: 'spare.invalid' }, { name: 'ok.invalid' }, { name: 'temp.invalid' }],
      [{ name: 'build.invalid', state: 'disconnected' }, { name: 'ok.invalid', state: 'connected' }, { name: 'temp.invalid', state: 'disconnected', temporary: true }]);
    expect(items.map(item => [item.key, item.parts])).toEqual([
      ['machine:build.invalid', [{ type: 'machine', text: 'build.invalid' }, { type: 'text', text: 'disconnected' }]],
      ['machine:spare.invalid', [{ type: 'machine', text: 'spare.invalid' }, { type: 'text', text: 'unreachable' }]],
    ]);
    expect(projectMachineProblems(null, [])).toEqual([]);
  });
  test('they sit in the notification list after failures and before memories', () => {
    const machines = projectMachineProblems([{ name: 'build.invalid' }], []);
    const items = projectNotifications([feed('a', { approvals: [{ uuid: 'u', scope: 'global', repoKey: null, ownerSessionId: null, category: 'insight', preview: 'p' }] })], projectPace([], NOW), NOW, { machines });
    expect(items.map(notificationText)).toEqual(['build.invalid unreachable', '1 memory to review']);
  });
});

describe('session cost this month', () => {
  test('rows carry the dashboard\'s label, and older feeds carry none', () => {
    expect(projectSessionFacts(feed('a', { monthCost: { credits: 1284.36, label: '1.3k' } }), NOW).cost).toBe('1.3k');
    expect(projectSessionFacts(feed('a'), NOW).cost).toBeNull();
    const panel = projectSpacePanel([feed('a', { monthCost: { credits: 0, label: '0' } })], { id: 'space-3', name: 'three' }, NOW);
    expect(panel.sessions.map(s => s.cost)).toEqual(['0']);
  });
});

describe('global pace bar', () => {
  const reading = { scope: 'shared' as const, used: 1284, budget: 5000, projected: 3950, remaining: 3716, periodStart: NOW - 14 * 86400000, periodEnd: NOW + 16 * 86400000, updatedAt: NOW - 4 * 60000, unavailableReason: null,
    labels: { month: 'NOV 2026', usedCompact: '1.3k', used: '1,284', projected: '3,950', budget: '5,000', remaining: '3,716', updatedAt: 'Sun 15 NOV 17:26' } };
  test('uses the feed\'s dashboard labels for the popover', () => {
    expect(projectPace([feed('a', { pace: reading })], NOW)).toMatchObject({ state: 'ok', over: false, labels: reading.labels, updated: '4m ago' });
  });
  test('a missing budget is unscaled, not a made-up bar', () => {
    expect(projectPace([feed('a', { pace: { ...reading, budget: null } })], NOW)).toMatchObject({ state: 'unscaled', used: 1284, labels: reading.labels });
  });
});
