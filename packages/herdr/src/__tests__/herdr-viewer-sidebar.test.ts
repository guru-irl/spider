// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { projectAgentChildren } from '../../assets/agents/children.js';
import { HerdrLabelContract, type SessionFeed, type RunSummary, type Owner } from '../contracts.js';
import type { AgentTerminal } from '../../assets/agents/children.js';

const owner = { sessionId: 'session', generation: 'activation', terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: 'Agent' } as Owner;
const run: RunSummary = { id: '10000000-0000-4000-8000-000000000001' as never, ownerSessionId: owner.sessionId, name: 'Worker', status: 'running', childMode: 'rpc', canSteer: true, startedAt: 1, finishedAt: null, result: null, viewer: null };
const viewer: AgentTerminal = { address: 'viewer', parent: 'owner', state: 'live', status: null, labels: { 'spider.session': 'session', 'spider.owner-core': 'core', 'spider.owner-terminal': 'owner', 'spider.run': run.id, 'spider.kind': 'subagent-viewer' } };
function feed(): SessionFeed { return { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: 1000, owner,
  lifecycle: 'live', placement: null, status: { native: 'working', effective: 'working', message: null }, runs: { rows: [run], total: 1, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
  pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' }, approvals: [], notifications: [], errors: [], ipc: { address: '/fixture/ipc.sock', capabilityFile: '/fixture/capability' } }; }

it.each(['closed', 'stale', 'replaced'] as const)('%s owner rows open their surviving viewer instead of a dead endpoint', condition => {
  // Returning null or IPC for a closed/stale/replaced owner makes its row inert.
  const current = feed();
  if (condition === 'closed') { current.lifecycle = 'closed'; current.ipc = null; }
  if (condition === 'replaced') current.runs = { rows: [], total: 0, truncated: false };
  const rows = projectAgentChildren([viewer], [current], 'owner', HerdrLabelContract, { now: condition === 'stale' ? 32000 : 1000 });
  expect(rows).toHaveLength(1);
  expect(rows[0].key).toBe(run.id);
  expect(rows[0].action).toEqual({ kind: 'peek', terminal: 'viewer' });
});
it('keeps generation-bound IPC for a live owned run', () => {
  const rows = projectAgentChildren([viewer], [feed()], 'owner', HerdrLabelContract, { now: 1000 });
  expect(rows[0].action).toMatchObject({ kind: 'ipc', request: { op: 'openRun', runId: run.id, generation: 'activation' } });
});
