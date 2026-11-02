// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { connect, createServer, type Socket } from 'node:net';
import { createViewerLauncher } from '../../viewers/register.js';
import { openDbAt } from '@spider/db-core';
import { scratchDbPath } from '@spider/db-core/testutil';
import { RunStore } from '../../../../subagents/src/run-store.js';
import { defaultSpawner } from '../../../../subagents/src/spawn-default.js';
import { registerChild, unregisterChild } from '../../../../subagents/src/coordinators.js';
import { makeMessageHandler } from '../../../../subagents/src/actions/message.js';
import { submitViewerSteer } from '../../viewers/steering.js';
import type { RunId, TerminalAddress, SessionFeed } from '../../contracts.js';
import type { HerdrHarness } from '../testutil.js';
import type { ViewerSteerClient } from '../../viewers/steering.js';

async function bounded<T>(promise: Promise<T>, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`RPC fixture did not reach ${name}`)), 15000); })]); }
  finally { clearTimeout(timer); }
}
export async function exerciseOwnedRpcSteer(root: string, sessionId: string, environment: NodeJS.ProcessEnv = process.env): Promise<{ runId: RunId; dbPath: string; sessionFile: string }> {
  mkdirSync(root, { recursive: true });
  const agent = join(root, 'agent'), home = join(root, 'home'), global = join(root, 'global');
  for (const path of [agent, home, global]) mkdirSync(path, { recursive: true });
  const release = join(root, 'release'); writeFileSync(release, 'hold');
  const db = openDbAt(scratchDbPath('acceptance-viewer-rpc'), 'worktree'); const store = new RunStore(db);
  const runId = store.create({ sessionId, agent: 'worker' }).id as RunId; store.start(runId); store.setLaunch(runId, { childMode: 'rpc' });
  const sessionFile = join(root, 'subagent-sessions', runId, runId + '.jsonl'); mkdirSync(dirname(sessionFile), { recursive: true });
  let ready!: () => void; let queued!: () => void;
  const streaming = new Promise<void>(resolve => { ready = resolve; }); const queuedInput = new Promise<void>(resolve => { queued = resolve; });
  const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
  const env: NodeJS.ProcessEnv = { ...environment, HOME: home, PI_CODING_AGENT_DIR: agent, SPIDER_GLOBAL_ROOT: global, STEER_RELEASE_FILE: release, PI_TELEMETRY: '0', TMPDIR: root };
  for (const key of Object.keys(env)) if (key.startsWith('HC_') || key.startsWith('HERDR_') || key.startsWith('PI_SUBAGENT_') || key.startsWith('PI_SPIDER_')) delete env[key];
  const handle = defaultSpawner({ argv: [process.execPath, join(piRoot, 'dist/cli.js'), '--offline', '--mode', 'rpc', '--session', sessionFile,
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-builtin-tools', '--provider', 'spider-offline', '--model', 'fixture',
    '-e', fileURLToPath(new URL('../../../../subagents/src/__tests__/helpers/offline-steer-extension.ts', import.meta.url))],
    cwd: root, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)), childMode: 'rpc', prompt: 'Initial offline task',
    onRpcEvent: event => { if (event.type === 'message_start' && event.message?.role === 'assistant') ready(); if (event.type === 'queue_update' && event.steering?.includes('Use case B')) queued(); },
  });
  registerChild(sessionId, runId, handle);
  let parentDraft = 'half-written prompt';
  const handler = makeMessageHandler();
  const client: ViewerSteerClient = { steerRun: async (id, text) => ({ ok: true, op: 'steerRun', acknowledgement: (await handler({ to: id, message: text }, { db, sessionId, ui: { setEditorText: (text: string) => { parentDraft = text; } } })).details }) };
  try {
    await bounded(streaming, 'assistant stream');
    const submitted = submitViewerSteer(client, runId, 'Use case B');
    await bounded(queuedInput, 'queued composer input'); writeFileSync(release, 'release');
    expect(await bounded(submitted, 'observed delivery')).toMatchObject({ accepted: true, delivered: true, delivery: 'delivered' });
    expect(await bounded(handle.wait(), 'child exit')).toEqual({ exitCode: 0 });
    const messages = readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(record => record.type === 'message' && record.message?.role === 'user')
      .flatMap(record => record.message.content.filter((content: { type: string }) => content.type === 'text').map((content: { text: string }) => content.text));
    expect(messages.filter(text => text === 'Use case B')).toEqual(['Use case B']);
    store.finish(runId, { status: 'done', result: 'offline report' });
    expect(await submitViewerSteer(client, runId, 'Raced instruction')).toMatchObject({ accepted: false, delivery: 'refused' });
    expect(parentDraft).toBe('half-written prompt');
    return { runId, dbPath: db.raw.name, sessionFile };
  } finally {
    unregisterChild(sessionId, runId); await handle.killAsync?.(25); await bounded(handle.wait(), 'cleanup'); db.close();
  }
}
async function exerciseExternalViewer(h: HerdrHarness, runId: RunId): Promise<TerminalAddress> {
  const root = join(h.root, 'viewer-js'); mkdirSync(root, { mode: 0o700 });
  // Bundle the actual module with the same external dependencies as the shipped viewer.
  await build({ configFile: resolve('vite.herdr.config.mjs'), mode: 'viewer', logLevel: 'silent',
    build: { ssr: fileURLToPath(new URL('../../viewers/program.ts', import.meta.url)), outDir: root, emptyOutDir: false,
      rollupOptions: { output: { entryFileNames: 'program.mjs' } } } });
  const entry = join(root, 'viewer.mjs'); const inputSocket = join(h.root, 'input.sock');
  writeFileSync(entry, `import {runViewer} from './program.mjs';
import {connect,createServer} from 'node:net'; import {StringDecoder} from 'node:string_decoder'; import {PassThrough} from 'node:stream'; import {chmodSync} from 'node:fs';
const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1],stdin=new PassThrough();stdin.isTTY=true;
const input=createServer(socket=>socket.once('data',bytes=>{stdin.write(bytes);socket.end('ok');}));
await new Promise(resolve=>input.listen(${JSON.stringify(inputSocket)},()=>{chmodSync(${JSON.stringify(inputSocket)},0o600);resolve();}));
try { await runViewer({runId:arg('--run'),sessionId:arg('--session'),feedRoot:arg('--feed-root'),stdout:process.stdout,stdin,createClient:d=>({
 async subscribeRun(runId,cursor,emit){const socket=connect(d.address),decoder=new StringDecoder('utf8');let pending='';const closed=new Promise(r=>socket.once('close',r));
 socket.on('data',b=>{pending+=decoder.write(b);let lf;while((lf=pending.indexOf('\\n'))>=0){const line=pending.slice(0,lf);pending=pending.slice(lf+1);emit(JSON.parse(line));}});
 await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});socket.on('error',()=>{});socket.write(JSON.stringify({runId,cursor})+'\\n');return {closed,dispose:()=>socket.destroy()};}
})}); } finally { await new Promise(resolve=>input.close(resolve)); }\n`);
  const feedRoot = join(h.directories.global, 'herdr'); const directory = join(feedRoot, 'sessions', h.owner!.sessionId); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'session.json'); const socketPath = join(h.root, 'v.sock'); const capabilityFile = join(h.root, 'viewer-cap'); writeFileSync(capabilityFile, '0'.repeat(64), { mode: 0o600 });
  const run = { id: runId, ownerSessionId: h.owner!.sessionId, name: null, status: 'done' as const, childMode: 'rpc' as const, canSteer: false, startedAt: null, finishedAt: Date.now(), viewer: null, result: 'offline report' };
  const feed: SessionFeed = { version: 1, sessionId: h.owner!.sessionId, generation: h.owner!.generation, revision: 1, updatedAt: Date.now(), owner: h.owner!, placement: null,
    lifecycle: 'live', status: { native: null, effective: null, message: null }, runs: { rows: [run], total: 1, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'offline fixture' }, approvals: [], notifications: [], ipc: { address: socketPath, capabilityFile }, errors: [] };
  writeFileSync(path, JSON.stringify(feed), { mode: 0o600 });
  const sockets = new Set<Socket>(); const cursors: unknown[] = [];
  const first = { runId, cursor: '1', kind: 'event', data: { text: 'first\n\u001b]7501;state=error', events: [] } };
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); let input = '';
    socket.on('data', chunk => { input += chunk.toString('utf8'); if (!input.includes('\n')) return;
      const request = JSON.parse(input.split('\n')[0]); cursors.push(request.cursor);
      socket.write(JSON.stringify({ runId, cursor: request.cursor ?? '0', kind: 'snapshot', data: { run } }) + '\n');
      socket.write(JSON.stringify(first) + '\n');
      if (request.cursor !== null) { socket.write(JSON.stringify({ runId, cursor: '2', kind: 'event', data: { text: '\u0007second 漢字\n', events: [] } }) + '\n'); socket.write(JSON.stringify({ runId, cursor: '2', kind: 'end', data: { reason: 'finished' } }) + '\n'); }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { chmodSync(socketPath, 0o600); resolve(); }); });
  const launcher = createViewerLauncher({ owner: () => h.owner, hc: h.hc, feedRoot, viewerExecutable: entry,
    ipcDescriptor: () => ({ version: 1, sessionId: feed.sessionId, generation: feed.generation, address: socketPath, capabilityFile }) });
  try {
    const address = await launcher(runId, h.owner!); expect(await launcher(runId, h.owner!)).toBe(address);
    await expect.poll(() => h.hc.read(address, { lines: 100 }), { timeout: 10000 }).toContain('second 漢字');
    const screen = await h.hc.read(address, { lines: 100 }); expect(screen.match(/first/g)).toHaveLength(1); expect(screen).not.toContain('\\u001b]7501');
    expect(cursors).toEqual([null, '1']);
    const terminal = await h.hc.get(address); expect(terminal.parent).toBe(h.owner!.terminal.address); expect(terminal.labels['spider.run']).toBe(runId); expect(terminal.labels['spider.kind']).toBe('subagent-viewer'); expect(terminal.status?.state).not.toBe('error');
    writeFileSync(path, JSON.stringify({ ...feed, revision: 2, lifecycle: 'closed', ipc: null, updatedAt: Date.now() }));
    await expect.poll(() => h.hc.read(address, { lines: 100 }), { timeout: 10000 }).toContain('Owning session closed. Saved log is read-only.');
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect((await h.hc.get(address)).state).toBe('live');
    const input = (text: string) => new Promise<void>((resolve, reject) => {
      const socket = connect(inputSocket); socket.once('error', reject); socket.once('connect', () => socket.write(text)); socket.resume(); socket.once('end', resolve);
    });
    await input('Do not send this steer\n');
    await expect.poll(() => h.hc.read(address, { lines: 100 }), { timeout: 10000 }).toContain('[refused] The owning session is closed. Saved log is read-only.');
    await input('\u0003');
    await expect.poll(async () => (await h.hc.get(address)).state, { timeout: 10000 }).toBe('finished');
    expect((await h.hc.get(address)).exitCode).toBe(0);
    return address;
  } finally {
    for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
export async function acceptanceF(h: HerdrHarness): Promise<void> {
  if (!h.owner) throw new Error('Start the isolated harness before acceptanceF');
  const artifacts = await exerciseOwnedRpcSteer(join(h.root, 'viewer-rpc'), h.owner.sessionId, h.localEnv);
  expect(await exerciseExternalViewer(h, artifacts.runId)).not.toBeNull();
}
