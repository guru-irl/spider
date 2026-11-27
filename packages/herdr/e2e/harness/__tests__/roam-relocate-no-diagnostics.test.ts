// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Suite } from '../suite.js';

const state = vi.hoisted(() => ({ source: '', file: '', session: '00000000-0000-4000-8000-000000000004' }));
vi.mock('@spider/db-core', () => ({ migrate: () => {}, openDb: () => ({
  close: () => {}, prepare: (sql: string) => ({ get: () => sql.includes('SELECT origin_machine')
    ? { origin_machine: '00000000-0000-4000-8000-000000000001' } : undefined }),
}) }));
vi.mock('@spider/db-core/roam/repo-map', () => ({ mapRepository: async () => {} }));
vi.mock('@spider/db-core/roam/seed', () => ({ enableMemoryCapture: () => {} }));
vi.mock('../wait.js', () => ({ deadline: () => 0, waitFor: async (_name: string, observe: () => unknown) => observe() }));
vi.mock('../processes.js', () => ({ spawnOwned: () => ({ child: { exitCode: null, signalCode: null }, stop: async () => {} }) }));
vi.mock('../resources.js', () => ({ identityOf: (pid: number) => ({ pid, start: '1' }) }));
vi.mock('../pi.js', () => ({ readObserved: async () => [
  { type: 'session_start', hcTerminal: 't1', cwd: state.source, sessionId: state.session, sessionFile: state.file, pid: 123 },
  { type: 'agent_settled', at: Date.now() + 10_000 },
  { type: 'message_end', at: Date.now() + 10_000, role: 'assistant', content: 'ordinary source reply' },
] }));
vi.mock('../../../src/sessions/id-lock.js', () => ({ inspectIdLock: async () => ({ identity: { pid: 123 }, pendingOperationId: null }) }));
vi.mock('../../../../roam/src/relocate/local-process.js', () => ({ localProcessTree: () => { throw new Error('process tree unavailable'); } }));

import { relocateFixture } from '../../fixtures/roam-relocate.js';

describe('relocation fixture without diagnostics', () => {
  it('still invokes relocate when source process-tree observation is unavailable', async () => {
    const root = mkdtempSync(join(process.cwd(), '.spider/scratch/relocate-nodiag-'));
    const agent = join(root, 'agent'), global = join(root, 'global');
    state.source = join(root, 'source'); state.file = join(agent, 'sessions', 'session.jsonl');
    const previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      for (const dir of [agent, global, state.source, join(agent, 'sessions')]) mkdirSync(dir, { recursive: true });
      for (const name of ['settings.json', 'models.json']) writeFileSync(join(agent, name), '{}');
      writeFileSync(join(global, 'config.json'), '{}');
      writeFileSync(state.file, 'ordinary source reply');
      const ledgerState = { terminals: [], processes: [] };
      const invoke = vi.fn(async (_command: string, args: readonly string[]) => ({ exitCode: 0, stderr: '', stdout:
        args.includes('relocate') ? JSON.stringify({ ok: true, value: { terminal: 't2', placement: {
          sessionId: state.session, file: join(root, 'ba', 'sessions', 'session.jsonl'), cwd: join(root, 'p', 'relocate-repository'),
        } } }) : '' }));
      const suite = {
        root, ledger: { update: (fn: (value: object) => void) => fn(ledgerState) }, env: {},
        directories: { SPIDER_GLOBAL_ROOT: global, PI_CODING_AGENT_DIR: agent, HERDR_APP_HOME: join(root, 'app') },
        cores: { local: { env: {}, namespace: 'hub', socket: 'hub.sock' }, dest: { env: {}, namespace: 'box', socket: 'box.sock' },
          machine: 'fixture.invalid', wrapper: 'hc', recordLog: 'hc.log', viaLog: 'via.log' },
        packed: { roamCli: 'cli.mjs', roamSupervisor: 'supervisor.mjs' },
        pi: { launcher: 'pi', observerDir: root }, project: async () => state.source, ownPath: (path: string) => path,
        invoke, hc: async (args: readonly string[]) => ({ exitCode: 0, stderr: '', stdout: '', json: args[0] === 'run' ? { address: 't1' } : null }),
        evidence: async () => {}, keepEvidence: async () => {},
      } as unknown as Suite;
      const fixture = await relocateFixture(suite);
      try {
        await expect(fixture.relocate(state.session, 'fixture.invalid')).resolves.toMatchObject({ terminal: 't2' });
        expect(invoke.mock.calls.some(([, args]) => args.includes('relocate'))).toBe(true);
      } finally { await fixture.close(); }
    } finally {
      Object.defineProperty(process, 'platform', previousPlatform);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
