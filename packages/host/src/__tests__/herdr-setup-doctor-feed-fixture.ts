// SPDX-License-Identifier: MIT
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createBundledFixture } from './herdr-setup-bundled-writer.js';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import type { Owner, SessionFeed, SessionId, Generation } from '../../../herdr/src/contracts.js';
import { cleanup, type SetupFixture } from './herdr-setup-fixture.js';

const feedWriterProgram = createBundledFixture('feed-writer', `import { publishSessionFeed } from ${JSON.stringify(resolve('packages/herdr/src/feed/publisher.ts'))};
import { createProcessPresence } from ${JSON.stringify(resolve('packages/herdr/src/sessions/presence.ts'))};
import { createTerminalRegistry } from ${JSON.stringify(resolve('packages/herdr/src/sessions/registry.ts'))};
import { processStartTime } from ${JSON.stringify(resolve('packages/subagents/src/process-identity.ts'))};
const [root, raw, agent] = process.argv.slice(2), feed = JSON.parse(raw), owner = feed.owner;
await publishSessionFeed(root, feed);
await createTerminalRegistry(root).record({owner, recordedAt:Date.now(), coreStartedAt:1, environment:{agentDirectory:agent, extensionArguments:[]}});
await createProcessPresence(root).record({pid:process.pid, startIdentity:processStartTime(process.pid), sessionId:owner.sessionId, sessionFile:null, sessionName:null, kind:'top-level', hcAddress:owner.terminal.address});
console.log('ready'); setInterval(()=>{},1000);\n`);
export async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended;
}
export async function writer(f: SetupFixture, second = false): Promise<{ child: ChildProcess; owner: Owner; path: string }> {
  const terminal = second ? await f.h.hc.run({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: f.h.root, labels: {}, background: true, outliveParent: true, noNotify: true }) : null;
  const identity = terminal ? await f.h.hc.caller({ ...f.h.localEnv, HC_TERMINAL_ID: terminal.address }) : f.h.owner!.terminal;
  const owner: Owner = { ...f.h.owner!, terminal: identity, sessionId: randomUUID() as SessionId, generation: randomUUID() as Generation };
  const feed: SessionFeed = { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: 0, owner,
    placement: null, lifecycle: 'live', status: { native: null, effective: null, message: null },
    runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'session', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: null }, approvals: [], notifications: [], ipc: null, errors: [] };
  const root = join(f.request.config.globalRoot, 'herdr'), cli = await feedWriterProgram(f.h.root);
  const child = spawn(process.execPath, [cli, root, JSON.stringify(feed), f.request.config.agentDirectory], { env: f.h.localEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanup.push(() => stop(child));
  await new Promise<void>((resolve, reject) => { let output = ''; child.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('ready')) resolve(); }); child.once('error', reject); child.once('exit', code => reject(new Error(`feed writer exited ${code}`))); });
  return { child, owner, path: join(root, 'sessions', owner.sessionId, 'session.json') };
}
export async function doctor(f: SetupFixture): Promise<{ code: number; output: string }> {
  let output = '';
  const code = await runHerdrCli(['doctor', '--config', f.request.configPath], { ...f.ports, stdout: message => { output += message; } });
  return { code, output };
}
