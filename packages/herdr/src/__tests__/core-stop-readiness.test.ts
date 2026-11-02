// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { createHcClient } from '../client/hc.js';
import { createJobMonitor, type JobMonitor } from '../jobs/monitor.js';
import type { MachineName } from '../contracts.js';
import { createHerdrHarness, proveSocketPaths } from './testutil.js';

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('shutdown or core wait did not settle')), 2000); })]); }
  finally { clearTimeout(timer!); }
}
const binary = process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc');
const available = await access(binary).then(() => true, () => false);
const enabled = process.env.SPIDER_HERDR_E2E === '1' && available;
if (!enabled) console.info('SKIP stopped-core readiness: requires SPIDER_HERDR_E2E=1 and installed hc; no app window is used');
test.skipIf(!enabled)('a core stopped mid-session fails fresh waits and remote admission and permits bounded quit/reload', async () => {
  const h = await createHerdrHarness('hc');
  proveSocketPaths(h.root, [h.localSocket, h.remoteSocket]);
  expect(h.localSocket).not.toBe(join(homedir(), '.local/state/herdr-core/default/default.sock'));
  console.info('Isolated sockets:', h.localSocket, h.remoteSocket);
  const monitors: JobMonitor[] = [];
  let client: ReturnType<typeof createHcClient> | undefined;
  try {
    await h.start();
    client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
    const stream = client.events(); await stream.ready;
    for (const reason of ['quit', 'reload'] as const) {
      const monitor = createJobMonitor({ hc: client, journalRoot: join(h.root, reason),
        outputCollector: { prepare: async () => { throw new Error('No payload may launch while the core is down'); }, collect: async () => ({ complete: false, summary: '', receipt: null }) },
        observedJobMessages: async () => [], notifier: () => { throw new Error('No notice expected'); }, clock: Date.now,
      });
      monitors.push(monitor); await monitor.activate(h.owner!);
    }
    await h.cli(['server', 'stop', '--json']);
    await expect.poll(() => existsSync(h.localSocket), { timeout: 3000, interval: 10 }).toBe(false);
    await delay(10000);
    expect(existsSync(h.localSocket), 'spider must not restart a stopped core').toBe(false);
    const fresh = client.events();
    await expect(bounded(fresh.ready)).rejects.toMatchObject({ code: 'core-unavailable' });
    await expect(bounded(fresh.lookup(h.owner!.terminal.address))).rejects.toMatchObject({ code: 'core-unavailable' });
    await expect(bounded(monitors[0]!.reconcile())).rejects.toMatchObject({ code: 'core-unavailable' });
    await expect(bounded(monitors[0]!.start({ directory: join(h.root, 'unused'), argv: ['false'], cwd: null, files: [], env: {} }, h.owner!, 'remote.invalid' as MachineName, {}))).rejects.toMatchObject({ code: 'core-unavailable' });
    await bounded(monitors[0]!.shutdown('quit')); await bounded(monitors[1]!.shutdown('reload'));
    await fresh.dispose();
    await bounded(Promise.resolve(client.dispose()));
    console.info('After 10 seconds down: ready/lookup/reconcile/remote launch rejected core-unavailable; quit, reload and client disposal settled within 2 seconds');
  } finally {
    // External start is test-owned and needed to inventory/remove the programs
    // that legitimately outlive a stopped core, even on a failed assertion.
    if (!existsSync(h.localSocket)) await h.cli(['server', 'start', '--json']);
    for (const monitor of monitors) await monitor.shutdown('reload');
    await client?.dispose(); await h.close();
    expect(await h.remainingOwnedResources()).toEqual([]);
    console.info('Cleanup proof:', JSON.stringify(h.cleanupProof));
  }
}, 40000);
