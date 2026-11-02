// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import { createClientFixture } from './testutil.js';
import { createSessionIpcClient } from '../feed/ipc-client.js';
import type { IpcDescriptor, Owner, RunCursor, RunId, SessionId } from '../contracts.js';

test.each([false, true])('a suspended real owner resumes its viewer without replay or resend (pending placement: %s)', async pendingPlacement => {
  const f = await createClientFixture();
  const directory = join(f.root, 'owner-js');
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: {
    target: 'node22', outDir: directory, ssr: fileURLToPath(new URL('./herdr-viewer-suspend-owner.fixture.ts', import.meta.url)),
    rollupOptions: { external: id => builtins.has(id) || id === 'better-sqlite3', output: { format: 'es', entryFileNames: 'owner.mjs', codeSplitting: false } },
  } });
  const sessionId = 'suspend-owner' as SessionId;
  const runId = '10000000-0000-4000-8000-000000000001' as RunId;
  const owner = { sessionId, generation: 'activation', terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: f.localSocket, sessionNamespace: 'fixture' }, cwd: f.root, sessionFile: null, name: null } as Owner;
  const worker = fork(join(directory, 'owner.mjs'), [], { env: { ...process.env, HERDR_VIEWER_OWNER: JSON.stringify({ owner, root: f.root, runId }) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
  const cursors: (RunCursor | null)[] = [], steers: { text: string; count: number }[] = [];
  let errors = ''; worker.stderr!.on('data', b => { errors += b.toString(); });
  const ready = new Promise<IpcDescriptor>((resolve, reject) => {
    worker.once('error', reject); worker.once('exit', code => reject(new Error(`Owner exited: ${code}: ${errors}`)));
    worker.on('message', (message: { type: string; descriptor: IpcDescriptor; cursor: RunCursor | null; text: string; count: number }) => {
      if (message.type === 'ready') resolve(message.descriptor);
      if (message.type === 'attached') cursors.push(message.cursor);
      if (message.type === 'steer') steers.push({ text: message.text, count: message.count });
    });
  });
  let viewer: ChildProcess | undefined, viewerExited: Promise<void> | undefined;
  let text = '', diagnostics = '', placementPending = false, placementFailed = false;
  worker.on('message', (message: { type: string }) => {
    if (message.type === 'placement-pending') placementPending = true;
    if (message.type === 'placement-failed') placementFailed = true;
  });
  const clients: ReturnType<typeof createSessionIpcClient>[] = [];
  try {
    const descriptor = await ready;
    viewer = fork(join(directory, 'owner.mjs'), [], { env: { ...process.env, HERDR_VIEWER_MODE: 'viewer', HERDR_VIEWER_OWNER: JSON.stringify({ owner, root: f.root, runId }) }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    viewerExited = new Promise<void>(resolve => viewer!.once('exit', () => resolve()));
    viewer.stdout!.on('data', b => { text += b.toString(); }); viewer.stderr!.on('data', b => { diagnostics += b.toString(); });
    await expect.poll(() => text, { timeout: 5000 }).toContain('BEFORE_SUSPEND');
    if (pendingPlacement) {
      worker.send({ type: 'place', viewerPid: viewer.pid });
      await expect.poll(() => placementPending).toBe(true);
    }
    worker.kill('SIGSTOP'); viewer.stdin!.write('One original steer, never resend it.\n');
    await expect.poll(() => text, { timeout: 28000 }).toContain('delivery unknown');
    worker.kill('SIGCONT');
    const probe = createSessionIpcClient(descriptor); clients.push(probe);
    expect(await probe.ping()).toMatchObject({ ok: true, op: 'ping' });
    await expect.poll(() => steers, { timeout: 3000 }).toEqual([{ text: 'One original steer, never resend it.', count: 1 }]);
    if (pendingPlacement) await expect.poll(() => placementFailed, { timeout: 3000 }).toBe(true);
    await expect.poll(() => text, { timeout: 5000 }).toContain('[reconnected]');
    worker.send({ type: 'output' });
    await expect.poll(() => text, { timeout: 5000 }).toContain('UNKNOWN_STEER_APPLIED');
    expect(text.match(/BEFORE_SUSPEND/g)).toHaveLength(1);
    expect(text.match(/UNKNOWN_STEER_APPLIED/g)).toHaveLength(1);
    expect(cursors).toEqual([null, '1']);
    expect(diagnostics).toBe('');
    worker.send({ type: 'finish' }); await viewerExited;
    expect(viewer.exitCode).toBe(0); expect(steers).toHaveLength(1);
  } finally {
    worker.kill('SIGCONT');
    if (viewer && viewer.exitCode === null) {
      viewer.kill('SIGTERM'); await Promise.race([viewerExited, delay(1000)]);
      if (viewer.exitCode === null) { viewer.kill('SIGKILL'); await viewerExited; }
    }
    for (const client of clients) client.dispose();
    if (worker.connected) worker.send({ type: 'stop' });
    await Promise.race([exited, delay(1000)]);
    if (worker.exitCode === null) { worker.kill('SIGKILL'); await exited; }
    await f.close();
  }
}, 45000);
