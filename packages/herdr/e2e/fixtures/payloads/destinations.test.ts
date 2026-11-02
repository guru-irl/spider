// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { it, expect } from 'vitest';
import { access } from 'node:fs/promises';
import { identityAlive } from '../../harness/resources.js';
import { createSuite } from '../../harness/suite.js';
import { storyId } from '../../harness/scenario.js';
import { waitFor, deadline } from '../../harness/wait.js';
import { secondDestination } from './destinations.js';
import { stagePayload } from './index.js';

it('routes the second machine through a third unique owned namespace and restores all three cores', async () => {
  const suite = await createSuite({ tier: 'headless', story: storyId('H-second-machine') });
  try {
    const name = await secondDestination(suite), before = suite.ledger.read();
    expect(before.cores).toHaveLength(3); expect(new Set(before.cores.map(c => c.coreId)).size).toBe(3); expect(new Set(before.cores.map(c => c.socket)).size).toBe(3);
    const payload = await stagePayload(suite, { id: 'extra', machine: name, gate: false, stdout: 'from-second\n', stderr: 'second-error\n', exitCode: 29 });
    const started = await suite.hc(['run', '--json', '--bg', '--no-notify', '--outlive-parent', '--keep', '--on', name, '--', '/bin/sh', '-c', payload.code]);
    expect(started.exitCode).toBe(0); const address = (started.json as { address: string }).address; expect(address.startsWith(name + '/')).toBe(true);
    suite.ledger.update(l => l.terminals.push({ side: 'local', address }));
    const finished = await waitFor('third namespace payload finishes', async () => (await suite.hc(['get', address, '--json'])).json as { state: string; exit_code: number; signal: number | null }, t => t?.state === 'finished', deadline(10000));
    expect(finished.exit_code).toBe(29); expect(finished.signal).toBe(null); expect(await payload.effect()).toBe('extra\n');
    const read = await suite.hc(['read', address, '--json', '--lines', '100']); expect(read.exitCode).toBe(0);
    const text = (read.json as { text: string }).text; expect(text).toContain('from-second'); expect(text).toContain('second-error');
    const local = (await suite.hc(['server', 'status', '--json'])).json as { core: { id: string } }; expect(local.core.id).toBe(suite.cores!.local.coreId);
    const proof = await suite.close(); expect(proof.clean).toBe(true); expect(proof.survivors).toEqual([]);
    for (const core of before.cores) { expect(core.pid).toBeGreaterThan(0); expect(identityAlive({ pid: core.pid!, start: core.start! })).toBe(false); expect(await access(core.socket).then(() => true, () => false)).toBe(false); }
  } finally { await suite.close(); }
}, 60000);
