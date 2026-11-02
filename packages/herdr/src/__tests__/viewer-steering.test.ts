// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDbAt } from '@spider/db-core';
import { scratchDbPath, cleanupScratch } from '@spider/db-core/testutil';
import { RunStore } from '../../../subagents/src/run-store.js';
import { makeMessageHandler } from '../../../subagents/src/actions/message.js';
import { registerChild, unregisterChild } from '../../../subagents/src/coordinators.js';
import { submitViewerSteer } from '../viewers/steering.js';
import { acceptanceF } from './acceptance/f.js';
import { runAcceptance, type HerdrHarness } from './testutil.js';
import type { RunId } from '../contracts.js';
import type { ViewerSteerClient } from '../viewers/steering.js';
import type { SteerReply } from '../contracts.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); cleanupScratch(); });
function fixture(requestingSession = 'owner') {
  const db = openDbAt(scratchDbPath('viewer-steer'), 'worktree'); const store = new RunStore(db);
  const runId = store.create({ sessionId: 'owner', agent: 'worker' }).id as RunId; store.start(runId); store.setLaunch(runId, { childMode: 'rpc' });
  const observed: string[] = [];
  const child = { wait: async () => ({ exitCode: 0 }), kill: () => {}, detach: () => {}, steer: async (text: string) => { observed.push(text); return { accepted: true, delivered: true, delivery: 'delivered' as const }; } };
  registerChild('owner', runId, child);
  const handler = makeMessageHandler();
  const client: ViewerSteerClient = { steerRun: async (id, text) => ({ ok: true, op: 'steerRun', acknowledgement: (await handler({ to: id, message: text }, { db, sessionId: requestingSession })).details }) };
  cleanups.push(() => { unregisterChild('owner', runId); db.close(); });
  return { store, runId, observed, client, draft: 'half-written prompt' };
}
describe('viewer steering', () => {
  it('persists a real offline RPC child steer exactly once through its owning action', async () => {
    let used: HerdrHarness | undefined;
    await runAcceptance('viewers', async h => { used = h; await acceptanceF(h); });
    expect(await used!.remainingOwnedResources()).toEqual([]);
    expect(used!.cleanupProof).toMatchObject({ remaining: [], defaultCoreUnchanged: true });
    writeFileSync(resolve(`.spider/scratch/h/cleanup-viewers-${used!.mode}.json`), JSON.stringify(used!.cleanupProof, null, 2));
  }, 25000);
  it('preserves the owning action refusal for a foreign owner without any child message', async () => {
    const h = fixture('foreign-owner'); const reply = await submitViewerSteer(h.client, h.runId, 'Use case B');
    expect(reply).toMatchObject({ delivery: 'refused', accepted: false }); expect(reply.error).toContain('owned by session owner'); expect(h.observed).toEqual([]);
  });
  it('preserves an endpoint refusal message without converting it to uncertain delivery', async () => {
    const reply = await submitViewerSteer({ steerRun: async () => ({ ok: false, code: 'refused', reason: 'wrong-owner', message: 'Owned by another session.' }) }, 'run' as RunId, 'Use case B');
    expect(reply).toEqual({ delivery: 'refused', accepted: false, delivered: false, queued: false, error: 'Owned by another session.' });
  });
  it.each(['queued', 'paused', 'failed', 'cancelled'] as const)('preserves the owning action refusal for a %s child', async status => {
    const h = fixture();
    h.store.finish(h.runId, { status });
    expect(await submitViewerSteer(h.client, h.runId, 'Use case B')).toMatchObject({ accepted: false, delivery: 'refused' });
    expect(h.observed).toEqual([]);
  });
  it('preserves print-mode and dead-registry refusals without touching the child', async () => {
    const h = fixture(); h.store.setLaunch(h.runId, { childMode: 'print' });
    expect(await submitViewerSteer(h.client, h.runId, 'Use case B')).toMatchObject({ accepted: false, delivery: 'refused' });
    h.store.setLaunch(h.runId, { childMode: 'rpc' }); unregisterChild('owner', h.runId);
    expect(await submitViewerSteer(h.client, h.runId, 'Use case B')).toMatchObject({ accepted: false, delivery: 'refused' });
    expect(h.observed).toEqual([]);
  });
  it('does not turn broker acceptance into observed delivery', async () => {
    const reply: SteerReply = { accepted: true, delivered: false, queued: true, delivery: 'accepted but not confirmed', transformed: true };
    expect(await submitViewerSteer({ steerRun: async () => ({ ok: true, op: 'steerRun', acknowledgement: reply }) }, 'run' as RunId, 'Use case B')).toEqual(reply);
  });
  it('refuses slash-prefixed and blank input without child messages', async () => {
    const h = fixture();
    for (const text of [' /skill:test', '  ']) expect(await submitViewerSteer(h.client, h.runId, text)).toMatchObject({ accepted: false, delivery: 'refused' });
    expect(h.observed).toEqual([]);
  });
  it('refuses oversized composer input before touching the transport', async () => {
    let calls = 0;
    const client: ViewerSteerClient = { steerRun: async () => { calls++; return { ok: true, op: 'steerRun', acknowledgement: { accepted: true, delivered: true, queued: false, delivery: 'delivered' } }; } };
    expect(await submitViewerSteer(client, 'run' as RunId, '漢'.repeat(6000))).toMatchObject({ accepted: false, delivery: 'refused' });
    expect(calls).toBe(0);
  });
  it('reports a dead pipe as uncertain without silently resending', async () => {
    let calls = 0;
    const client: ViewerSteerClient = { steerRun: async () => { calls++; throw new Error('pipe closed after write'); } };
    expect(await submitViewerSteer(client, 'run' as RunId, 'Use case B')).toMatchObject({ accepted: false, delivered: false, delivery: 'no reply yet, delivery unknown' });
    expect(calls).toBe(1);
  });
  it('a completed RPC child refuses a raced composer submission', async () => {
    const h = fixture(); h.store.finish(h.runId, { status: 'done' });
    const reply = await submitViewerSteer(h.client, h.runId, 'Use case B');
    expect(reply).toMatchObject({ delivery: 'refused', accepted: false });
    expect(h.draft).toBe('half-written prompt');
    expect(h.observed).toEqual([]);
  });
});
