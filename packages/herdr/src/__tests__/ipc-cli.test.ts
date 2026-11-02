// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runHerdrCli } from '../setup/cli.js';
import { createSessionIpcClient } from '../feed/ipc-client.js';
import { parseSessionIpcReply } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import type { IpcDescriptor } from '../contracts.js';

test.each([['source', 'absent'], ['source', 'refused'], ['built', 'absent'], ['built', 'refused']] as const)('%s IPC CLI returns a typed path-free reply for an %s session endpoint', async (entry, state) => {
  const base = resolve('.spider/scratch/h'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'ic-'));
  const descriptor = { version: 1, sessionId: 'owner', generation: 'generation', address: join(root, 'dead.sock'), capabilityFile: join(root, 'dead.cap') } as IpcDescriptor;
  let stdout = '', stderr = '';
  try {
    if (state === 'refused') {
      await writeFile(descriptor.capabilityFile, 'a'.repeat(64), { mode: 0o600 });
      const worker = spawn(process.execPath, ['-e', 'const fs=require("node:fs");require("node:net").createServer().listen(process.argv[1],()=>{fs.chmodSync(process.argv[1],0o600);process.stdout.write("ready");});', descriptor.address], { stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise<void>((resolve, reject) => { worker.stdout.once('data', () => resolve()); worker.once('error', reject); });
      const ended = new Promise<void>(resolve => worker.once('exit', () => resolve())); worker.kill('SIGKILL'); await ended;
    }
    const client = createSessionIpcClient(descriptor);
    try {
      const args = ['ipc', '--descriptor', JSON.stringify(descriptor), '--request', JSON.stringify({ op: 'ping', generation: descriptor.generation })];
      const rc = entry === 'built' ? (() => {
        const result = spawnSync(process.execPath, [resolve('dist/herdr/cli.mjs'), ...args], { encoding: 'utf8', timeout: 5000, env: { ...process.env, SPIDER_GLOBAL_ROOT: root, PI_CODING_AGENT_DIR: root } });
        stdout = result.stdout; stderr = result.stderr; return result.status;
      })() : await runHerdrCli(['node', '/fixture/cli.mjs', ...args], {
        request: async () => { throw new Error('Must not read setup config'); }, setupParts: async () => { throw new Error('Must not set up'); }, doctorParts: async () => { throw new Error('Must not doctor'); },
        ipc: (_descriptor, request) => client.request(request as never), stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
      });
      expect(rc).toBe(1); expect(parseSessionIpcReply(stdout)).toEqual({ ok: false, code: 'unavailable', message: 'endpoint-unavailable' });
      expect(stderr).toBe(''); expect(stdout).not.toContain(root);
    } finally { client.dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([
  [new HerdrError('not-found', 'Private path /fixture/private/log'), { ok: false, code: 'not-found', message: 'not-found' }],
  [new HerdrError('/fixture/private/log', 'Private path'), { ok: false, code: 'unavailable', message: 'endpoint-unavailable' }],
  [new Error('Private path /fixture/private/log'), { ok: false, code: 'unavailable', message: 'endpoint-unavailable' }],
])('IPC CLI sanitizes thrown action errors into protocol replies', async (error, expected) => {
  let stdout = '', stderr = '';
  const descriptor = { version: 1, sessionId: 'owner', generation: 'generation', address: '/fixture/ipc.sock', capabilityFile: '/fixture/ipc.cap' };
  const rc = await runHerdrCli(['node', '/fixture/cli.mjs', 'ipc', '--descriptor', JSON.stringify(descriptor), '--request', JSON.stringify({ op: 'ping', generation: 'generation' })], {
    request: async () => { throw new Error('No setup'); }, setupParts: async () => { throw new Error('No setup'); }, doctorParts: async () => { throw new Error('No doctor'); },
    ipc: async () => { throw error; }, stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
  });
  expect(rc).toBe(1); expect(parseSessionIpcReply(stdout)).toEqual(expected); expect(stderr).toBe(''); expect(stdout).not.toContain('/fixture');
});
