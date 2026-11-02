// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent } from '@earendil-works/pi-coding-agent';
import type { JobHandle, JobId, MachineName, Owner, RunId } from '../contracts.js';
import type { AgentConsoleLaunch } from '../remote/console.js';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { createRemoteTestFixture } from './acceptance/c.js';
import * as consoleModule from '../remote/console.js';
const harnesses: HerdrHarness[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const h of harnesses.splice(0)) {
    const extra = (await h.hc.machines()).find(machine => machine.name === 'other.invalid');
    if (extra) await h.cli(['machine', 'rm', 'other.invalid', '--json']);
    await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
    await mkdir(resolve('.spider/scratch/agent-consoles'), { recursive: true });
    await writeFile(resolve(`.spider/scratch/agent-consoles/lifecycle-${h.mode}-cleanup.json`), JSON.stringify(h.cleanupProof, null, 2));
  }
});
type Launch = AgentConsoleLaunch;
function api() { return consoleModule; }
async function fixture(mode: 'fake' | 'hc' = 'fake') {
  const h = await createHerdrHarness(mode); harnesses.push(h); await h.start();
  const remote = await createRemoteTestFixture(h); let counter = 0;
  const launch = async (owner = h.owner!, on = 'remote.invalid' as MachineName): Promise<Launch> => {
    const target = { ...await remote.ports.target('remote.invalid' as MachineName, owner), on };
    const id = `job-${counter++}` as JobId; const dir = join(target.directory, id); await mkdir(dir);
    const job: JobHandle = { id, address: `remote.invalid/${id}` as JobHandle['address'], remoteDirectory: dir, localDirectory: join(h.directories.local, id), finished: new Promise(() => {}), cancel: async () => { throw new Error('Console must never cancel a payload'); } };
    return { owner, on, target, job, source: { kind: 'code', language: 'shell', code: `echo ${id}\necho later` }, startedAt: counter };
  };
  const remoteConsoles = async () => (await h.calls()).filter(call => call.argv[0] === 'run' && call.argv.includes('spider.kind=remote-console'));
  return { h, launch, remoteConsoles, remote };
}
it('creates one named, labelled remote console under parallel command launches', async () => {
  const { h, launch, remoteConsoles } = await fixture(); const module = api();
  const requests = await Promise.all(Array.from({ length: 8 }, () => launch({ ...h.owner!, name: 'Builder' })));
  const consoles = await Promise.all(requests.map(request => module.ensureAgentConsole(request, h.hc, h.localEnv)));
  expect(new Set(consoles.map(console => console?.address)).size).toBe(1);
  const calls = await remoteConsoles(); expect(calls).toHaveLength(1); const argv = calls[0].argv;
  expect(argv).toContain('--on'); expect(argv[argv.indexOf('--on') + 1]).toBe('remote.invalid'); expect(argv).toContain('--bg'); expect(argv).toContain('--no-notify'); expect(argv).toContain('--outlive-parent');
  const name = argv[argv.indexOf('--name') + 1]; expect(name).toMatch(/^[a-z0-9_-]{1,32}$/);
  expect(argv).not.toContain('--parent');
  expect((await h.hc.get(consoles[0]!.address)).labels).toMatchObject({ 'spider.kind': 'remote-console', 'spider.session': h.owner!.sessionId, 'spider.machine': 'remote.invalid' });
  expect((await h.hc.get(consoles[0]!.address)).labels['spider.display-name']).toBe('Builder @ remote.invalid');
  const directory = argv[argv.indexOf('--console') + 1]!;
  expect(JSON.parse(JSON.parse((await h.hc.fileRead('remote.invalid' as MachineName, join(directory, 'console.json'))).toString()).body)).toMatchObject({ title: 'Builder · remote.invalid' });
  expect(JSON.parse(JSON.parse((await h.hc.fileRead('remote.invalid' as MachineName, join(directory, 'head.json'))).toString()).body)).toMatchObject({ count: 8 });
  for (let index = 0; index < 8; index++) {
    const command = JSON.parse(JSON.parse((await h.hc.fileRead('remote.invalid' as MachineName, join(directory, `command-${index}.json`))).toString()).body);
    expect(command.command).toBe(`echo job-${index}`); expect(command.jobId).toBe(`job-${index}`);
  }
}, 20000);
it.skipIf(process.env.SPIDER_HERDR_E2E !== '1' || !existsSync(process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc')))('real isolated hc serializes parallel console creation (requires installed hc and SPIDER_HERDR_E2E=1)', async () => {
  const { h, launch } = await fixture('hc');
  const requests = await Promise.all(Array.from({ length: 8 }, () => launch()));
  const handles = await Promise.all(requests.map(request => consoleModule.ensureAgentConsole(request, h.hc, h.localEnv)));
  expect(new Set(handles.map(handle => handle!.address)).size).toBe(1);
  const terminal = await h.hc.get(handles[0]!.address);
  expect(terminal.labels).toMatchObject({ 'spider.kind': 'remote-console', 'spider.session': h.owner!.sessionId, 'spider.machine': 'remote.invalid' });
  const inventory = await h.cli(['ls', '--all', '--json'], 'remote') as { terminals: { address: string }[] };
  const rows = await Promise.all(inventory.terminals.map(row => h.remoteHc.get(row.address as JobHandle['address'])));
  expect(rows.filter(row => row.labels['spider.kind'] === 'remote-console')).toHaveLength(1);
}, 20000);
it('uses bounded deterministic slugs for long, unicode and space-containing agent names', async () => {
  const { h, launch, remoteConsoles } = await fixture(); const module = api();
  const names = ['A name with spaces', '代理 🚀 café', 'very-long-name-'.repeat(100)];
  for (let index = 0; index < names.length; index++) {
    const owner = { ...h.owner!, sessionId: `session-${index}` as Owner['sessionId'], name: names[index] };
    const request = await launch(owner);
    const first = await module.ensureAgentConsole(request, h.hc, h.localEnv);
    const second = await module.ensureAgentConsole(await launch(owner), h.hc, h.localEnv);
    expect(first!.address).toBe(second!.address);
    const title = JSON.parse(JSON.parse((await h.hc.fileRead('remote.invalid' as MachineName, join(first!.directory, 'console.json'))).toString()).body).title;
    expect(title.endsWith(' · remote.invalid')).toBe(true);
    expect((await h.hc.get(first!.address)).labels['spider.display-name']).toBe(names[index].slice(0, 512 - ' · remote.invalid'.length) + ' @ remote.invalid');
  }
  const calls = await remoteConsoles(); expect(calls).toHaveLength(3);
  const slugs = calls.map(call => call.argv[call.argv.indexOf('--name') + 1]);
  for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9_-]{1,32}$/);
  expect(new Set(slugs).size).toBe(3);
}, 20000);
it('separates child run identities and machine identities while using the child display name', async () => {
  const { h, launch, remoteConsoles } = await fixture(); const module = api();
  await h.cli(['machine', 'add', '--via', join(h.root, 'via'), '--name', 'other.invalid', '--session', 'r', '--json']);
  const top = await module.ensureAgentConsole(await launch(), h.hc, h.localEnv);
  const env = { ...h.localEnv, PI_SUBAGENT_CHILD: '1', PI_SUBAGENT_RUN_ID: 'run-one', PI_SUBAGENT_RUN_NAME: 'Reviewer' };
  const child = await module.ensureAgentConsole(await launch(), h.hc, env);
  const childOther = await module.ensureAgentConsole(await launch(h.owner!, 'other.invalid' as MachineName), h.hc, env);
  const otherRun = await module.ensureAgentConsole(await launch(), h.hc, { ...env, PI_SUBAGENT_RUN_ID: 'run-two', PI_SUBAGENT_RUN_NAME: 'Tester' });
  expect(new Set([top!.address, child!.address, childOther!.address, otherRun!.address]).size).toBe(4); expect(await remoteConsoles()).toHaveLength(4);
  expect((await h.hc.get(child!.address)).labels).toMatchObject({ 'spider.session': h.owner!.sessionId, 'spider.run': 'run-one', 'spider.machine': 'remote.invalid' });
  const childCall = (await remoteConsoles()).find(call => call.argv.includes('spider.run=run-one') && call.argv.includes('spider.machine=remote.invalid'))!;
  const metadata = JSON.parse(JSON.parse((await h.hc.fileRead('remote.invalid' as MachineName, join(childCall.argv[childCall.argv.indexOf('--console') + 1]!, 'console.json'))).toString()).body); expect(metadata.title).toBe('Reviewer · remote.invalid');
  expect(await Promise.all([child!, childOther!, otherRun!].map(async handle => (await h.hc.get(handle.address)).labels['spider.display-name']))).toEqual(['Reviewer @ remote.invalid', 'Reviewer @ other.invalid', 'Tester @ remote.invalid']);
  // Parent handoff after a killed child closes every console for that run only.
  await module.closeAgentConsoles({ ...h.owner!, runId: 'run-one' as RunId }, h.hc);
  await expect(h.hc.get(child!.address)).rejects.toMatchObject({ code: 'not_found' }); await expect(h.hc.get(childOther!.address)).rejects.toMatchObject({ code: 'not_found' });
  expect((await h.hc.get(top!.address)).state).toBe('live'); expect((await h.hc.get(otherRun!.address)).state).toBe('live');
  await module.closeAgentConsoles({ ...h.owner!, runId: 'run-one' as RunId }, h.hc); // idempotent handoff
}, 20000);
it('reuses a console found by labels rather than creating a duplicate after a fresh activation', async () => {
  const { h, launch, remoteConsoles } = await fixture(); const module = api(); const request = await launch();
  const existing = await h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: request.on, name: 'existing-console', labels: { 'spider.kind': 'remote-console', 'spider.session': h.owner!.sessionId, 'spider.machine': 'remote.invalid' }, noNotify: true, background: true, outliveParent: true });
  const found = await module.ensureAgentConsole(request, h.hc, h.localEnv);
  expect(found!.address).toBe(existing.address); expect(await remoteConsoles()).toHaveLength(1);
}, 20000);
it('keeps the console journal attached to agent identity when the owning core changes', async () => {
  const { h, launch } = await fixture(); const request = await launch();
  const first = await consoleModule.ensureAgentConsole(request, h.hc, h.localEnv);
  const movedOwner = { ...h.owner!, terminal: { ...h.owner!.terminal, coreId: 'reconnected-core' as Owner['terminal']['coreId'] } };
  const second = await consoleModule.ensureAgentConsole(await launch(movedOwner), h.hc, h.localEnv);
  expect(second!.address).toBe(first!.address); expect(second!.directory).toBe(first!.directory);
  const head = JSON.parse(JSON.parse((await h.hc.fileRead('remote.invalid' as MachineName, join(first!.directory, 'head.json'))).toString()).body); expect(head.count).toBe(2);
}, 20000);
it('drops a stale preparation hold link when no console was ensured', async () => {
  const { h, launch, remote } = await fixture(); const request = await launch();
  const prepared = await (await import('../../../context/src/remote-plan.js')).prepareRemoteProgram(request.source, request.target);
  const jobs: import('../contracts.js').JobPort = { ...remote.ports.jobs, start: async (program, ...rest) => { expect(program).not.toHaveProperty('consoleDirectory'); return remote.ports.jobs.start(program, ...rest); } };
  await consoleModule.startWithAgentConsole({ ...request, enabled: false, hc: h.hc, jobs, program: { ...prepared, consoleDirectory: join(request.target.directory, '.consoles', 'stale') }, options: {} });
}, 20000);
function events() {
  const callbacks = new Map<string, (event: SessionShutdownEvent, ctx: ExtensionContext) => unknown>();
  const pi = { on: (name: string, callback: (event: SessionShutdownEvent, ctx: ExtensionContext) => unknown) => { callbacks.set(name, callback); return () => callbacks.delete(name); } } as unknown as ExtensionAPI;
  return { pi, shutdown: async (reason: SessionShutdownEvent['reason']) => { await callbacks.get('session_shutdown')?.({ type: 'session_shutdown', reason }, {} as ExtensionContext); } };
}
it.each(['new', 'resume', 'fork', 'quit'] as const)('closes a top-level console at %s but preserves it on reload', async reason => {
  const { h, launch } = await fixture(); const module = api(); const console = await module.ensureAgentConsole(await launch(), h.hc, h.localEnv); const event = events();
  const registration = module.registerAgentConsoleLifecycle(event.pi, { hc: h.hc, currentOwner: () => h.owner, env: h.localEnv });
  await event.shutdown('reload'); expect((await h.hc.get(console!.address)).state).toBe('live');
  await event.shutdown(reason); await expect(h.hc.get(console!.address)).rejects.toMatchObject({ code: 'not_found' }); registration.dispose();
}, 20000);
it('the child owns normal-exit cleanup without using the top-level shutdown hook', async () => {
  const { h, launch } = await fixture(); const module = api(); const env = { ...h.localEnv, PI_SUBAGENT_CHILD: '1', PI_SUBAGENT_RUN_ID: 'normal-run', PI_SUBAGENT_RUN_NAME: 'Builder' };
  const console = await module.ensureAgentConsole(await launch(), h.hc, env); const topEvent = events(); const childEvent = events();
  const top = module.registerAgentConsoleLifecycle(topEvent.pi, { hc: h.hc, currentOwner: () => h.owner, env });
  await topEvent.shutdown('quit'); expect((await h.hc.get(console!.address)).state).toBe('live');
  const child = module.registerChildAgentConsoleLifecycle(childEvent.pi, { hc: h.hc, currentOwner: () => h.owner, env });
  await childEvent.shutdown('reload'); expect((await h.hc.get(console!.address)).state).toBe('live');
  await childEvent.shutdown('quit'); await expect(h.hc.get(console!.address)).rejects.toMatchObject({ code: 'not_found' }); top.dispose(); child.dispose();
}, 20000);
it('does nothing outside Herdr or when the Herdr integration is disabled', async () => {
  const { h, launch } = await fixture(); const module = api(); const before = await h.calls();
  expect(await module.ensureAgentConsole(await launch(), h.hc, {})).toBeNull();
  expect(await module.ensureAgentConsole({ ...await launch(), enabled: false }, h.hc, h.localEnv)).toBeNull();
  const event = events(); const registration = module.registerAgentConsoleLifecycle(event.pi, { hc: h.hc, currentOwner: () => null, env: h.localEnv }); await event.shutdown('quit'); registration.dispose();
  expect(await h.calls()).toEqual(before);
}, 20000);
