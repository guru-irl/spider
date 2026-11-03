// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bus } from '@spider/db-core';
import { mountedFixture } from './herdr-wiring-fixture.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it('publishes name changes promptly and retains heartbeat and later feed updates', async () => {
  const f = await mountedFixture('fake', 'rpc', false);
  try {
    const readFeed = async () => JSON.parse(await readFile(f.feedPath, 'utf8'));
    const heartbeatPath = join(f.config.globalRoot, 'herdr/sessions', f.owner!.sessionId, 'heartbeat.json');
    expect((await readFeed()).owner.name).toBeNull();
    Reflect.set(f.pi, 'getSessionName', () => 'Sample Session');
    await f.emit('session_info_changed');
    expect((await readFeed()).owner.name).toBe('Sample Session');
    expect((await f.presence.list())[0].sessionName).toBe('Sample Session');
    const heartbeat = JSON.parse(await readFile(heartbeatPath, 'utf8')).updatedAt;
    await vi.waitFor(async () => expect(JSON.parse(await readFile(heartbeatPath, 'utf8')).updatedAt).toBeGreaterThan(heartbeat), { timeout: 5000 });
    const run = f.store.create({ sessionId: f.owner!.sessionId, agent: 'worker', name: 'Sample Run' });
    bus.emit({ sessionId: f.owner!.sessionId, runId: run.id, ts: Date.now(), type: 'status' });
    await vi.waitFor(async () => expect((await readFeed()).runs.rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: run.id })])));
    expect((await readFeed()).owner.name).toBe('Sample Session');
    Reflect.set(f.pi, 'getSessionName', () => undefined);
    await f.emit('session_info_changed');
    expect((await readFeed()).owner.name).toBeNull();
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it('uses the renamed session for viewers opened by run events', async () => {
  const f = await mountedFixture('fake', 'rpc', false, false, true, true);
  try {
    Reflect.set(f.pi, 'getSessionName', () => 'Sample Session');
    await f.emit('session_info_changed');
    const run = f.store.create({ sessionId: f.owner!.sessionId, agent: 'worker', name: 'Sample Run' });
    f.store.start(run.id);
    bus.emit({ sessionId: f.owner!.sessionId, runId: run.id, ts: Date.now(), type: 'status' });
    let viewer: { labels: Record<string, string> } | undefined;
    await vi.waitFor(async () => {
      const listed = await f.h.cli(['ls', '--all', '--json']) as { terminals: { address: string }[] };
      const terminals = await Promise.all(listed.terminals.map(row => f.h.hc.get(row.address as never)));
      viewer = terminals.find(row => row.labels['spider.kind'] === 'subagent-viewer' && row.labels['spider.run'] === run.id);
      expect(viewer).toBeDefined();
    }, { timeout: 10000 });
    expect(viewer!.labels['spider.parent-name']).toBe('Sample Session');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);
