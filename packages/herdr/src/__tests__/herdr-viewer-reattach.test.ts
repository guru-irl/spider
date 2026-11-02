// SPDX-License-Identifier: MIT
import { expect, test, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Socket } from 'node:net';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, fork, type ChildProcess } from 'node:child_process';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { setTimeout as delay } from 'node:timers/promises';
import { createClientFixture } from './testutil.js';
import { runViewer } from '../viewers/program.js';
import { startSessionEndpoint, type SessionEndpoint } from '../feed/ipc-server.js';
import { createSessionIpcClient } from '../feed/ipc-client.js';
import { submitViewerSteer } from '../viewers/steering.js';
import { parseFeed } from '../../assets/shared/feed.js';
import type { IpcDescriptor, Owner, RunCursor, RunId, RunSummary, RunViewFrame, SessionFeed, SessionId } from '../contracts.js';

const runId = '10000000-0000-4000-8000-000000000001' as RunId;
const sessionId = 'reattach-owner' as SessionId;
const priorCursor = 'prior-output' as RunCursor, tailCursor = 'resumed-output' as RunCursor;
const instruction = 'One original steer, never resend it.';
type Story = 'same-epoch' | 'same-session-new-endpoint' | 'missing-feed-same-session' | 'replaced-session' | 'late-foreign-feed';

async function prove(story: Story) {
  const f = await createClientFixture();
  const input = Object.assign(new PassThrough(), { isTTY: true }), output = new PassThrough(), status = new PassThrough();
  let text = '', diagnostics = ''; output.on('data', b => { text += b.toString(); }); status.on('data', b => { diagnostics += b.toString(); });
  const abort = new AbortController(); let now = 1000, changed = () => {}, reads = 0, ending = false;
  let graceReached!: () => void, releaseGrace!: () => void;
  const grace = new Promise<void>(resolve => { releaseGrace = resolve; }), inGrace = new Promise<void>(resolve => { graceReached = resolve; });
  let release!: () => void; const resumed = new Promise<void>(resolve => { release = resolve; });
  const child = spawn(process.execPath, ['-e', 'const r=require("node:readline").createInterface({input:process.stdin});let n=0;r.on("line",line=>{console.log(JSON.stringify({instruction:line,count:++n}));console.log("UNKNOWN_STEER_APPLIED")})'], { cwd: f.root, stdio: ['pipe', 'pipe', 'pipe'] });
  let childText = ''; child.stdout.on('data', b => { childText += b.toString(); }); child.stdin.on('error', () => {});
  const childClosed = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const clients: ReturnType<typeof createSessionIpcClient>[] = [], endpoints: SessionEndpoint[] = [];
  const cursors: { sessionId: SessionId; cursor: RunCursor | null }[] = [], steers: string[] = [], backoffs: number[] = [];
  const publishers = new Set<(frame: RunViewFrame) => void>();
  let tail = ''; let resumedOwnerProcess: ChildProcess | undefined;
  const resumedOwnerSteers: string[] = [];
  const owner = (id = sessionId, generation = 'first'): Owner => ({ sessionId: id, generation: generation as Owner['generation'], terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: f.localSocket, sessionNamespace: 'fixture' } as Owner['terminal'], cwd: f.root, sessionFile: null, name: null });
  const summary = (id: SessionId): RunSummary => ({ id: id === sessionId ? runId : '20000000-0000-4000-8000-000000000002' as RunId, ownerSessionId: id, name: null, status: 'running', childMode: 'rpc', canSteer: true, startedAt: 1, finishedAt: null, result: null, viewer: null });
  const endpoint = async (o: Owner) => {
    const result = await startSessionEndpoint(o, {
      currentOwner: () => o, liveCapabilities: () => ({ native: 'working', effective: 'working' }),
      ownsRun: id => id === summary(o.sessionId).id,
      subscribeRun: (_id, cursor, emit) => {
        cursors.push({ sessionId: o.sessionId, cursor });
        emit({ runId, cursor: cursor ?? 'initial' as RunCursor, kind: 'snapshot', data: { run: summary(o.sessionId) } });
        if (cursor === null) emit({ runId, cursor: priorCursor, kind: 'event', data: { text: 'BEFORE_STEER\n', events: [] } });
        if (tail && cursor !== tailCursor) emit({ runId, cursor: tailCursor, kind: 'event', data: { text: tail, events: [] } });
        publishers.add(emit); return { dispose() { publishers.delete(emit); } };
      },
      steerRun: async (_id, value) => { steers.push(value); await resumed; child.stdin.write(value + '\n'); return { delivery: 'accepted but not confirmed', accepted: true, delivered: false, queued: true }; },
      openRun: () => null, openView() {}, ownsJob: () => false, openJob: () => null,
    }, f.root);
    endpoints.push(result); return result;
  };
  const externalEndpoint = async (o: Owner): Promise<SessionEndpoint> => {
    const directory = join(f.root, 'owner-js');
    const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
    await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: {
      target: 'node22', outDir: directory, ssr: fileURLToPath(new URL('./herdr-viewer-reattach-owner.fixture.ts', import.meta.url)),
      rollupOptions: { external: id => builtins.has(id) || id === 'better-sqlite3', output: { format: 'es', entryFileNames: 'owner.mjs', codeSplitting: false } },
    } });
    const worker = fork(join(directory, 'owner.mjs'), [], { env: { ...process.env, HERDR_FX5_VIEWER_OWNER: JSON.stringify({ owner: o, root: f.root, runId, tailCursor }) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    resumedOwnerProcess = worker;
    const closed = new Promise<void>(resolve => worker.once('exit', () => resolve()));
    const descriptor = await new Promise<IpcDescriptor>((resolve, reject) => {
      worker.once('error', reject); worker.once('exit', code => reject(new Error(`Resumed owner exited early: ${code}`)));
      worker.on('message', (message: { type: string; descriptor: IpcDescriptor; cursor: RunCursor | null; sessionId: SessionId; text: string }) => {
        if (message.type === 'ready') resolve(message.descriptor);
        if (message.type === 'attached') cursors.push({ sessionId: message.sessionId, cursor: message.cursor });
        if (message.type === 'unexpected-steer') resumedOwnerSteers.push(message.text);
      });
    });
    const result: SessionEndpoint = { descriptor, async dispose() {
      if (worker.connected) worker.send({ type: 'stop' });
      await Promise.race([closed, delay(1000)]); if (worker.exitCode === null) { worker.kill('SIGKILL'); await closed; }
    } };
    endpoints.push(result); return result;
  };
  const feed = (o: Owner, ep: SessionEndpoint): SessionFeed => ({ version: 1, sessionId: o.sessionId, generation: o.generation, revision: 1, updatedAt: now, owner: o,
    lifecycle: 'live', placement: null, status: { native: 'working', effective: 'working', message: null }, runs: { rows: [summary(o.sessionId)], total: 1, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' }, approvals: [], notifications: [], errors: [],
    ipc: { address: ep.descriptor.address, capabilityFile: ep.descriptor.capabilityFile } });
  const oldOwner = owner(), oldEndpoint = await endpoint(oldOwner); let value: SessionFeed | null = feed(oldOwner, oldEndpoint);
  // The original call really times out on a socket; no delivery acknowledgement is fabricated.
  const timeout = Socket.prototype.setTimeout;
  const spy = vi.spyOn(Socket.prototype, 'setTimeout').mockImplementation(function (this: Socket, ms: number, callback?: () => void) { return timeout.call(this, ms === 25000 ? 30 : ms, callback); });
  let running: Promise<void> | undefined;
  try {
    running = runViewer({ runId, sessionId, feedRoot: f.root, stdin: input, stdout: output, statusOutput: status, signal: abort.signal, clock: () => now,
      feedSource: { read: async () => { reads++; return parseFeed(JSON.stringify(value)); }, subscribe: listener => { changed = listener; return () => { changed = () => {}; }; } },
      createClient: descriptor => { const client = createSessionIpcClient(descriptor); clients.push(client); return client; }, submitSteer: (client, value) => submitViewerSteer(client, runId, value),
      wait: async ms => { backoffs.push(ms); if (ms === 2000 && ending) { graceReached(); await grace; } else await delay(ms); } });
    await expect.poll(() => text).toContain('BEFORE_STEER'); input.write(instruction + '\n');
    await expect.poll(() => diagnostics).toContain('delivery unknown'); expect(steers).toEqual([instruction]);
    publishers.clear(); now = 12000; if (story === 'missing-feed-same-session') value = null; changed(); await expect.poll(() => diagnostics).toContain('reconnecting');
    const offlineReads = reads;
    for (let i = 0; i < 20; i++) { changed(); await delay(5); }
    expect(reads - offlineReads).toBeLessThanOrEqual(1);
    const foreign = story === 'replaced-session' || story === 'late-foreign-feed';
    if (story === 'replaced-session') {
      await oldEndpoint.dispose(); value = { ...feed(oldOwner, oldEndpoint), lifecycle: 'closed', ipc: null, updatedAt: now }; changed();
    } else if (story !== 'same-epoch') {
      await oldEndpoint.dispose(); now = 43000; changed();
    }
    if (story !== 'same-epoch') await expect.poll(() => diagnostics, { timeout: 3000 }).toContain('Saved log is read-only');
    const beforeClients = clients.length;
    now = story === 'same-epoch' ? 13000 : 50000;
    const nextOwner = foreign ? owner('other-session' as SessionId, 'foreign') : story === 'same-epoch' ? oldOwner : owner(sessionId, 'resumed');
    const nextEndpoint = story === 'same-epoch' ? oldEndpoint : story === 'same-session-new-endpoint' ? await externalEndpoint(nextOwner) : await endpoint(nextOwner);
    value = feed(nextOwner, nextEndpoint); changed(); release();
    await expect.poll(() => childText).toContain('UNKNOWN_STEER_APPLIED');
    tail = childText;
    if (resumedOwnerProcess?.connected) resumedOwnerProcess.send({ type: 'tail', text: tail });
    for (const emit of publishers) emit({ runId, cursor: tailCursor, kind: 'event', data: { text: tail, events: [] } });
    if (foreign) {
      await delay(1200); input.write('A disconnected draft\n');
      await expect.poll(() => diagnostics).toContain('[refused]');
      expect(diagnostics.slice(diagnostics.lastIndexOf('[refused]'))).toContain('read-only');
      expect(clients).toHaveLength(beforeClients); expect(text).not.toContain('UNKNOWN_STEER_APPLIED');
      value = { ...feed(oldOwner, oldEndpoint), revision: 3 }; changed(); await delay(1200);
      expect(clients).toHaveLength(beforeClients); expect(steers).toEqual([instruction]);
    } else {
      await expect.poll(() => text, { timeout: 5000 }).toContain('UNKNOWN_STEER_APPLIED');
      expect(cursors.map(row => row.cursor)).toEqual([null, priorCursor]);
      expect(text.match(/BEFORE_STEER/g)).toHaveLength(1); expect(text.match(/UNKNOWN_STEER_APPLIED/g)).toHaveLength(1);
      expect(clients).toHaveLength(2);
      expect(await clients.at(-1)!.ping()).toMatchObject({ ok: true, op: 'ping' });
      if (story === 'same-session-new-endpoint') expect(resumedOwnerProcess!.pid).not.toBe(process.pid);
      ending = true; if (resumedOwnerProcess?.connected) resumedOwnerProcess.send({ type: 'finish' });
      for (const emit of publishers) emit({ runId, cursor: tailCursor, kind: 'end', data: { reason: 'finished' } });
      await inGrace; const endedReads = reads; changed(); await delay(1100); expect(reads).toBe(endedReads);
      releaseGrace(); await running;
    }
    expect(steers).toEqual([instruction]); expect(resumedOwnerSteers).toEqual([]); expect(childText.match(/"count":1/g)).toHaveLength(1);
    expect(backoffs.every(ms => ms > 0 && ms <= 2000)).toBe(true);
    await writeFile(join(process.cwd(), '.spider/scratch', `fx5-reattach-${story}-evidence.json`), JSON.stringify({ story, viewerPid: process.pid, resumedOwnerPid: resumedOwnerProcess?.pid, resumedOwnerSteers, endpoints: endpoints.map(ep => ep.descriptor), cursors, steers, childText, text, diagnostics, backoffs, reads }, null, 2));
  } finally {
    release(); releaseGrace(); abort.abort(); await running;
    let closedReads: number | null = null;
    if (running && !ending) { closedReads = reads; changed(); await delay(1100); }
    const finalReads = reads; spy.mockRestore();
    for (const client of clients) client.dispose(); for (const ep of endpoints) await ep.dispose();
    child.stdin.end(); await Promise.race([childClosed, delay(1000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await childClosed; }
    await f.close();
    const fixtureRemains = await access(f.root).then(() => true, () => false);
    await writeFile(join(process.cwd(), '.spider/scratch', `fx5-reattach-${story}-cleanup.json`), JSON.stringify({ fixtureRoot: f.root, fixtureRemains, child: { pid: child.pid, exitCode: child.exitCode, signal: child.signalCode }, owner: resumedOwnerProcess ? { pid: resumedOwnerProcess.pid, exitCode: resumedOwnerProcess.exitCode, signal: resumedOwnerProcess.signalCode } : null, readsStopped: closedReads === null || finalReads === closedReads }, null, 2));
    expect(fixtureRemains).toBe(false); if (closedReads !== null) expect(finalReads).toBe(closedReads);
  }
}

test.each<Story>(['same-epoch', 'same-session-new-endpoint', 'missing-feed-same-session', 'replaced-session', 'late-foreign-feed'])('S30 authenticated viewer recovery: %s', prove, 15000);
