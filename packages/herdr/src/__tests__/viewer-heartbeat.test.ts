// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { runViewer, type ViewerStreamClient } from '../viewers/program.js';
import type { RunId, RunCursor, SessionFeed } from '../contracts.js';

test('a viewer attaches to a heartbeating owner without rewriting old session content', async () => {
  const parent = resolve('.spider/scratch/h'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'viewer-hb-')), sessionId = 'planner' as SessionFeed['sessionId'], runId = '10000000-0000-4000-8000-000000000001' as RunId;
  const run: SessionFeed['runs']['rows'][number] = { id: runId, ownerSessionId: sessionId, name: 'Worker', status: 'running', childMode: 'rpc', canSteer: true, startedAt: 1, finishedAt: null, viewer: null, result: null };
  const feed: SessionFeed = { version: 1, sessionId, generation: 'g' as never, revision: 1, updatedAt: 1000,
    owner: { sessionId, generation: 'g' as never, terminal: { coreId: 'fixture' as never, terminalId: 't1' as never, address: 't1' as never, socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: 'Planner' },
    lifecycle: 'live', placement: null, status: { native: 'working', effective: 'working', message: null }, runs: { rows: [run], total: 1, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'session', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: null },
    approvals: [], notifications: [], errors: [], ipc: { address: '/fixture/ipc.sock', capabilityFile: '/fixture/capability' } };
  const directory = join(root, 'sessions', sessionId); await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'session.json'), before = JSON.stringify(feed); await writeFile(file, before, { mode: 0o600 });
  await writeFile(join(directory, 'heartbeat.json'), JSON.stringify({ version: 1, sessionId, generation: 'g', updatedAt: 60000 }), { mode: 0o600 });
  const output = new PassThrough(), input = new PassThrough(), abort = new AbortController(); let text = '', attempts = 0;
  output.on('data', bytes => { text += String(bytes); });
  const client: ViewerStreamClient = { subscribeRun: async (_run, _cursor, emit) => { attempts++; emit({ runId, cursor: 'heartbeat-cursor' as RunCursor, kind: 'snapshot', data: { run } }); return { closed: new Promise(() => {}), dispose() {} }; } };
  const running = runViewer({ runId, sessionId, feedRoot: root, stdin: input, stdout: output, signal: abort.signal, clock: () => 60000, createClient: () => client });
  try {
    await expect.poll(() => attempts, { timeout: 1000 }).toBe(1);
    expect(text).not.toContain('reconnecting');
    expect(await readFile(file, 'utf8')).toBe(before);
  } finally { abort.abort(); await running; await rm(root, { recursive: true, force: true }); }
});
