// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHerdrHarness } from './testutil.js';
import { crashFakeCore } from './fake-core-crash.js';
import { isCoreAvailable } from '../client/liveness.js';
import { processStartTime } from '../../../subagents/src/process-identity.js';

it('keeps actual terminal programs running across a fake core process crash', async () => {
  const h = await createHerdrHarness('fake');
  try {
    await h.start();
    const output = join(h.root, 'survivor.txt');
    const terminal = await h.hc.run({ argv: [process.execPath, '-e', `const fs=require('node:fs');let n=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(output)},String(++n)),20)`], cwd: h.root, labels: {}, background: true, outliveParent: true, noNotify: true, parent: null });
    const value = () => readFile(output, 'utf8').catch(() => '');
    await expect.poll(value).not.toBe('');
    const outage = await crashFakeCore(h);
    expect(await isCoreAvailable(h.localEnv)).toBe(false);
    const whileDown = await value();
    await expect.poll(value).not.toBe(whileDown);
    await outage.recover();
    expect((await h.hc.get(terminal.address)).state).toBe('live');
    const afterReturn = await value();
    await expect.poll(value).not.toBe(afterReturn);
  } finally {
    await h.close();
    expect(await h.remainingOwnedResources()).toEqual([]);
  }
}, 15000);

it('cleans surviving terminal programs even when recovery is never requested', async () => {
  const h = await createHerdrHarness('fake');
  let pid: number | undefined, identity: string | null = null;
  try {
    await h.start();
    const row = await h.cli(['get', h.owner!.terminal.address, '--json']) as { pid: number };
    pid = row.pid; identity = processStartTime(pid);
    await crashFakeCore(h);
    await h.close();
    await expect.poll(() => processStartTime(pid!), { timeout: 1000 }).toBeNull();
    expect(await h.remainingOwnedResources()).toEqual([]);
  } finally {
    if (pid && identity && processStartTime(pid) === identity) process.kill(pid, 'SIGKILL');
    await h.close();
  }
}, 15000);
