// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bus } from '@spider/db-core';
import { mountedFixture } from './herdr-wiring-fixture.js';

const timing = vi.hoisted(() => ({
  onPublish: undefined as (() => void) | undefined,
  pausePlacement: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('@spider/herdr/feed/publisher', async importOriginal => {
  const actual = await importOriginal<typeof import('@spider/herdr/feed/publisher')>();
  return { ...actual, publishSessionFeed: (...args: Parameters<typeof actual.publishSessionFeed>) => {
    // The real publisher serializes the feed before its first filesystem await.
    const pending = actual.publishSessionFeed(...args);
    const onPublish = timing.onPublish;
    timing.onPublish = undefined;
    onPublish?.();
    return pending;
  } };
});

vi.mock('@spider/herdr/client/app', async importOriginal => {
  const actual = await importOriginal<typeof import('@spider/herdr/client/app')>();
  return { ...actual, createAppClient: (...args: Parameters<typeof actual.createAppClient>) => {
    const client = actual.createAppClient(...args);
    const ownerPlacement = client.ownerPlacement;
    client.ownerPlacement = async address => {
      await timing.pausePlacement?.();
      return ownerPlacement(address);
    };
    return client;
  } };
});

afterEach(() => { timing.onPublish = undefined; timing.pausePlacement = undefined; vi.useRealTimers(); vi.unstubAllEnvs(); });

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

it('publishes the latest name when a rename arrives during a feed write', async () => {
  const f = await mountedFixture('fake', 'rpc', false);
  try {
    let renamed: Promise<unknown> | undefined;
    timing.onPublish = () => {
      Reflect.set(f.pi, 'getSessionName', () => 'Final Name');
      renamed = f.emit('session_info_changed');
    };
    Reflect.set(f.pi, 'getSessionName', () => 'First Name');
    await f.emit('session_info_changed');
    expect(renamed).toBeDefined();
    await renamed;
    expect(JSON.parse(await readFile(f.feedPath, 'utf8')).owner.name).toBe('Final Name');
  } finally { timing.onPublish = undefined; await f.close(); }
}, 30000);

it('renews the heartbeat after rename while a snapshot is stalled', async () => {
  const f = await mountedFixture('fake', 'rpc', false);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const snapshotStarted = new Promise<void>(resolve => { entered = resolve; });
  let rename: Promise<unknown> | undefined;
  try {
    const originalOwner = f.mount.owner();
    const heartbeatPath = join(f.config.globalRoot, 'herdr/sessions', f.owner!.sessionId, 'heartbeat.json');
    const heartbeat = JSON.parse(await readFile(heartbeatPath, 'utf8')).updatedAt;
    // A stalled snapshot cannot renew the heartbeat through a feed publish.
    timing.pausePlacement = async () => { entered(); await blocked; };
    Reflect.set(f.pi, 'getSessionName', () => 'Sample Session');
    rename = f.emit('session_info_changed');
    await snapshotStarted;
    expect(f.mount.owner()).toBe(originalOwner);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(heartbeatPath, 'utf8')).updatedAt).toBeGreaterThan(heartbeat), { timeout: 5000 });
  } finally {
    timing.pausePlacement = undefined;
    release();
    await rename;
    await f.close();
  }
}, 30000);

it('uses the renamed session for viewers opened from the sidebar', async () => {
  const f = await mountedFixture('fake', 'rpc', false, false, true, true);
  try {
    Reflect.set(f.pi, 'getSessionName', () => 'Sample Session');
    await f.emit('session_info_changed');
    const run = f.store.create({ sessionId: f.owner!.sessionId, agent: 'worker', name: 'Sample Run' });
    f.store.start(run.id);
    bus.emit({ sessionId: f.owner!.sessionId, runId: run.id, ts: Date.now(), type: 'status' });
    expect(await f.ipc!.openRun(run.id as never)).toMatchObject({ ok: true, op: 'openRun' });
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
