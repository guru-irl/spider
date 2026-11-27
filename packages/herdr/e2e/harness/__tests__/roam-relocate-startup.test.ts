// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Suite } from '../suite.js';

const started = vi.hoisted(() => [] as { label: string; command: string; args: string[]; env: Record<string, string> }[]);
vi.mock('@spider/db-core', () => ({ migrate: () => {}, openDb: () => ({ close: () => {} }) }));
vi.mock('@spider/db-core/roam/repo-map', () => ({ mapRepository: async () => {} }));
vi.mock('@spider/db-core/roam/seed', () => ({ enableMemoryCapture: () => {} }));
vi.mock('../wait.js', () => ({ deadline: () => 0, waitFor: async () => true }));
vi.mock('../processes.js', () => ({ spawnOwned: (_ledger: unknown, options: typeof started[number]) => {
  started.push(options);
  return { child: { exitCode: null, signalCode: null }, stop: async () => {} };
} }));

import { relocateFixture } from '../../fixtures/roam-relocate.js';

describe('relocation fixture service startup', () => {
  it('uses the node executable and launches packaged services without observation loaders', async () => {
    const root = mkdtempSync(join(process.cwd(), '.spider/scratch/relocate-startup-'));
    const agent = join(root, 'agent'), global = join(root, 'global'), source = join(root, 'source');
    const previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      for (const dir of [agent, global, source, join(root, 'bin')]) mkdirSync(dir, { recursive: true });
      for (const name of ['settings.json', 'models.json']) writeFileSync(join(agent, name), '{}');
      writeFileSync(join(global, 'config.json'), '{}');
      const ledger = { update: (fn: (value: object) => void) => fn({}) };
      const suite = {
        root, ledger, env: {},
        directories: { SPIDER_GLOBAL_ROOT: global, PI_CODING_AGENT_DIR: agent, HERDR_APP_HOME: join(root, 'app') },
        cores: { local: { env: {}, namespace: 'hub', socket: 'hub.sock' }, dest: { env: {}, namespace: 'box', socket: 'box.sock' },
          machine: 'fixture', wrapper: 'hc', recordLog: 'hc.log', viaLog: 'via.log' },
        packed: { root: 'package', roamCli: 'cli.mjs', roamSupervisor: 'supervisor.mjs' },
        pi: { launcher: 'pi' }, project: async () => source, ownPath: (path: string) => path,
        invoke: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        hc: async () => { throw new Error('stop before session launch'); },
        keepEvidence: async () => {},
      } as unknown as Suite;
      started.length = 0;
      await expect(relocateFixture(suite)).rejects.toThrow('stop before session launch');
      const hubConfig = JSON.parse(readFileSync(join(global, 'roam', 'config.json'), 'utf8'));
      expect(hubConfig.peers[0].node).toBe(process.execPath);
      expect(started.map(({ label, command, args }) => ({ label, command, args }))).toEqual([
        { label: 'v0-supervisor', command: process.execPath, args: ['supervisor.mjs', '--v0'] },
        { label: 'v0-hub', command: process.execPath, args: ['cli.mjs', 'roam', 'hub-v0'] },
      ]);
      for (const service of started) {
        expect(Object.keys(service.env).filter(key => key.startsWith('SPIDER_HERDR_E2E_OWNER_') || key.startsWith('SPIDER_HERDR_E2E_SYNC_'))).toEqual([]);
      }
    } finally {
      Object.defineProperty(process, 'platform', previousPlatform);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
