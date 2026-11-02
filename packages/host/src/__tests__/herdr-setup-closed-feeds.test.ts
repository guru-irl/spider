// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import type { Owner, SessionFeed, SessionId, Generation } from '../../../herdr/src/contracts.js';
import { cleanup, fixture, type SetupFixture } from './herdr-setup-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended;
}
async function closedOwner(f: SetupFixture, stale: boolean) {
  const owner: Owner = { ...f.h.owner!, sessionId: randomUUID() as SessionId, generation: randomUUID() as Generation };
  const feed: SessionFeed = { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: stale ? 0 : Date.now(), owner,
    placement: null, lifecycle: 'live', status: { native: null, effective: null, message: null },
    runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'session', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: null }, approvals: [], notifications: [], ipc: null, errors: [] };
  const source = join(f.h.root, 'closed-owner.ts'), root = join(f.request.config.globalRoot, 'herdr');
  await writeFile(source, `import { publishSessionFeed } from ${JSON.stringify(resolve('packages/herdr/src/feed/publisher.ts'))};
import { startSessionEndpoint } from ${JSON.stringify(resolve('packages/herdr/src/feed/ipc-server.ts'))};
import { createTerminalRegistry } from ${JSON.stringify(resolve('packages/herdr/src/sessions/registry.ts'))};
const [root, raw, agent] = process.argv.slice(2), feed = JSON.parse(raw), owner = feed.owner;
const endpoint = await startSessionEndpoint(owner, {currentOwner:()=>owner}, root);
await createTerminalRegistry(root).record({owner, recordedAt:Date.now(), coreStartedAt:1, environment:{agentDirectory:agent, extensionArguments:[]}});
await publishSessionFeed(root, {...feed, ipc:endpoint.descriptor});
await publishSessionFeed(root, {...feed, lifecycle:'closed', ipc:null});
await endpoint.dispose();
`);
  await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: { ssr: source, outDir: f.h.root, emptyOutDir: false,
    rollupOptions: { external: id => id.startsWith('node:'), output: { entryFileNames: 'closed-owner.mjs' } } } });
  const child = spawn(process.execPath, [join(f.h.root, 'closed-owner.mjs'), root, JSON.stringify(feed), f.request.config.agentDirectory], { env: f.h.localEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanup.push(() => stop(child));
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const [code] = await once(child, 'exit'); expect(code, stderr).toBe(0);
  return { path: join(root, 'sessions', owner.sessionId, 'session.json'), record: join(root, 'feed-writers', owner.sessionId + '.json') };
}
async function doctor(f: SetupFixture) {
  let output = '';
  const code = await runHerdrCli(['doctor', '--config', f.request.configPath], { ...f.ports, stdout: message => { output += message; } });
  return { code, output };
}

it.each([false, true])('setup verifies after a graceful owner exit (stale feed: %s)', async stale => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const owner = await closedOwner(f, stale), bytes = await readFile(owner.path);
  const result = await doctor(f);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain('feed-owner-ended:');
  expect(result.output).not.toContain('feed-stale:');
  expect(result.output).not.toContain('ipc-unavailable:');
  const before = (await f.h.calls()).length;
  const installed = await setupHerdr(f.request, f.parts);
  expect(installed.doctor.failures).toEqual([]);
  const probes = (await f.h.calls()).slice(before).filter(call => call.argv[0] === 'run' && call.argv.includes('--probe'));
  expect(probes).toHaveLength(f.request.config.machines.length);
  expect(await readFile(owner.path)).toEqual(bytes);
}, 60000);

it.each(['missing', 'unreadable', 'malformed'])('a closed feed with %s writer provenance still fails verification', async kind => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const owner = await closedOwner(f, true);
  if (kind === 'missing') await rm(owner.record, { force: true });
  else if (kind === 'unreadable') await chmod(owner.record, 0);
  else await writeFile(owner.record, '{');
  const result = await doctor(f);
  expect(result.code).toBe(1);
  expect(result.output).toContain('feed-stale:');
  expect(result.output).not.toContain('feed-owner-ended:');
}, 60000);
