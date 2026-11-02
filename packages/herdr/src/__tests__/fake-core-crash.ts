// SPDX-License-Identifier: MIT
import { expect } from 'vitest';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { HerdrHarness } from './isolated.js';
import { isCoreAvailable } from '../client/liveness.js';
import { processStartTime } from '../../../subagents/src/process-identity.js';

export interface FakeCoreOutage {
  before: { pid: number; core: { id: string } };
  terminals: { address: string; pid: number; start: string }[];
  recover(): Promise<void>;
}

/** The driver holds holder recovery until recover(), allowing socket-only outage checks. */
export async function crashFakeCore(h: HerdrHarness, side: 'local' | 'remote' = 'local'): Promise<FakeCoreOutage> {
  if (h.mode !== 'fake') throw new Error('Fake crash requires a fake harness');
  const env = side === 'local' ? h.localEnv : h.remoteEnv;
  const socket = side === 'local' ? h.localSocket : h.remoteSocket;
  if (!socket.startsWith(h.root + '/')) throw new Error('Crash socket must be test-owned');
  const before = await h.cli(['server', 'status', '--json'], side) as { pid: number; core: { id: string } };
  const inventory = await h.cli(['ls', '--all', '--json'], side) as { terminals: { address: string; pid?: number; state: string }[] };
  const terminals = inventory.terminals.filter(t => t.state === 'live' && !t.address.includes('/')).map(t => {
    if (!t.pid) throw new Error('Live terminal has no process');
    const start = processStartTime(t.pid);
    if (!start) throw new Error('Live terminal process is missing');
    return { address: t.address, pid: t.pid, start };
  });
  for (const terminal of terminals) h.trackProcess(terminal.pid);
  // SIGKILL cannot run the fake's shutdown handler or its child-exit bookkeeping.
  process.kill(before.pid, 'SIGKILL');
  await expect.poll(() => isCoreAvailable(env), { timeout: 5000, interval: 10 }).toBe(false);
  // A holder owns this stale inode after its core dies, not the spider mount.
  await unlink(socket);
  expect(existsSync(socket)).toBe(false);
  const assertSurvivors = () => {
    for (const terminal of terminals) expect(processStartTime(terminal.pid)).toBe(terminal.start);
  };
  assertSurvivors();
  return {
    before, terminals,
    async recover() {
      await h.cli(['server', 'start', '--json'], side);
      const after = await h.cli(['server', 'status', '--json'], side) as typeof before;
      expect(after.core.id).toBe(before.core.id);
      expect(after.pid).not.toBe(before.pid);
      assertSurvivors();
      const restored = await h.cli(['ls', '--all', '--json'], side) as typeof inventory;
      for (const terminal of terminals) expect(restored.terminals.find(t => t.address === terminal.address)).toMatchObject({ pid: terminal.pid, state: 'live' });
    },
  };
}
