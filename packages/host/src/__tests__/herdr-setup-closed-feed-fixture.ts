// SPDX-License-Identifier: MIT
import { expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createBundledFixture } from './herdr-setup-bundled-writer.js';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import type { Owner, SessionFeed, SessionId, Generation } from '../../../herdr/src/contracts.js';
import { cleanup, type SetupFixture } from './herdr-setup-fixture.js';

const closedOwnerProgram = createBundledFixture('closed-owner', `import { publishSessionFeed } from ${JSON.stringify(resolve('packages/herdr/src/feed/publisher.ts'))};
import { startSessionEndpoint } from ${JSON.stringify(resolve('packages/herdr/src/feed/ipc-server.ts'))};
import { createTerminalRegistry } from ${JSON.stringify(resolve('packages/herdr/src/sessions/registry.ts'))};
const [root, raw, agent] = process.argv.slice(2), feed = JSON.parse(raw), owner = feed.owner;
const endpoint = await startSessionEndpoint(owner, {currentOwner:()=>owner}, root);
await createTerminalRegistry(root).record({owner, recordedAt:Date.now(), coreStartedAt:1, environment:{agentDirectory:agent, extensionArguments:[]}});
await publishSessionFeed(root, {...feed, ipc:endpoint.descriptor});
await publishSessionFeed(root, {...feed, lifecycle:'closed', ipc:null});
await endpoint.dispose();
`);
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended;
}
export async function closedOwner(f: SetupFixture, stale: boolean): Promise<{ path: string; record: string }> {
  const owner: Owner = { ...f.h.owner!, sessionId: randomUUID() as SessionId, generation: randomUUID() as Generation };
  const feed: SessionFeed = { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: stale ? 0 : Date.now(), owner,
    placement: null, lifecycle: 'live', status: { native: null, effective: null, message: null },
    runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'session', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: null }, approvals: [], notifications: [], ipc: null, errors: [] };
  const root = join(f.request.config.globalRoot, 'herdr'), cli = await closedOwnerProgram(f.h.root);
  const child = spawn(process.execPath, [cli, root, JSON.stringify(feed), f.request.config.agentDirectory], { env: f.h.localEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanup.push(() => stop(child));
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const [code] = await once(child, 'exit'); expect(code, stderr).toBe(0);
  return { path: join(root, 'sessions', owner.sessionId, 'session.json'), record: join(root, 'feed-writers', owner.sessionId + '.json') };
}
export async function doctor(f: SetupFixture): Promise<{ code: number; output: string }> {
  let output = '';
  const code = await runHerdrCli(['doctor', '--config', f.request.configPath], { ...f.ports, stdout: message => { output += message; } });
  return { code, output };
}
