// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { existsSync } from 'node:fs';
import { access, chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { createHcClient } from '../client/hc.js';
import { createHerdrHarness, proveSocketPaths } from './testutil.js';

const binary = process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc');
const available = await access(binary).then(() => true, () => false);
const enabled = process.env.SPIDER_HERDR_E2E === '1' && available;
if (!enabled) console.info('SKIP core stop/recovery: requires SPIDER_HERDR_E2E=1 and installed hc; no app window is used');
test.skipIf(!enabled)('events do not restart a stopped isolated core for ten seconds, then resume after external start', async () => {
  const h = await createHerdrHarness('hc');
  proveSocketPaths(h.root, [h.localSocket, h.remoteSocket]);
  expect(h.localSocket).not.toBe(join(homedir(), '.local/state/herdr-core/default/default.sock'));
  console.info('Isolated sockets:', h.localSocket, h.remoteSocket);
  let client: ReturnType<typeof createHcClient> | undefined;
  try {
    await h.start();
    const log = join(h.root, 'event-launches.jsonl'), logger = join(h.root, 'log.mjs'), wrapper = join(h.root, 'guard-hc');
    await writeFile(log, '');
    await writeFile(logger, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`);
    const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
    await writeFile(wrapper, `#!/bin/sh\n${quote(process.execPath)} ${quote(logger)} "$@"\nexec ${quote(binary)} "$@"\n`); await chmod(wrapper, 0o700);
    client = createHcClient({ binary: wrapper, env: h.localEnv });
    const stream = client.events(); let snapshots = 0;
    stream.subscribe(event => { if (event.type === 'snapshot') snapshots++; });
    await stream.ready; expect(snapshots).toBe(1);
    const before = await h.cli(['server', 'status', '--json']);
    await h.cli(['server', 'stop', '--json']);
    await expect.poll(() => existsSync(h.localSocket), { timeout: 3000, interval: 10 }).toBe(false);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      expect(existsSync(h.localSocket), 'spider must not recreate the socket').toBe(false);
      await delay(200);
    }
    expect((await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))).toEqual([['events', '--json']]);
    console.info('Stopped core stayed down for 10 seconds; pre-stop status:', JSON.stringify(before));
    await h.cli(['server', 'start', '--json']);
    await expect.poll(() => snapshots, { timeout: 7000 }).toBe(2);
    await stream.ready;
    expect((await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))).toEqual([['events', '--json'], ['events', '--json']]);
  } finally {
    await client?.dispose(); await h.close();
    expect(await h.remainingOwnedResources()).toEqual([]);
    console.info('Cleanup proof:', JSON.stringify(h.cleanupProof));
  }
}, 40000);
