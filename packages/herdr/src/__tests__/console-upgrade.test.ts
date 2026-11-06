// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { parseRuntimePublication } from '../remote/runtime.js';
import type { HcClient, JobHandle, JobPort, MachineName, RunId } from '../contracts.js';
import { ensureAgentConsole, startWithAgentConsole, type AgentConsoleLaunch } from '../remote/console.js';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { createRemoteTestFixture } from './acceptance/c.js';

const harnesses: HerdrHarness[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const h of harnesses.splice(0)) {
    await h.close();
    expect(await h.remainingOwnedResources()).toEqual([]);
  }
});

async function fixture() {
  const h = await createHerdrHarness('fake'); harnesses.push(h); await h.start();
  const remote = await createRemoteTestFixture(h);
  const on = 'remote.invalid' as MachineName;
  const target = await remote.ports.target(on, h.owner!);
  let idle = true;
  const errors: unknown[] = [];
  const request = { owner: h.owner!, on, target, source: { kind: 'code', language: 'shell', code: 'echo ready' },
    isConsoleIdle: async () => idle, reportError: (error: unknown) => { errors.push(error); } } as AgentConsoleLaunch;
  const seed = async (runtime?: string, run?: string, kind = 'remote-console', ownerLabels: Record<string, string> = {}) => h.hc.run({
    argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on, background: true, outliveParent: true, noNotify: true,
    labels: { 'spider.kind': kind, 'spider.session': h.owner!.sessionId, 'spider.machine': on,
      'spider.owner-core': h.owner!.terminal.coreId, 'spider.owner-terminal': h.owner!.terminal.terminalId,
      ...(runtime ? { 'spider.runtime': runtime } : {}), ...(run ? { 'spider.run': run } : {}), ...ownerLabels },
  });
  const ensure = (hc: HcClient = h.hc, env = h.localEnv) => ensureAgentConsole(request, hc, env);
  const calls = async () => (await h.calls()).filter(call => call.argv[0] === 'run' && call.argv.includes('spider.kind=remote-console'));
  return { h, request, seed, ensure, calls, errors, setIdle: (value: boolean) => { idle = value; } };
}

it.each([undefined, 'older-runtime'])('replaces an idle console with runtime %s', async runtime => {
  const f = await fixture(); const old = await f.seed(runtime);
  const current = await f.ensure();
  expect(current!.address).not.toBe(old.address);
  await expect(f.h.hc.get(old.address)).rejects.toMatchObject({ code: 'not_found' });
  expect((await f.h.hc.get(current!.address)).labels['spider.runtime']).toBe(f.request.target.runtimeSha256);
  expect(await f.calls()).toHaveLength(2);
}, 30000);

it.each(['spider.owner-core', 'spider.owner-terminal'])('reuses an older console with a different %s', async label => {
  const f = await fixture(); const old = await f.seed('older-runtime', undefined, 'remote-console', { [label]: 'other-owner' });
  expect((await f.ensure())!.address).toBe(old.address);
  expect((await f.h.hc.get(old.address)).state).toBe('live');
  expect(f.errors).toEqual([]);
}, 30000);

it('reuses a console labelled with the current runtime', async () => {
  const f = await fixture(); const old = await f.seed(f.request.target.runtimeSha256);
  const current = await f.ensure();
  expect(current!.address).toBe(old.address);
  expect((await f.h.hc.get(current!.address)).state).toBe('live');
  expect(await f.calls()).toHaveLength(1);
  const other = { ...f.request, owner: { ...f.request.owner, sessionId: 'other-session' as typeof f.request.owner.sessionId } };
  const fresh = await ensureAgentConsole(other, f.h.hc, f.h.localEnv);
  expect((await f.h.hc.get(fresh!.address)).labels['spider.runtime']).toBe(f.request.target.runtimeSha256);
}, 30000);

it('keeps an older console while a job runs and replaces it after the job finishes', async () => {
  const f = await fixture(); const old = await f.seed('older-runtime'); f.setIdle(false);
  expect((await f.ensure())!.address).toBe(old.address);
  f.setIdle(true); const current = await f.ensure();
  expect(current!.address).not.toBe(old.address);
  await expect(f.h.hc.get(old.address)).rejects.toMatchObject({ code: 'not_found' });
  expect(await f.calls()).toHaveLength(2);
}, 30000);

it('publishes the current command count before starting a replacement', async () => {
  const f = await fixture(); const first = await f.ensure();
  const job = { id: 'job-one' as JobHandle['id'], remoteDirectory: '/fixture/remote' } as JobHandle;
  await ensureAgentConsole({ ...f.request, job }, f.h.hc, f.h.localEnv);
  const next = await ensureAgentConsole({ ...f.request, target: { ...f.request.target, runtimeSha256: 'new-runtime' } }, f.h.hc, f.h.localEnv);
  const meta = parseRuntimePublication(await f.h.hc.fileRead(f.request.on, join(next!.directory, 'console.json')));
  expect(next!.address).not.toBe(first!.address);
  expect(meta.start).toBe(1);
}, 30000);

it('replaces a cached console when the target runtime changes', async () => {
  const f = await fixture(); const first = await f.ensure();
  const request = { ...f.request, target: { ...f.request.target, runtimeSha256: 'new-runtime' } };
  const current = await ensureAgentConsole(request, f.h.hc, f.h.localEnv);
  expect(current!.address).not.toBe(first!.address);
  expect((await f.h.hc.get(current!.address)).labels['spider.runtime']).toBe('new-runtime');
  await expect(f.h.hc.get(first!.address)).rejects.toMatchObject({ code: 'not_found' });
}, 30000);

it('serializes concurrent replacements into one new console', async () => {
  const f = await fixture(); const old = await f.seed('older-runtime');
  const [a, b] = await Promise.all([f.ensure(), f.ensure()]);
  expect(a!.address).not.toBe(old.address);
  expect(b!.address).toBe(a!.address);
  expect(await f.calls()).toHaveLength(2);
  await expect(f.h.hc.get(old.address)).rejects.toMatchObject({ code: 'not_found' });
}, 30000);

it('replaces session and run consoles independently without touching payloads', async () => {
  const f = await fixture(); const payload = await f.seed(undefined, undefined, 'exec');
  const top = await f.seed('older-runtime'); const child = await f.seed('older-runtime', 'run-one');
  const childEnv = { ...f.h.localEnv, PI_SUBAGENT_CHILD: '1', PI_SUBAGENT_RUN_ID: 'run-one' as RunId };
  const nextTop = await f.ensure();
  expect(nextTop!.address).not.toBe(top.address);
  expect((await f.h.hc.get(child.address)).state).toBe('live');
  const nextChild = await f.ensure(f.h.hc, childEnv);
  expect(nextChild!.address).not.toBe(child.address);
  expect(nextChild!.address).not.toBe(nextTop!.address);
  await expect(f.h.hc.get(payload.address)).resolves.toMatchObject({ state: 'live' });
  expect((await f.h.hc.get(nextChild!.address)).labels['spider.run']).toBe('run-one');
}, 30000);

it('holds concurrent admission until the first job is registered', async () => {
  const f = await fixture(); vi.stubEnv('HC_TERMINAL_ID', f.h.owner!.terminal.terminalId);
  vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  let release!: () => void, entered!: () => void, starts = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  const jobs: JobPort = { start: async () => {
    const number = ++starts;
    if (number === 1) { entered(); await gate; }
    return { id: `job-${number}` as JobHandle['id'], address: `remote.invalid/job-${number}` as JobHandle['address'], remoteDirectory: '/fixture/remote', localDirectory: '/fixture/local', finished: new Promise(() => {}), cancel: async () => {} };
  }, detach: async () => {}, toolReturned: async () => {}, consumeNotice: async () => {}, dispose() {} };
  const request = { ...f.request, jobs, hc: f.h.hc, program: async () => ({ directory: '/fixture/remote', argv: [], cwd: null, files: [], env: {} }), options: {} };
  const first = startWithAgentConsole(request); await firstEntered;
  const second = startWithAgentConsole(request);
  try { await delay(500); expect(starts).toBe(1); }
  finally { release(); await Promise.all([first, second]); }
  expect(starts).toBe(2);
}, 30000);

it('keeps an older console when idle state is unavailable', async () => {
  const f = await fixture(); const old = await f.seed('older-runtime');
  const request = { ...f.request, isConsoleIdle: async () => { throw new Error('state unavailable'); } };
  expect((await ensureAgentConsole(request, f.h.hc, f.h.localEnv))!.address).toBe(old.address);
  expect((await f.h.hc.get(old.address)).state).toBe('live');
  expect(f.errors).toHaveLength(1);
  expect(f.errors[0]).toMatchObject({ message: 'state unavailable' });
  expect(await f.calls()).toHaveLength(1);
  expect((await f.ensure())!.address).not.toBe(old.address);
}, 30000);

it.each([
  { label: 'spider.runtime', value: 'changed-runtime', reused: true },
  { label: 'spider.kind', value: 'exec', reused: false },
])('does not kill a console relabelled on $label before retirement', async ({ label, value, reused }) => {
  const f = await fixture(); const old = await f.seed('older-runtime');
  const hc: HcClient = { ...f.h.hc, get: async address => {
    const terminal = await f.h.hc.get(address);
    return address === old.address ? { ...terminal, labels: { ...terminal.labels, [label]: value } } : terminal;
  } };
  const current = await f.ensure(hc);
  expect(current!.address === old.address).toBe(reused);
  expect((await f.h.hc.get(old.address)).state).toBe('live');
  expect((await hc.get(old.address)).labels[label]).toBe(value);
  expect(f.errors).toEqual([]);
}, 30000);

it('replaces a console that disappears during retirement without reporting an error', async () => {
  const f = await fixture(); const old = await f.seed('older-runtime');
  const hc: HcClient = { ...f.h.hc, kill: async address => {
    await f.h.hc.kill(address); await f.h.hc.rm(address);
    throw Object.assign(new Error('not found'), { code: 'not_found' });
  } };
  const current = await f.ensure(hc);
  expect(current!.address).not.toBe(old.address);
  expect((await f.h.hc.get(current!.address)).state).toBe('live');
  expect(f.errors).toEqual([]);
}, 30000);

it('reports a failed replacement launch and still starts the job', async () => {
  const f = await fixture(); const old = await f.seed('older-runtime'); const failure = new Error('console launch failed');
  vi.stubEnv('HC_TERMINAL_ID', f.h.owner!.terminal.terminalId); vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  const hc: HcClient = { ...f.h.hc, run: async () => { throw failure; } };
  const handle: JobHandle = { id: 'job-one' as JobHandle['id'], address: 'remote.invalid/job-one' as JobHandle['address'], remoteDirectory: '/fixture/remote', localDirectory: '/fixture/local', finished: new Promise(() => {}), cancel: async () => {} };
  let started = 0;
  const jobs: JobPort & { consoleIdle: () => Promise<boolean>; consoleError: (error: unknown) => void } = {
    start: async prepare => { started++; expect((await prepare()).consoleDirectory).toBeUndefined(); return handle; },
    consoleIdle: async () => true, consoleError: error => { f.errors.push(error); },
    detach: async () => {}, toolReturned: async () => {}, consumeNotice: async () => {}, dispose() {},
  };
  const result = await startWithAgentConsole({ ...f.request, jobs, hc, program: async () => ({ directory: '/fixture/remote', argv: [], cwd: null, files: [], env: {} }), options: {} });
  expect(result).toBe(handle);
  expect(started).toBe(1);
  expect(f.errors).toEqual([failure]);
  await expect(f.h.hc.get(old.address)).rejects.toMatchObject({ code: 'not_found' });
}, 30000);

it('reports a failed kill and reuses the still-live console', async () => {
  const f = await fixture(); const old = await f.seed('older-runtime'); const failure = new Error('kill failed');
  const hc: HcClient = { ...f.h.hc, kill: async address => { if (address === old.address) throw failure; await f.h.hc.kill(address); } };
  expect((await f.ensure(hc))!.address).toBe(old.address);
  expect((await f.h.hc.get(old.address)).state).toBe('live');
  expect(f.errors).toEqual([failure]);
  expect(await f.calls()).toHaveLength(1);
}, 30000);

it('reports a failed removal and replaces the finished console', async () => {
  const f = await fixture(); const old = await f.seed('older-runtime'); const failure = new Error('remove failed');
  const hc: HcClient = { ...f.h.hc, rm: async address => { if (address === old.address) throw failure; await f.h.hc.rm(address); } };
  const current = await f.ensure(hc);
  expect(current!.address).not.toBe(old.address);
  expect((await f.h.hc.get(old.address)).state).toBe('finished');
  expect((await f.h.hc.get(current!.address)).state).toBe('live');
  expect(f.errors).toEqual([failure]);
  expect(await f.calls()).toHaveLength(2);
}, 30000);
