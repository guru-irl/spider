import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { mountedFixture, installFixtureRuntime } from './herdr-wiring-fixture.js';
import { processStartIdentity } from '../../../herdr/src/jobs/handoff.js';
import { killTarget, menuItems } from '../../../herdr/assets/agents/move.js';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('kills a live remote command through its owner without killing the observer instead', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  try {
    await installFixtureRuntime(f);
    const execution = f.mount.execution();
    const code = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>console.log('parent-term'));const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>console.log('child-term'));console.log('child-ready '+process.pid);setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});child.stdout.on('data',b=>process.stdout.write(b));console.log('parent-ready '+process.pid);setInterval(()=>{},1000)`;
    const job = await execution.remote!.execute({ owner: execution.owner!, on: 'remote.invalid' as never,
      source: { kind: 'code', language: 'javascript', code }, background: true, timeout: 100 });
    expect(job.outcome).toBe('timeout');
    let output = '';
    await vi.waitFor(async () => {
      output = await readFile(job.backgroundLogs!.stdout, 'utf8');
      expect(output).toContain('child-ready'); expect(output).toContain('parent-ready');
    }, { timeout: 30000, interval: 100 });
    const parentPid = Number(/parent-ready (\d+)/.exec(output)![1]);
    const childPid = Number(/child-ready (\d+)/.exec(output)![1]);
    const opened = await f.ipc!.openJob(job.remote.jobId as never);
    expect(opened).toMatchObject({ ok: true, op: 'openJob' });
    if (!opened.ok || opened.op !== 'openJob') throw new Error('Observer did not open');
    const descriptor = { sessionId: f.owner!.sessionId, generation: f.owner!.generation };
    const target = { kind: 'command' as const, key: job.remote.jobId, terminal: opened.viewer, descriptor, pane: true };
    expect(menuItems(target, [], null, null).find((item: any) => item.id === 'kill')).toMatchObject({ label: 'Kill command', disabled: false });
    const requests: unknown[] = [];
    await killTarget(target, {
      ipc: async (owner, request) => {
        expect(owner).toEqual(descriptor); requests.push(request);
        const reply = await f.ipc!.request(request as Parameters<NonNullable<typeof f.ipc>['request']>[0]);
        expect(reply).toEqual({ ok: true, op: 'killJob', jobId: job.remote.jobId });
        if (!reply.ok) throw new Error(reply.message);
      },
      run() { throw new Error('The menu must not kill the observer terminal'); },
      confirm() { throw new Error('A command is not a session'); },
    });
    expect(requests).toEqual([{ op: 'killJob', jobId: job.remote.jobId, generation: f.owner!.generation }]);
    await vi.waitFor(async () => {
      const log = await readFile(job.backgroundLogs!.stdout, 'utf8');
      expect(log).toContain('parent-term'); expect(log).toContain('child-term');
    }, { timeout: 10000, interval: 100 });
    await vi.waitFor(() => {
      expect(processStartIdentity(parentPid)).toBeNull();
      expect(processStartIdentity(childPid)).toBeNull();
    }, { timeout: 10000, interval: 100 });
    await vi.waitFor(async () => expect((await f.h.hc.get(job.remote.address!)).state).toBe('finished'), { timeout: 10000 });
    expect((await f.h.hc.get(opened.viewer)).state).toBe('live');
    await vi.waitFor(() => expect(f.notices).toContainEqual(expect.objectContaining({ customType: 'spider.job_done', details: expect.objectContaining({ reason: 'cancelled' }) })), { timeout: 60000, interval: 100 });
  } finally { await f.close(); }
}, 120000);
