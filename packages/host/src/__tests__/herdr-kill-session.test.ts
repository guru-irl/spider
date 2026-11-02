import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerShared, parkSession, releaseShared } from '../../../subagents/src/child-registry.js';
import { teardownSessionAsync } from '@spider/subagents';
import { processStartIdentity } from '../../../herdr/src/jobs/handoff.js';
import * as move from '../../../herdr/assets/agents/move.js';
import { mountedFixture } from './herdr-wiring-fixture.js';
import { createSessionIpcClient } from '../../../herdr/src/feed/ipc-client.js';
import { startSessionEndpoint } from '../../../herdr/src/feed/ipc-server.js';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it.each(['session', 'terminal'] as const)('stops independent children before killing the owning %s through its menu', async kind => {
  const f = await mountedFixture('fake');
  const log = join(f.h.root, 'session-child.log'); await writeFile(log, '');
  const leaf = `const fs=require('node:fs');const log=${JSON.stringify(log)};process.on('SIGTERM',()=>fs.appendFileSync(log,'child-term\\n'));fs.appendFileSync(log,'child-ready '+process.pid+'\\n');setInterval(()=>{},1000);`;
  const code = `const fs=require('node:fs');const {spawn}=require('node:child_process');const log=${JSON.stringify(log)};process.on('SIGTERM',()=>fs.appendFileSync(log,'parent-term\\n'));spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore'});fs.appendFileSync(log,'parent-ready '+process.pid+'\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
  const exited = new Promise<{ exitCode: number }>(resolve => child.once('exit', exitCode => resolve({ exitCode: exitCode ?? 1 })));
  const run = f.store.create({ sessionId: f.owner!.sessionId, agent: 'worker' }); f.store.start(run.id);
  let childPid = 0, stopped = false, killBeforeStop = false, liveDuringGrace = false, observedReason: string | undefined, rowAtStop: unknown;
  try {
    await vi.waitFor(async () => {
      const output = await readFile(log, 'utf8'); expect(output).toContain('parent-ready'); expect(output).toContain('child-ready');
      childPid = Number(/child-ready (\d+)/.exec(output)![1]);
    }, { timeout: 10000 });
    const dbPath = (f.db.prepare('PRAGMA database_list').all() as { file: string }[]).find(row => row.file)!.file;
    registerShared({ runId: run.id, sessionId: f.owner!.sessionId, dbPath, mode: 'rpc', survivable: true, handle: {
      durable: true, pid: child.pid, wait: () => exited,
      kill() { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} },
      async killAsync(graceMs = 250, reason) {
        // A durable handle records an authenticated stop before signalling its child.
        f.store.cancel(run.id, reason);
        observedReason = reason; rowAtStop = f.store.get(run.id);
        process.kill(-child.pid!, 'SIGTERM');
        await new Promise(resolve => setTimeout(resolve, graceMs));
        liveDuringGrace = processStartIdentity(child.pid!) !== null && processStartIdentity(childPid) !== null;
        killBeforeStop = (await f.calls()).some(call => call.argv[0] === 'kill' && call.argv.includes(f.owner!.terminal.address));
        try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
        await exited;
        await vi.waitFor(() => { expect(processStartIdentity(child.pid!)).toBeNull(); expect(processStartIdentity(childPid)).toBeNull(); }, { timeout: 10000 });
        stopped = true;
      },
    } });
    parkSession(f.owner!.sessionId);
    const target = { kind, terminal: f.owner!.terminal.address, ownsSession: true, descriptor: f.feed.ipc ? { version: 1, sessionId: f.feed.sessionId, generation: f.feed.generation, ...f.feed.ipc } : null };
    const requests: unknown[] = []; let prompt: any;
    const ports = {
      ipc: async (_descriptor: unknown, request: unknown) => {
        requests.push(request);
        const reply = await f.ipc!.request(request as Parameters<NonNullable<typeof f.ipc>['request']>[0]);
        expect(reply).toEqual({ ok: true, op: 'killSession' });
        if (!reply.ok) throw new Error(reply.message);
      },
      run() { throw new Error('The menu must not bypass the owning backend'); },
      confirm(spec: unknown) { prompt = spec; },
    };
    await move.killTarget(target, ports);
    if (kind === 'session') {
      expect(requests).toEqual([]); expect(stopped).toBe(false);
      expect(prompt.title).toBe('Kill session?');
      await move.stopSessionTarget(prompt.target, ports);
    }
    expect(requests).toEqual([{ op: 'killSession', generation: f.owner!.generation }]);
    expect(observedReason).toBe('Session explicitly killed from the pane menu.');
    expect(rowAtStop).toMatchObject({ status: 'cancelled', result: observedReason });
    expect(liveDuringGrace).toBe(true); expect(killBeforeStop).toBe(false); expect(stopped).toBe(true);
    const output = await readFile(log, 'utf8'); expect(output).toContain('parent-term'); expect(output).toContain('child-term');
    await vi.waitFor(async () => expect((await f.h.hc.get(f.owner!.terminal.address)).state).toBe('finished'), { timeout: 10000 });
    expect(f.errors).toEqual([]);
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
    await exited; await teardownSessionAsync(f.owner!.sessionId); releaseShared(run.id); await f.close();
  }
}, 30000);

it('refuses stale and unauthenticated session kills without stopping the owner', async () => {
  const f = await mountedFixture('fake'); let forged: ReturnType<typeof createSessionIpcClient> | undefined;
  try {
    const request = { op: 'killSession', generation: f.owner!.generation };
    expect(await f.ipc!.request({ ...request, generation: 'stale' } as never)).toMatchObject({ ok: false, code: 'wrong-generation' });
    const capabilityFile = join(f.h.root, 'wrong.cap'); await writeFile(capabilityFile, '0'.repeat(64), { mode: 0o600 });
    forged = createSessionIpcClient({ version: 1, sessionId: f.feed.sessionId, generation: f.feed.generation, ...f.feed.ipc, capabilityFile });
    expect(await forged.request(request as never)).toMatchObject({ ok: false, code: 'unauthorized' });
    for (const extra of [{ sessionId: 'another-session' }, { terminal: 'another-terminal' }])
      expect(await f.ipc!.request({ ...request, ...extra } as never)).toMatchObject({ ok: false, code: 'unauthorized' });
    expect((await f.h.hc.get(f.owner!.terminal.address)).state).toBe('live');
    expect((await f.calls()).some(call => call.argv[0] === 'kill')).toBe(false);
  } finally { forged?.dispose(); await f.close(); }
});

it('does not kill a replacement owner after the original session stop was awaited', async () => {
  const f = await mountedFixture('fake'); let current = f.owner, release = () => {}, entered = false, killed = false;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const endpoint = await startSessionEndpoint(f.owner!, {
    currentOwner: () => current, liveCapabilities: () => null, ownsRun: () => false,
    subscribeRun: () => ({ dispose() {} }), steerRun: () => { throw new Error('No run'); }, openView() {}, openRun: () => null,
    ownsJob: () => false, openJob: () => null,
    prepareSessionStop: async () => { entered = true; await waiting; }, killSessionTerminal: () => { killed = true; },
  }, join(f.config.globalRoot, 'k'));
  const client = createSessionIpcClient(endpoint.descriptor);
  try {
    const reply = client.request({ op: 'killSession', generation: f.owner!.generation } as never);
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 1000 });
    current = { ...f.owner!, generation: 'replacement' as never }; release();
    expect(await reply).toMatchObject({ ok: false, code: 'wrong-generation' }); expect(killed).toBe(false);
  } finally { release(); client.dispose(); await endpoint.dispose(); await f.close(); }
});
