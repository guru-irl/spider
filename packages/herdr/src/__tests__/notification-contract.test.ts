// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { parseFeed } from '../../assets/shared/feed.js';

const feed = {
  version: 1, sessionId: 'session', generation: 'generation', revision: 1, updatedAt: 100,
  owner: { sessionId: 'session', generation: 'generation', terminal: { coreId: 'core', terminalId: 'terminal', address: 'terminal', socket: '/isolated.sock', sessionNamespace: 'test' }, cwd: '/work', sessionFile: null, name: null },
  placement: null, lifecycle: 'live', status: { native: null, effective: null, message: null },
  runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false },
  triggers: [], approvals: [], ipc: null, errors: [],
  pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'No data' },
};
const session = {
  id: 'result:run', kind: 'subagent-result', createdAt: 100, scope: 'session', sessionId: 'session',
  ownerAddress: 'terminal', title: 'Result', body: 'Finished',
  action: { kind: 'focus-owner', sessionId: 'session', address: 'terminal' },
};
const shared = {
  id: 'budget:100:80', kind: 'budget', createdAt: 100, scope: 'shared', sessionId: null,
  ownerAddress: null, title: 'Budget', body: 'Threshold reached',
  action: { kind: 'open-usage', scope: 'shared' },
};
const decode = (notifications: unknown[]) => parseFeed(JSON.stringify({ ...feed, notifications }));

test('decodes a shared budget notice without inventing session ownership', () => {
  expect(decode([shared])?.notifications).toEqual([shared]);
});

test.each(['subagent-result', 'escalation', 'job-result'])('decodes a %s notice with its exact owner action', kind => {
  expect(decode([{ ...session, kind }])?.notifications).toEqual([{ ...session, kind }]);
});

test.each([
  { ...shared, sessionId: 'session' },
  { ...shared, ownerAddress: 'terminal' },
  { ...shared, kind: 'job-result' },
  { ...shared, action: session.action },
  { ...shared, action: { kind: 'open-usage', scope: 'session' } },
  { ...session, scope: 'shared' },
  { ...session, kind: 'budget' },
  { ...session, sessionId: null },
  { ...session, ownerAddress: null },
  { ...session, action: shared.action },
  { ...session, action: { ...session.action, sessionId: 'other' } },
  { ...session, action: { ...session.action, address: 'other' } },
  { ...session, action: undefined },
  { ...session, scope: undefined },
])('rejects mixed notification fields %#', notification => {
  expect(decode([notification])).toBeNull();
});
