// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDbAt } from '@spider/db-core';
import { DEFAULT_LIMITS, disabledIntercom, type RoamConfig } from '@spider/roam/contracts';
import { openJournal } from '@spider/roam/journal';
import { createClientFixture } from '../../../../herdr/src/__tests__/testutil.js';
import * as hcModule from '@spider/herdr/client/hc';
import * as appModule from '@spider/herdr/client/app';
import type { HcClient, HcRunRequest } from '@spider/herdr/contracts';
import { parsePaneTarget } from '@spider/herdr/panes/codec';
import { createProductionHerdrCliPorts } from '../../herdr/ports.js';
import { createHostRoamPlacement } from '../readiness.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); } finally { vi.restoreAllMocks(); } });
it.each(['core-only', 'full'] as const)('%s production sync starts a presentation helper only when app-capable', async mode => {
  const f = await createClientFixture(); cleanups.push(() => f.close());
  execFileSync('git', ['init', '-q', f.root]);
  vi.spyOn(process, 'cwd').mockReturnValue(f.root);
  const root = join(f.root, 'global'), HUB = '00000000-0000-4000-8000-000000000001';
  await mkdir(join(root, 'herdr'), { recursive: true });
  await mkdir(join(root, 'roam'), { recursive: true });
  await mkdir(join(f.root, 'dist', 'herdr'), { recursive: true });
  await writeFile(join(f.root, 'dist', 'herdr', 'pane-endpoint.mjs'), 'export {};');
  await writeFile(join(root, 'herdr', 'installation.json'), JSON.stringify({ version: 1, packageRoot: f.root }), { mode: 0o600 });
  await writeFile(join(root, 'herdr', 'config.json'), JSON.stringify({ enabled: true, mode, globalRoot: root, app: { binary: f.appBinary, home: join(f.root, 'app') },
    core: { binary: f.hcBinary, config: join(f.root, 'core.toml') }, agentDirectory: join(f.root, 'agent'), shellRc: join(f.root, 'shellrc'), spaces: [], machines: [] }));
  const launches: HcRunRequest[] = [];
  const client = { identity: async () => ({ coreId: 'local-core', socket: f.localSocket, sessionNamespace: f.namespace }),
    events: () => ({ ready: Promise.resolve(), subscribe: () => () => {}, dispose() {} }),
    run: async (request: HcRunRequest) => { launches.push(request); throw Error('Helper launch refused by fixture'); }, dispose: async () => {} } as unknown as HcClient & { dispose(): Promise<void> };
  vi.spyOn(hcModule, 'createHcClient').mockReturnValue(client);
  const app = vi.spyOn(appModule, 'createAppClient');
  const globalDb = openDbAt(join(root, 'global.db'), 'global'); cleanups.push(async () => { globalDb.close(); });
  openJournal(join(root, 'roam', 'journal.db'));
  const config: RoamConfig = { enabled: true, role: 'hub', machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: 'fixture', syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  const rows = ['session-1', 'session-2'].map((sessionId, i) => ({ origin: 'hub-operation' as const, opId: 'op-' + i, sessionId, epoch: 1, cwd: '/example', file: '/example/session.jsonl', core: 'local-core', terminal: 't' + (i + 1) }));
  for (const row of rows) globalDb.prepare('INSERT INTO session_homes VALUES(?,?,?,?,?)').run(row.sessionId, HUB, 1, null, 1);
  const placement = createHostRoamPlacement({ root, globalDb, config }); cleanups.push(() => placement.dispose());
  expect(await placement.reconcile(rows)).toEqual({ pending: ['t1', 't2'] });
  expect(await placement.reconcile(rows)).toEqual({ pending: ['t1', 't2'] });
  const cli = createProductionHerdrCliPorts(f.root, { ...f.localEnv, SPIDER_GLOBAL_ROOT: root }); cleanups.push(() => cli.dispose());
  const ports = await cli.roamPresentations();
  for (const row of rows) expect(await ports.resolveTarget({ sessionId: row.sessionId, machineId: HUB, homeEpoch: 1, coreId: row.core, local: true }).catch(() => null)).toBeNull();
  if (mode === 'core-only') {
    const source = parsePaneTarget({ coreId: 'local-core', terminalId: 't1', address: 't1', createdMs: 17, identityLabels: { 'spider.session': 'session-1' }, alias: null, machineId: HUB,
      kind: 'session', sessionId: 'session-1', generation: 'gen-1', homeEpoch: 1, runId: null, consoleId: null, name: null, cwd: '/example' });
    expect(await ports.prepareHandoff(source.sessionId!, source)).toMatchObject({ status: 'pending', presentation: null });
    expect(await ports.presentReadyTarget(source)).toMatchObject({ status: 'pending', presentation: null });
  }
  expect(launches).toHaveLength(mode === 'core-only' ? 0 : 1);
  if (mode === 'full') expect(launches[0]).toMatchObject({ argv: expect.arrayContaining(['panes', 'serve']), background: true, noNotify: true, parent: null });
  if (mode === 'core-only') expect(app).not.toHaveBeenCalled();
  else expect(app).toHaveBeenCalled();
});
