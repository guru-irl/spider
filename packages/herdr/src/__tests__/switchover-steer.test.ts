// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ownRpcChild } from '../../../subagents/src/rpc-child.js';
import { waitForOwnedSteer } from '../../e2e/fixtures/steer-barrier.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

async function fixture() {
  const root = join(process.cwd(), '.spider/scratch');
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(join(root, 'r14-'));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.spider'));
  const db = new Database(join(cwd, '.spider/project.db'));
  cleanups.push(() => { db.close(); });
  db.exec('CREATE TABLE run_events (id INTEGER PRIMARY KEY, run_id TEXT, type TEXT, payload TEXT)');
  const target = { cwd, runId: 'old-run', message: 'R14 before switch' };
  const record = (event: Record<string, unknown>, runId = target.runId) => {
    db.prepare('INSERT INTO run_events (run_id,type,payload) VALUES (?,?,?)').run(runId, event.type, JSON.stringify(event));
  };
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const commands: { type: string; id: string; message?: string }[] = [];
  child.stdin.on('data', chunk => commands.push(JSON.parse(String(chunk))));
  const rpc = ownRpcChild(child as unknown as ChildProcess, 'initial task', record);
  cleanups.push(() => { child.emit('exit', 0); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  const out = (event: Record<string, unknown>) => child.stdout.write(JSON.stringify(event) + '\n');
  out({ type: 'response', command: 'prompt', id: commands[0].id, success: true });
  out({ type: 'agent_start' });
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  vi.useFakeTimers();
  const limit = { signal: controller.signal, expiresAt: Date.now() + 30_000 };
  return { target, record, child, commands, rpc, out, controller, limit };
}

it('refuses a delayed steer after the held turn settles instead of claiming delivery', async () => {
  const f = await fixture();
  // The owner tool has started, but dispatch to the child has not happened yet.
  f.out({ type: 'agent_settled' });
  expect(f.child.stdin.writableEnded).toBe(true);
  expect(await f.rpc.steer(f.target.message)).toMatchObject({ accepted: false, delivered: false, delivery: 'refused' });
  expect(f.commands.map(command => command.type)).toEqual(['prompt']);
});

it.each([false, true])('keeps the held turn open through delayed dispatch, after reload: %s', async reload => {
  const f = await fixture();
  if (reload) {
    f.target.message = 'R14 after switch';
    f.rpc.unbindEvents();
    f.rpc.bindEvents(f.record);
  }
  let queued = false;
  const conversation: string[] = [];
  const released = waitForOwnedSteer(f.target, f.limit, async () => true).then(() => {
    if (queued) {
      f.out({ type: 'queue_update', steering: [], followUp: [] });
      conversation.push(f.target.message);
      f.out({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: f.target.message }] } });
    }
    f.out({ type: 'agent_settled' });
  });
  const outcome = released.then(() => undefined, error => error);
  // Finish all work caused by the owner's tool-start event before dispatching.
  await vi.advanceTimersByTimeAsync(0);
  const steer = f.rpc.steer(f.target.message);
  const command = f.commands.find(command => command.type === 'steer');
  if (command) {
    queued = true;
    f.out({ type: 'queue_update', steering: [f.target.message], followUp: [] });
    f.out({ type: 'response', command: 'steer', id: command.id, success: true, data: { disposition: 'queued' } });
  }
  await vi.advanceTimersByTimeAsync(100);
  f.controller.abort();
  expect(await outcome).toBeUndefined();
  expect(await steer).toMatchObject({ accepted: true, delivered: true, delivery: 'delivered', observedText: f.target.message });
  expect(conversation).toEqual([f.target.message]);
});

it.each([
  { name: 'another run', event: { type: 'queue_update', steering: ['R14 before switch'], followUp: [] }, runId: 'other-run' },
  { name: 'another message', event: { type: 'queue_update', steering: ['R14 before switch extra'], followUp: [] } },
  { name: 'a follow-up', event: { type: 'queue_update', steering: [], followUp: ['R14 before switch'] } },
  { name: 'acceptance only', event: { type: 'steer_delivery', steer: 'R14 before switch', accepted: true, delivered: false } },
  { name: 'an empty queue', event: { type: 'queue_update', steering: [], followUp: [] } },
])('does not release on $name', async ({ event, runId }) => {
  const f = await fixture();
  f.record(event, runId);
  let released = false;
  const pending = waitForOwnedSteer(f.target, f.limit, async () => true).then(() => { released = true; });
  const outcome = pending.then(() => undefined, error => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(released).toBe(false);
  f.record({ type: 'queue_update', steering: [f.target.message], followUp: [] });
  await vi.advanceTimersByTimeAsync(100);
  f.controller.abort();
  expect(await outcome).toBeUndefined();
  expect(released).toBe(true);
});
