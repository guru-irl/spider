// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { bus } from '@spider/db-core';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { mountedFixture } from './herdr-wiring-fixture.js';

afterEach(() => vi.unstubAllEnvs());

async function gateLaunch(f: Awaited<ReturnType<typeof mountedFixture>>) {
  const path = join(f.h.directories.local, 'launch-gate.sock');
  let connection: Socket | undefined, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const server = createServer(socket => { socket.on('error', () => {}); connection = socket; entered(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await f.h.scenario({ steps: [{ argvPrefix: ['run'], argvIncludes: ['spider.kind=subagent-viewer'], waitSocket: path }] });
  return {
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([waiting, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Viewer launch did not reach the gate')), 10000); })]); }
      finally { clearTimeout(timer); }
    },
    release() { connection?.end(); },
    async close() { connection?.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

it('closes cleanly when a viewer launch is in flight', async () => {
  const f = await mountedFixture('fake', 'rpc', false, false, true, false, true, false, false, true, undefined, { automaticSubagentPanes: true });
  const gate = await gateLaunch(f);
  let closing = false;
  try {
    const run = f.store.create({ sessionId: f.owner!.sessionId, agent: 'worker', name: 'Sample Run' });
    bus.emit({ sessionId: f.owner!.sessionId, runId: run.id, ts: Date.now(), type: 'status' });
    await gate.wait();
    expect((await f.calls()).some(call => call.argv[0] === 'run' && call.argv.includes('spider.kind=subagent-viewer'))).toBe(true);
    const cli = f.h.cli; let firstInventory = true;
    f.h.cli = async (args, side) => {
      const result = await cli(args, side);
      if (firstInventory && side === 'local' && args[0] === 'ls') {
        firstInventory = false;
        await vi.waitFor(async () => {
          const listed = await cli(['ls', '--all', '--json']) as { terminals: { labels: Record<string, string> }[] };
          const calls = await f.calls();
          expect(listed.terminals.some(row => row.labels['spider.kind'] === 'subagent-viewer') || calls.some(call => call.argv[0] === 'rm')).toBe(true);
        }, { timeout: 10000 });
      }
      return result;
    };
    closing = true;
    const closed = f.close();
    await new Promise<void>(resolve => setImmediate(resolve));
    gate.release();
    await closed;
    expect(f.h.cleanupProof).toMatchObject({ remaining: [], observed: { localTerminals: [], remoteTerminals: [], machines: [] } });
  } finally { gate.release(); await gate.close(); if (!closing) await f.close(); }
}, 30000);

it('closes cleanly when an explicit viewer open is in flight during quit', async () => {
  const f = await mountedFixture('fake', 'rpc', false);
  const gate = await gateLaunch(f);
  let closing = false;
  try {
    const run = f.store.create({ sessionId: f.owner!.sessionId, agent: 'worker', name: 'Sample Run' });
    f.store.start(run.id);
    const opening = f.ipc!.openRun(run.id as never).catch(() => null);
    await gate.wait();
    expect((await f.calls()).some(call => call.argv[0] === 'run' && call.argv.includes('spider.kind=subagent-viewer'))).toBe(true);
    const cli = f.h.cli; let firstInventory = true;
    f.h.cli = async (args, side) => {
      const result = await cli(args, side);
      if (firstInventory && side === 'local' && args[0] === 'ls') {
        firstInventory = false;
        await vi.waitFor(async () => {
          const listed = await cli(['ls', '--all', '--json']) as { terminals: { labels: Record<string, string> }[] };
          const calls = await f.calls();
          expect(listed.terminals.some(row => row.labels['spider.kind'] === 'subagent-viewer') || calls.some(call => call.argv[0] === 'rm')).toBe(true);
        }, { timeout: 10000 });
      }
      return result;
    };
    closing = true;
    const closed = f.close();
    await new Promise<void>(resolve => setImmediate(resolve));
    gate.release();
    await closed;
    await opening;
    expect(f.h.cleanupProof).toMatchObject({ remaining: [], observed: { localTerminals: [], remoteTerminals: [], machines: [] } });
  } finally { gate.release(); await gate.close(); if (!closing) await f.close(); }
}, 30000);

it('keeps the resulting viewer when an explicit open is in flight during reload', async () => {
  const f = await mountedFixture('fake', 'rpc', false, false, true, true);
  const gate = await gateLaunch(f);
  try {
    const run = f.store.create({ sessionId: f.owner!.sessionId, agent: 'worker', name: 'Sample Run' });
    f.store.start(run.id);
    const opening = f.ipc!.openRun(run.id as never).catch(() => null);
    await gate.wait();
    expect((await f.calls()).some(call => call.argv[0] === 'run' && call.argv.includes('spider.kind=subagent-viewer'))).toBe(true);
    const shutdown = f.emit('session_shutdown', { reason: 'reload' });
    await new Promise<void>(resolve => setImmediate(resolve));
    gate.release();
    await shutdown;
    const opened = await opening;
    expect(opened).toMatchObject({ ok: true, op: 'openRun' });
    if (!opened?.ok || opened.op !== 'openRun') throw new Error('Viewer did not open');
    expect(await f.h.hc.get(opened.viewer)).toMatchObject({ state: 'live', labels: { 'spider.kind': 'subagent-viewer', 'spider.run': run.id } });
    expect((await f.calls()).filter(call => ['kill', 'rm'].includes(call.argv[0]) && call.argv[1] === opened.viewer)).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally { gate.release(); await gate.close(); await f.close(); }
  expect(f.h.cleanupProof).toMatchObject({ remaining: [], observed: { localTerminals: [], remoteTerminals: [], machines: [] } });
}, 30000);
