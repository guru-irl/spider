// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { parseFeed } from '../../assets/shared/feed.js';

function wire() {
  return { version: 1, sessionId: 'session', generation: 'generation', revision: 1, updatedAt: 1000,
    owner: { sessionId: 'session', generation: 'generation', terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: 'Agent' },
    lifecycle: 'live', placement: null, status: { native: 'working', effective: 'working', message: null }, runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' }, approvals: [], ipc: null, errors: [],
    notifications: [{ id: 'job-result:job', kind: 'job-result', createdAt: 1000, scope: 'session', sessionId: 'session', ownerAddress: 'owner', title: 'Job', body: 'Exit uncertain. Native exit 0; receipt exit 23.', action: { kind: 'focus-owner', sessionId: 'session', address: 'owner' },
      job: { id: 'job', runId: null, commandPreview: 'exit 23', machine: 'remote.invalid', exitCode: null, signal: null, finishedAt: 1000, address: 'remote.invalid/t2', outcome: 'unknown', evidenceConflict: true,
        exitEvidence: { native: { exitCode: 0, signal: null, reason: 'exited', finishedAt: 1000 }, receipt: { exitCode: 23, signal: null, reason: 'exited', finishedAt: 999 } } } }],
  };
}
it.each(['flag', 'outcome', 'native', 'receipt', 'trusted-exit'] as const)('preserves valid conflict metadata but rejects malformed %s', field => {
  // Ignoring the optional fields would return a typed feed with malformed or falsely certain evidence.
  const valid = wire();
  expect(parseFeed(JSON.stringify(valid))?.notifications[0]).toMatchObject({ job: { outcome: 'unknown', evidenceConflict: true, exitEvidence: { native: { exitCode: 0 }, receipt: { exitCode: 23 } } } });
  const invalid = wire() as any;
  const job = invalid.notifications[0].job;
  if (field === 'flag') job.evidenceConflict = 'yes';
  if (field === 'outcome') job.outcome = 23;
  if (field === 'native') job.exitEvidence.native.exitCode = '0';
  if (field === 'receipt') job.exitEvidence.receipt.signal = 'none';
  if (field === 'trusted-exit') job.exitCode = 23;
  expect(parseFeed(JSON.stringify(invalid))).toBeNull();
});
