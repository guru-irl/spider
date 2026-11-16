// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import { forgetMachine } from '../forget';
import { sessionHome } from '../homes';
import { isRevoked } from '../revocation';
import { BOX, HUB, recoveryFixture } from './recovery-fixture';
const resources: Awaited<ReturnType<typeof recoveryFixture>>[] = [];
afterEach(() => { for (const f of resources.splice(0)) f.close(); });

it.each(['visible', 'parked'] as const)('restored home retains Mac slot and %s intent after valid readiness', async visibility => {
  const f = await recoveryFixture(); resources.push(f);
  const slot = { space: 'space-1', tab: 'tab-1', pane: 'pane-1' };
  let presentation = { mode: 'proxy', visibility, slot, target: { machineId: BOX, terminalId: 'old-terminal', homeEpoch: 1 } };
  let calls = 0;
  f.ports.recovery.presentReadyTarget = async target => {
    calls++;
    expect(sessionHome(f.global.db, target.sessionId)).toMatchObject({ machineId: HUB, epoch: target.homeEpoch });
    expect(isRevoked(f.revocationDb, BOX)).toBe(true);
    expect(f.events).toContain('restore');
    presentation = { ...presentation, mode: 'native', target };
    return { status: 'complete', reason: 'native-presented', presentation };
  };
  expect(await forgetMachine({ machineId: BOX, confirmation: `destroyed ${BOX}` }, f.ports)).toMatchObject({ code: 0, results: [{ presentation: 'complete' }] });
  expect(presentation).toMatchObject({ mode: 'native', visibility, slot, target: { machineId: HUB, sessionId: 'session-a', homeEpoch: 2 } });
  expect(calls).toBe(1);
  expect(f.events.filter(event => event === 'restore')).toHaveLength(1);
});
it('reused alias cannot present a revoked target or repeat a completed restoration', async () => {
  const f = await recoveryFixture(); resources.push(f);
  const calls: unknown[] = [];
  f.ports.recovery.presentReadyTarget = async target => { calls.push(target); return { status: 'complete', reason: 'native-presented', presentation: null }; };
  expect((await forgetMachine({ machineId: BOX, confirmation: `destroyed ${BOX}` }, f.ports)).code).toBe(0);
  const home = sessionHome(f.global.db, 'session-a');
  f.ports.config.peers = f.ports.config.peers.map(peer => peer.machineId === BOX ? { ...peer, alias: 'reused.invalid', core: 'replacement-core' } : peer);
  expect((await forgetMachine({ machineId: BOX, confirmation: `destroyed ${BOX}` }, f.ports)).code).toBe(0);
  expect(calls).toEqual([{ machineId: HUB, alias: null, sessionId: 'session-a', homeEpoch: 2, coreId: 'fixture-core', terminalId: 'fixture-terminal' }]);
  expect(sessionHome(f.global.db, 'session-a')).toEqual(home);
  expect(isRevoked(f.revocationDb, BOX)).toBe(true);
  expect(f.events.filter(event => event === 'restore')).toHaveLength(1);
});
