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
async function writer(f: SetupFixture, second = false) {
  const terminal = second ? await f.h.hc.run({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: f.h.root, labels: {}, background: true, outliveParent: true, noNotify: true }) : null;
  const identity = terminal ? await f.h.hc.caller({ ...f.h.localEnv, HC_TERMINAL_ID: terminal.address }) : f.h.owner!.terminal;
  const owner: Owner = { ...f.h.owner!, terminal: identity, sessionId: randomUUID() as SessionId, generation: randomUUID() as Generation };
  const feed: SessionFeed = { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: 0, owner,
    placement: null, lifecycle: 'live', status: { native: null, effective: null, message: null },
    runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
    pace: { scope: 'session', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: null }, approvals: [], notifications: [], ipc: null, errors: [] };
  const source = join(f.h.root, 'feed-writer.ts'), cli = join(f.h.root, 'feed-writer.mjs'), root = join(f.request.config.globalRoot, 'herdr');
  await writeFile(source, `import { publishSessionFeed } from ${JSON.stringify(resolve('packages/herdr/src/feed/publisher.ts'))};
import { createProcessPresence } from ${JSON.stringify(resolve('packages/herdr/src/sessions/presence.ts'))};
import { createTerminalRegistry } from ${JSON.stringify(resolve('packages/herdr/src/sessions/registry.ts'))};
import { processStartTime } from ${JSON.stringify(resolve('packages/subagents/src/process-identity.ts'))};
const [root, raw, agent] = process.argv.slice(2), feed = JSON.parse(raw), owner = feed.owner;
await publishSessionFeed(root, feed);
await createTerminalRegistry(root).record({owner, recordedAt:Date.now(), coreStartedAt:1, environment:{agentDirectory:agent, extensionArguments:[]}});
await createProcessPresence(root).record({pid:process.pid, startIdentity:processStartTime(process.pid), sessionId:owner.sessionId, sessionFile:null, sessionName:null, kind:'top-level', hcAddress:owner.terminal.address});
console.log('ready'); setInterval(()=>{},1000);\n`);
  await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: { ssr: source, outDir: f.h.root, emptyOutDir: false,
    rollupOptions: { external: id => id.startsWith('node:'), output: { entryFileNames: 'feed-writer.mjs' } } } });
  const child = spawn(process.execPath, [cli, root, JSON.stringify(feed), f.request.config.agentDirectory], { env: f.h.localEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanup.push(() => stop(child));
  await new Promise<void>((resolve, reject) => { let output = ''; child.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('ready')) resolve(); }); child.once('error', reject); child.once('exit', code => reject(new Error(`feed writer exited ${code}`))); });
  return { child, owner, path: join(root, 'sessions', owner.sessionId, 'session.json') };
}
async function doctor(f: SetupFixture) {
  let output = '';
  const code = await runHerdrCli(['doctor', '--config', f.request.configPath], { ...f.ports, stdout: message => { output += message; } });
  return { code, output };
}

it('stale live-owner feeds fail, but the same unchanged feed is information after its writer dies', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const w = await writer(f), bytes = await readFile(w.path);
  const live = await doctor(f);
  expect(live.code).toBe(1);
  expect(live.output).toContain('feed-stale:');
  await stop(w.child);
  const ended = await doctor(f);
  expect(ended.code, ended.output).toBe(0);
  expect(ended.output).toContain('left by a session that ended without quitting');
  expect(ended.output).not.toContain('feed-stale:');
  expect(ended.output).not.toContain('Run setup from a plain shell');
  expect(await readFile(w.path)).toEqual(bytes);
}, 60000);

it.each(['missing', 'unreadable', 'malformed'])('doctor never treats %s writer provenance as ended', async kind => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const w = await writer(f), bytes = await readFile(w.path); await stop(w.child);
  const record = join(f.request.config.globalRoot, 'herdr/feed-writers', w.owner.sessionId + '.json');
  if (kind === 'missing') await rm(record);
  else if (kind === 'unreadable') await chmod(record, 0);
  else await writeFile(record, '{');
  const result = await doctor(f);
  expect(result.code).toBe(1);
  expect(result.output).toContain('feed-stale:');
  expect(result.output).not.toContain('left by a session that ended without quitting');
  expect(await readFile(w.path)).toEqual(bytes);
}, 60000);

it('information about an ended owner does not conceal another stale live owner', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const ended = await writer(f); await stop(ended.child);
  const live = await writer(f, true);
  const result = await doctor(f);
  expect(result.code).toBe(1);
  expect(result.output).toContain('feed-stale:');
  expect(result.output).toContain('left by a session that ended without quitting');
  await stop(live.child);
  const allEnded = await doctor(f);
  expect(allEnded.code, allEnded.output).toBe(0);
  expect(allEnded.output.match(/left by a session that ended without quitting/g)).toHaveLength(2);
  expect(allEnded.output).not.toContain('Run setup from a plain shell');
}, 60000);
