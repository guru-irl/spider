// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHerdrHarness, type HerdrHarness } from '../../../herdr/src/__tests__/isolated.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { createPaneRuntime, type PaneRuntime } from '../herdr/pane-runtime.js';
const resources: { h: HerdrHarness; runtime: PaneRuntime }[] = [];
afterEach(async () => { for (const { h, runtime } of resources.splice(0)) { await runtime.dispose(); await h.close(); } });
async function fixture(coreOnly = false, mode: 'fake' | 'hc' = 'fake') {
  const h = await createHerdrHarness(mode); if (mode === 'hc') { h.localEnv.PATH = '/usr/bin:/bin'; h.localEnv.SHELL = join(h.root, 'empty-login-shell'); await writeFile(h.localEnv.SHELL, '#!/bin/sh\nexit 1\n', { mode: 0o700 }); } await h.start();
  const appBinary = mode === 'hc' ? join(h.root, 'app-metadata') : h.appBinary;
  if (mode === 'hc') await writeFile(appBinary, `#!${process.execPath}\nconst c=process.argv[2];if(!["commands","ls","status"].includes(c))process.exit(3);process.stdout.write(JSON.stringify(c==="commands"?[]:c==="ls"?{spaces:[]}:{}))`, { mode: 0o755 });
  const config = parseHerdrConfig({ mode: coreOnly ? 'core-only' : 'full', app: { binary: appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.root, 'core.toml') }, globalRoot: h.directories.global, agentDirectory: h.directories.agent, shellRc: join(h.root, 'shellrc'), machines: [], spaces: [] });
  await mkdir(join(config.globalRoot, 'herdr'), { recursive: true }); await writeFile(join(config.globalRoot, 'herdr/config.json'), JSON.stringify(config));
  const runtime = createPaneRuntime({ config, hc: h.hc, env: mode === 'hc' ? { ...h.localEnv } : h.localEnv, packageRoot: process.cwd(), endpointBytes: Buffer.from('synthetic endpoint') });
  resources.push({ h, runtime }); return { h, runtime, service: runtime.createService() };
}
test('production service snapshots use the already selected core and start no target', async () => {
  const { h, service } = await fixture(); const before = h.mutations().length;
  expect(await service.request({ version: 1, op: 'snapshot', operationId: 'snapshot-1' })).toMatchObject({ kind: 'snapshot', complete: false, omittedRows: 0, rows: [], machines: [{ coreId: h.localCoreId, alias: null, label: 'This computer' }] });
  await service.reconcile();
  expect(await service.request({ version: 1, op: 'snapshot', operationId: 'snapshot-2' })).toMatchObject({ kind: 'snapshot', complete: true, omittedRows: 0, rows: [], machines: [{ coreId: h.localCoreId, alias: null, label: 'This computer' }] });
  expect(h.mutations()).toHaveLength(before);
});
test('production unknown agent key refuses before target or app mutation', async () => {
  const { h, service } = await fixture(); const before = h.mutations().length;
  expect(await service.request({ version: 1, op: 'open', operationId: 'open-1', machineKey: h.localCoreId!, coreId: h.localCoreId!, machineId: null,
    intent: { operationId: 'open-1', space: 'space-1' as never, place: 'tab', anchor: null, program: { kind: 'agent', key: 'unlisted' } } })).toMatchObject({ outcome: { status: 'refused', reason: 'unknown-agent' } });
  expect(h.mutations()).toHaveLength(before);
});
test('core only view endpoint works while old placement actions refuse', async () => {
  const { h, service } = await fixture(true); const before = h.mutations().length;
  expect(await service.request({ version: 1, op: 'snapshot', operationId: 'snapshot-1' })).toMatchObject({ kind: 'snapshot', rows: [] });
  expect(await service.request({ version: 1, op: 'open', operationId: 'open-1', machineKey: h.localCoreId!, coreId: h.localCoreId!, machineId: null,
    intent: { operationId: 'open-1', space: 'space-1' as never, place: 'tab', anchor: null, program: { kind: 'shell' } } })).toMatchObject({ outcome: { reason: 'view-on-mac' } });
  expect((await h.calls()).some(call => ['tab.new', 'terminal.open', 'terminal.keep'].some(name => call.argv.includes(name)))).toBe(false);
  expect(h.mutations()).toHaveLength(before);
});

test.skipIf(!process.env.SPIDER_HERDR_HC_BINARY)('a failed qualified program lookup refuses without a real core target launch', async () => {
  vi.stubEnv('SPIDER_HERDR_E2E', '1');
  try {
    const { h, runtime, service } = await fixture(false, 'hc');
    const before = await h.cli(['ls', '--json']);
    const reply = await service.request({ version: 1, op: 'open', operationId: 'missing-program', machineKey: h.localCoreId!, coreId: h.localCoreId!, machineId: null,
      intent: { operationId: 'missing-program', space: 'space-1' as never, place: 'tab', anchor: null, program: { kind: 'agent', key: 'pi' } } });
    expect(reply).toMatchObject({ outcome: { status: 'refused', reason: 'agent-program-missing' } });
    expect(await h.cli(['ls', '--json'])).toEqual(before); expect((await runtime.store.read()).launches).toEqual([]);
  } finally { vi.unstubAllEnvs(); }
}, 20000);
