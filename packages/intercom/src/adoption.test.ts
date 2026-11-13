import { afterAll, beforeAll, expect, it } from 'vitest';
import './test-support.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { getBrokerLaunchSpec, getCompiledBrokerPath } from './broker/spawn.js';
import { IntercomClient } from './broker/client.js';
import { getBrokerSocketPath } from './broker/paths.js';
import type { Message } from './types.js';

let broker: ChildProcess;
const legacy = new IntercomClient(), fork = new IntercomClient();
const launch = getBrokerLaunchSpec(getCompiledBrokerPath(), 'npx', ['--no-install', 'tsx']);
beforeAll(async () => {
  broker = spawn(launch.command, launch.args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Compiled broker did not become ready')), 4000);
    broker.once('exit', code => { clearTimeout(timer); reject(new Error(`Compiled broker exited ${code}`)); });
    broker.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('Intercom broker started')) { clearTimeout(timer); resolve(); } });
  });
  const registration = { cwd: process.cwd(), model: 'fixture', pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() };
  await legacy.connect({ ...registration, name: 'legacy' }, 'legacy-stable');
  await fork.connect({ ...registration, name: 'fork' }, 'fork-stable');
}, 5000);
afterAll(async () => {
  await legacy.disconnect(); await fork.disconnect();
  if (broker?.exitCode === null) { const exited = once(broker, 'exit'); broker.kill(); await exited; }
}, 5000);
it('compiled broker needs no tsx', () => {
  expect(launch.command).toBe(process.execPath);
  expect(launch.args).toEqual([expect.stringMatching(/intercom[/\\]broker\.mjs$/)]);
  expect(launch.args.join(' ')).not.toContain('tsx');
  expect(broker.exitCode).toBeNull();
}, 5000);
it('two fork clients share the original paths and exchange messages', async () => {
  // Both clients use the forked 0.13.0 wire implementation.
  expect(getBrokerSocketPath()).toMatch(/intercom[/\\]broker\.sock$/);
  const received = once(fork, 'message');
  const sent = await legacy.send('fork-stable', { text: 'fixture ask', expectsReply: true,
    attachments: [{ type: 'snippet', name: 'fixture.txt', content: 'fixture attachment' }] });
  const [from, incoming] = await received as [unknown, Message];
  expect(sent.delivered).toBe(true);
  expect(from).toMatchObject({ id: 'legacy-stable', name: 'legacy' });
  expect(incoming).toMatchObject({ id: sent.id, expectsReply: true, content: { text: 'fixture ask',
    attachments: [{ name: 'fixture.txt', content: 'fixture attachment' }] } });
  const reply = once(legacy, 'message');
  await fork.send('legacy-stable', { text: 'fixture reply', replyTo: incoming.id });
  expect((await reply as [unknown, Message])[1]).toMatchObject({ content: { text: 'fixture reply' }, replyTo: sent.id });
  await legacy.disconnect(); await legacy.connect({ cwd: process.cwd(), model: 'fixture', pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), name: 'legacy' }, 'legacy-stable');
  expect((await fork.listSessions()).map(session => session.id).sort()).toEqual(['fork-stable', 'legacy-stable']);
}, 5000);
