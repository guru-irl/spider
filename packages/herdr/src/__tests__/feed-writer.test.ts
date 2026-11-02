import { expect, test } from 'vitest';
import { build } from 'vite';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeed } from '../../assets/shared/feed.js';
import type { SessionFeed, Owner } from '../contracts.js';

function outcome(child: ChildProcess): Promise<{ kind: 'accepted' | 'refused'; generation: string; code?: string }> {
  return new Promise((resolve, reject) => {
    let text = ''; let errors = '';
    child.stderr!.on('data', data => { errors += String(data); });
    child.stdout!.on('data', data => { text += String(data); if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0])); });
    child.once('error', reject);
    child.once('exit', () => { if (!text.includes('\n')) reject(new Error(errors || 'Writer exited without an outcome')); });
  });
}
test('two processes cannot alternate generations in one feed and a crash permits a replacement writer', async () => {
  const directory = resolve('.spider/scratch'); await mkdir(directory, { recursive: true });
  const root = await mkdtemp(join(directory, 'feed-')); const children: ChildProcess[] = [];
  try {
    const output = await build({ configFile: false, logLevel: 'silent', build: { ssr: true, write: false, rollupOptions: {
      input: fileURLToPath(new URL('../feed/publisher.ts', import.meta.url)), external: [/^node:/], output: { format: 'es' },
    } } });
    const result = Array.isArray(output) ? output[0] : output;
    if (!('output' in result)) throw new Error('Publisher build unexpectedly started a watcher');
    const bundle = result.output.find(item => item.type === 'chunk');
    if (!bundle || bundle.type !== 'chunk') throw new Error('Publisher bundle is missing');
    const bundlePath = join(root, 'publisher.mjs'); await writeFile(bundlePath, bundle.code);
    const executable = join(root, 'writer.mjs');
    await writeFile(executable, `
const { publishSessionFeed } = await import(process.argv[2]);
const root = process.argv[3], feed = JSON.parse(process.argv[4]);
try {
  for (let revision = 1; revision <= 10; revision++) await publishSessionFeed(root, { ...feed, revision });
  process.stdout.write(JSON.stringify({kind:'accepted',generation:feed.generation})+'\\n');
  setInterval(()=>{},1000);
} catch(error) { process.stdout.write(JSON.stringify({kind:'refused',generation:feed.generation,code:error.code})+'\\n'); }
`);
    const owner: Owner = { sessionId: 'shared-session' as Owner['sessionId'], generation: 'first' as Owner['generation'],
      terminal: { coreId: 'fixture' as Owner['terminal']['coreId'], terminalId: 't1' as Owner['terminal']['terminalId'], address: 't1' as Owner['terminal']['address'], socket: join(root, 'core.sock'), sessionNamespace: 'fixture' }, cwd: root, sessionFile: null, name: null };
    const sessionId = owner.sessionId;
    const feed: SessionFeed = { version: 1, sessionId, generation: owner.generation, revision: 1, updatedAt: Date.now(), owner,
      placement: null, lifecycle: 'live', status: { native: null, effective: null, message: null }, runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [],
      pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' }, approvals: [], notifications: [], ipc: null, errors: [],
    };
    const start = (generation: string) => {
      const child = spawn(process.execPath, [executable, bundlePath, root, JSON.stringify({ ...feed, generation, owner: { ...feed.owner, generation } })], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: root } });
      children.push(child); return child;
    };
    const first = start('first'), second = start('second');
    const outcomes = await Promise.all([outcome(first), outcome(second)]);
    expect(outcomes.map(value => value.kind).sort()).toEqual(['accepted', 'refused']);
    expect(outcomes.find(value => value.kind === 'refused')?.code).toBe('feed-writer-occupied');
    const path = join(root, 'sessions', sessionId, 'session.json');
    expect(parseFeed(await readFile(path, 'utf8'))?.generation).toBe(outcomes.find(value => value.kind === 'accepted')?.generation);
    const winner = outcomes[0].kind === 'accepted' ? first : second;
    const exited = new Promise<void>(resolve => winner.once('exit', () => resolve())); winner.kill('SIGKILL'); await exited;
    const replacement = start('replacement'); expect(await outcome(replacement)).toEqual({ kind: 'accepted', generation: 'replacement' });
    expect(parseFeed(await readFile(path, 'utf8'))?.generation).toBe('replacement');
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
