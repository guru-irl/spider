// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { ProcessTerminal } from '@earendil-works/pi-tui';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import type { HerdrHarness } from '../testutil.js';
import { HERDR_LABELS, HERDR_KINDS, type Owner, type SessionFeed } from '../../contracts.js';
import { installStatusAdapter } from '../../status/adapter.js';
import { publishSessionFeed } from '../../feed/publisher.js';
import { startSessionEndpoint, type SessionEndpoint, type SessionEndpointPorts } from '../../feed/ipc-server.js';
import { createSessionIpcClient } from '../../feed/ipc-client.js';
import { parseFeed } from '../../../assets/shared/feed.js';

async function isolatedNativeStatus(h: HerdrHarness): Promise<void> {
  const moduleRoot = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  const adapterPath = fileURLToPath(new URL('../../status/adapter.ts', import.meta.url));
  const script = join(h.root, 'native-status.mjs'); const release = join(h.root, 'native-release');
  await writeFile(script, `import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessTerminal } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-tui'))};
import { ProgramStatusReporter } from ${JSON.stringify(pathToFileURL(join(moduleRoot, 'modes/interactive/program-status-reporter.js')).href)};
import { installStatusAdapter } from ${JSON.stringify(pathToFileURL(adapterPath).href)};
const terminal = Object.create(ProcessTerminal.prototype);
terminal.programStatusSupported = true;
const reporter = new ProgramStatusReporter(() => terminal, () => 'fixture');
reporter.reset();
const adapter = installStatusAdapter(terminal, { running: 2, queued: 0, paused: 0 });
if ('disabled' in adapter) throw new Error(adapter.reason);
reporter.handleEvent({ type: 'agent_settled', aborted: false });
terminal.writeProgramStatus();
const deadline = Date.now() + 10000;
while (!existsSync(${JSON.stringify(release)})) { if (Date.now() > deadline) throw new Error('Status test release timeout'); await delay(20); }
adapter.update({ running: 0, queued: 0, paused: 0 });
await delay(60000);
`);
  const handle = await h.hc.run({ argv: [h.nodeBinary, script], cwd: h.root, labels: { [HERDR_LABELS.kind]: HERDR_KINDS.setupProbe, [HERDR_LABELS.session]: h.owner!.sessionId }, parent: h.owner!.terminal.address, outliveParent: false, background: true, noNotify: true });
  const waitFor = async (state: string) => {
    const deadline = Date.now() + 10000;
    while (true) {
      const value = await h.hc.get(handle.address);
      if (value.status?.state === state) return value;
      if (value.state === 'finished' || Date.now() > deadline) throw new Error(`Native status ${state} not observed: ${JSON.stringify(value)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    expect((await waitFor('working')).status).toMatchObject({ state: 'working' });
    await writeFile(release, 'release'); expect((await waitFor('done')).status).toMatchObject({ state: 'done' });
  } finally { await h.hc.kill(handle.address); await h.hc.rm(handle.address); }
}

export async function acceptanceB(h: HerdrHarness): Promise<void> {
  if (!h.owner || !h.localCoreId || !h.remoteCoreId) throw new Error('Started isolated harness required');
  expect(h.localCoreId).not.toBe(h.remoteCoreId);
  const beforeRoot = process.env.SPIDER_GLOBAL_ROOT; const beforeStatus = process.env.PI_PROGRAM_STATUS;
  process.env.SPIDER_GLOBAL_ROOT = h.directories.global; delete process.env.PI_PROGRAM_STATUS;
  let endpoint: SessionEndpoint | undefined; let replacement: SessionEndpoint | undefined;
  const terminal = Object.create(ProcessTerminal.prototype) as ProcessTerminal;
  Reflect.set(terminal, 'programStatusSupported', false); // Cache proof must not write into the test runner's terminal.
  const root = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  const { ProgramStatusReporter } = await import(/* @vite-ignore */ pathToFileURL(join(root, 'modes/interactive/program-status-reporter.js')).href);
  const reporter = new ProgramStatusReporter(() => terminal, () => 'fixture'); reporter.reset();
  const adapter = installStatusAdapter(terminal, { running: 2, queued: 0, paused: 0 });
  if ('disabled' in adapter) throw new Error(adapter.reason);
  try {
    reporter.handleEvent({ type: 'agent_settled', aborted: false }); Reflect.get(terminal, 'writeProgramStatus').call(terminal);
    expect(Reflect.get(terminal, 'programStatus')).toMatchObject({ state: 'working', message: '2 subagents running' });
    let current: Owner = h.owner;
    const ports: SessionEndpointPorts = { currentOwner: () => current, liveCapabilities: () => ({ native: reporter.currentStatus().state, effective: Reflect.get(terminal, 'programStatus')?.state ?? null }), ownsRun: () => false,
      subscribeRun: () => ({ dispose() {} }), steerRun: () => { throw new Error('Foreign generation must not steer'); }, openView() {}, openRun: () => null, ownsJob: () => false, openJob: () => null };
    endpoint = await startSessionEndpoint(current, ports, join(h.directories.global, 'herdr'));
    const client = createSessionIpcClient(endpoint.descriptor);
    try {
      expect(await client.ping()).toMatchObject({ ok: true, op: 'ping', status: { native: 'done', effective: 'working' } });
      const feed: SessionFeed = { version: 1, sessionId: current.sessionId, generation: current.generation, revision: 1, updatedAt: Date.now(), owner: current, placement: null, lifecycle: 'live',
        status: { native: reporter.currentStatus().state, effective: Reflect.get(terminal, 'programStatus').state, message: Reflect.get(terminal, 'programStatus').message },
        runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
        pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture has no counter' }, approvals: [], notifications: [],
        ipc: { address: endpoint.descriptor.address, capabilityFile: endpoint.descriptor.capabilityFile }, errors: [] };
      const feedRoot = join(h.directories.global, 'herdr'); await publishSessionFeed(feedRoot, feed);
      const published = parseFeed(await readFile(join(feedRoot, 'sessions', current.sessionId, 'session.json'), 'utf8'))!;
      expect(published.owner.sessionFile).toBeNull(); expect(Date.now() - published.updatedAt).toBeLessThan(10000); expect(published.status.effective).toBe('working');
      current = { ...current, generation: 'replacement-generation' as Owner['generation'] };
      expect(await client.request({ op: 'steerRun', generation: endpoint.descriptor.generation, runId: 'foreign-run' as SessionFeed['runs']['rows'][number]['id'], text: 'must not steer' })).toMatchObject({ ok: false, code: 'wrong-generation' });
      await endpoint.dispose(); await expect(lstat(endpoint.descriptor.address)).rejects.toMatchObject({ code: 'ENOENT' });
      replacement = await startSessionEndpoint(current, ports, join(h.directories.global, 'herdr'));
      const next = createSessionIpcClient(replacement.descriptor);
      try { expect(await next.ping()).toMatchObject({ ok: true }); } finally { next.dispose(); }
      adapter.update({ running: 0, queued: 0, paused: 0 }); expect(Reflect.get(terminal, 'programStatus').state).toBe('done');
    } finally { client.dispose(); }
    if (h.mode !== 'fake') await isolatedNativeStatus(h);
  } finally {
    adapter.dispose(); await endpoint?.dispose(); await replacement?.dispose();
    if (beforeRoot === undefined) delete process.env.SPIDER_GLOBAL_ROOT; else process.env.SPIDER_GLOBAL_ROOT = beforeRoot;
    if (beforeStatus === undefined) delete process.env.PI_PROGRAM_STATUS; else process.env.PI_PROGRAM_STATUS = beforeStatus;
  }
}
