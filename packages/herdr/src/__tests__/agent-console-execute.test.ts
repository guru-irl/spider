// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { createRemoteTestFixture } from './acceptance/c.js';
import { executeRemote } from '../remote/execute.js';
import type { MachineName, RemoteExecuteRequest, TerminalAddress } from '../contracts.js';
const harnesses: HerdrHarness[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const h of harnesses.splice(0)) {
    await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
    await mkdir(resolve('.spider/scratch/agent-consoles'), { recursive: true });
    await writeFile(resolve(`.spider/scratch/agent-consoles/execute-${h.mode}-cleanup.json`), JSON.stringify(h.cleanupProof, null, 2));
  }
});
async function scenario(mode: 'fake' | 'hc') {
  const h = await createHerdrHarness(mode); harnesses.push(h); await h.start();
  vi.stubEnv('HC_TERMINAL_ID', h.owner!.terminal.terminalId);
  const fixture = await createRemoteTestFixture(h); const on = 'remote.invalid' as MachineName;
  const request = (code: string, options: Partial<RemoteExecuteRequest> = {}): RemoteExecuteRequest => ({ owner: { ...h.owner!, name: 'Builder' }, on, source: { kind: 'code', language: 'javascript', code }, ...options });
  const marker = join(h.directories.remote, 'finish');
  const first = await executeRemote(request(`console.log('first output');const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);console.log('finished independently');process.exitCode=17}},25)`, { background: true, timeout: 1 }), fixture.ports);
  expect(first.backgrounded).toBe(true);
  const second = await executeRemote(request("console.log('second output');console.error('diagnostic');process.exitCode=23"), fixture.ports);
  expect(second).toMatchObject({ stdout: 'second output\n', stderr: 'diagnostic\n', exitCode: 23 });
  const inventory = await h.cli(['ls', '--all', '--json'], 'remote') as { terminals: { address: string; labels: Record<string, string>; name?: string; title?: string }[] };
  const summaries = await Promise.all(inventory.terminals.map(terminal => h.remoteHc.get(terminal.address as TerminalAddress)));
  const consoles = summaries.filter(terminal => terminal.labels['spider.kind'] === 'remote-console');
  expect(consoles).toHaveLength(1); expect(fixture.started).toHaveLength(2);
  const address = `remote.invalid/${consoles[0].address}` as TerminalAddress;
  let screen = ''; const deadline = Date.now() + 5000;
  while (!screen.includes('#2 ✗ exit 23') && Date.now() < deadline) { screen = (await h.hc.read(address, { lines: 200 })).replace(/\x1b\[[0-9;]*m/g, ''); await delay(25); }
  expect(screen).toMatch(/#1 exec .* · #2 exec /);
  expect(screen).not.toContain('(continued)');
  expect(screen).toContain(first.remote.jobId.slice(0, 8));
  expect(screen).toContain(second.remote.jobId.slice(0, 8));
  expect(screen).toContain('│ first output');
  expect(screen).toContain('#2 │ second output');
  expect(screen).toContain('#2 │ diagnostic');
  expect(screen).toContain('#2 ✗ exit 23');
  await h.hc.kill(address); await h.hc.rm(address);
  expect((await h.hc.get(first.remote.address!)).state).toBe('live'); expect(fixture.cancellations).toEqual([]);
  await h.hc.fileWrite(on, marker, Buffer.from('finish'));
  const end = Date.now() + 5000; let job = await h.hc.get(first.remote.address!);
  while (job.state !== 'finished' && Date.now() < end) { await delay(25); job = await h.hc.get(first.remote.address!); }
  expect(job).toMatchObject({ state: 'finished', exitCode: 17 });
  const receipt = JSON.parse((await h.hc.fileRead(on, join(fixture.started[0].remoteDirectory, 'receipt.json'))).toString());
  expect(receipt).toMatchObject({ jobId: first.remote.jobId, outcome: 'exited', exitCode: 17 });
  const stdout = (await h.hc.fileRead(on, join(fixture.started[0].remoteDirectory, 'stdout.log'))).toString(); expect(stdout).toContain('finished independently');
  if (mode === 'fake') {
    const calls = (await h.calls()).filter(call => call.argv[0] === 'run' && call.argv.includes('spider.kind=remote-console'));
    expect(calls).toHaveLength(1); expect(calls[0].argv).toContain('--no-notify'); expect(calls[0].argv).toContain('--on'); expect(calls[0].argv).toContain('--bg');
  }
  await writeFile(resolve(`.spider/scratch/agent-consoles/execute-${mode}-evidence.json`), JSON.stringify({ localSocket: h.localSocket, remoteSocket: h.remoteSocket, localCoreId: h.localCoreId, remoteCoreId: h.remoteCoreId, consoles, screen, receipt, payloadSurvivedConsoleClose: true }, null, 2));
}
it('ensures the console before job preparation and passes its hold directory only to that launch', async () => {
  const h = await createHerdrHarness('fake'); harnesses.push(h); await h.start(); vi.stubEnv('HC_TERMINAL_ID', h.owner!.terminal.terminalId);
  const fixture = await createRemoteTestFixture(h); const start = fixture.ports.jobs.start;
  fixture.ports.jobs.start = async (program, ...rest) => {
    const calls = (await h.calls()).filter(call => call.argv[0] === 'run' && call.argv.includes('spider.kind=remote-console'));
    expect(calls).toHaveLength(1); expect(program).toHaveProperty('consoleDirectory', calls[0].argv[calls[0].argv.indexOf('--console') + 1]);
    return start(program, ...rest);
  };
  const result = await executeRemote({ owner: h.owner!, on: 'remote.invalid' as MachineName, source: { kind: 'code', language: 'javascript', code: 'process.exitCode=23' } }, fixture.ports);
  expect(result.exitCode).toBe(23);
}, 20000);
it('a console launch failure does not fail or cancel the already supervised payload', async () => {
  const h = await createHerdrHarness('fake'); harnesses.push(h); await h.start();
  vi.stubEnv('HC_TERMINAL_ID', h.owner!.terminal.terminalId);
  const fixture = await createRemoteTestFixture(h);
  await h.scenario({ steps: [{ argvPrefix: ['run'], argvIncludes: ['spider.kind=remote-console'], stderr: { error: { kind: 'console-unavailable', message: 'View is unavailable' } }, exitCode: 3 }] }, 'remote');
  const result = await executeRemote({ owner: h.owner!, on: 'remote.invalid' as MachineName, source: { kind: 'code', language: 'javascript', code: "console.log('payload result');process.exitCode=23" } }, fixture.ports);
  expect(result).toMatchObject({ stdout: 'payload result\n', exitCode: 23, outcome: 'exited' });
  expect(fixture.started).toHaveLength(1); expect(fixture.cancellations).toEqual([]);
}, 20000);
it('remote launches share one console and closing it leaves supervised payloads running', async () => { await scenario('fake'); }, 30000);
it.skipIf(process.env.SPIDER_HERDR_E2E !== '1' || !existsSync(process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc')))('real isolated hc console view with a fake remote machine, no app window (requires installed hc and SPIDER_HERDR_E2E=1)', async () => { await scenario('hc'); }, 30000);
