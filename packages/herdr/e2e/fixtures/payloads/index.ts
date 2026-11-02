// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Suite } from '../../harness/suite.js';
import { HarnessError } from '../../harness/environment.js';
import { destinationRoot, destinationPath, assertDestinationPaths } from '../../harness/destination.js';
import { waitFor, type Deadline } from '../../harness/wait.js';

export const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
export interface PayloadOptions {
  id: string;
  machine?: string;
  nodePath?: string;
  gate?: boolean;
  gateMs?: number;
  stdout?: string;
  stderr?: string;
  beforeStdout?: string;
  beforeStderr?: string;
  exitCode?: number;
  stdin?: boolean;
  splitUnicode?: boolean;
  large?: { lines: number; bytes: number };
  onSignalExitZero?: boolean;
  signal?: 'SIGHUP' | 'SIGINT' | 'SIGTERM';
}
export interface PayloadReady { story: string; id: string; nonce: string; pid: number; cwd: string }
export interface PayloadHandle {
  readonly id: string;
  readonly machine: string;
  readonly code: string;
  readonly configPath: string;
  readonly readyPath: string;
  readonly releasePath: string;
  readonly effectPath: string;
  readonly signalPath: string;
  ready(limit: Deadline): Promise<PayloadReady>;
  release(): Promise<void>;
  effect(): Promise<string | null>;
}
/** Reads the real destination file through hc. A missing file is not an empty successful read. */
export async function readDestination(suite: Suite, machine: string, path: string): Promise<string | null> {
  await assertDestinationPaths(suite, [path]);
  const r = await suite.hc(['file', 'read', '--json', '--on', machine, path]);
  if (r.exitCode !== 0) {
    if (/ENOENT|not_found|No such file/.test(r.stderr + r.stdout)) return null;
    throw new HarnessError('destination-read-failed', r.stderr || r.stdout, r);
  }
  const value = r.json as { text?: unknown } | null;
  if (typeof value?.text !== 'string') throw new HarnessError('destination-read-invalid', r.stdout);
  return value.text;
}
/** Stages only external fixture inputs. The model must issue the returned code through the real spider tool. */
export async function writeDestination(suite: Suite, machine: string, path: string, bytes: string): Promise<void> {
  await assertDestinationPaths(suite, [path]);
  if (!suite.cores) throw new HarnessError('missing-prerequisite', 'destination fixture requires the real isolated core');
  const r = await suite.cores.hc(['file', 'write', '--json', '--on', machine, path], 'local', { input: bytes });
  if (r.exitCode !== 0) throw new HarnessError('destination-write-failed', r.stderr || r.stdout, r);
}
/** Explicit transport-corruption/pruning control. It never removes an unproved path or uses a default core. */
export async function removeDestination(suite: Suite, machine: string, path: string): Promise<void> {
  await assertDestinationPaths(suite, [path]);
  const code = `const fs=require('node:fs'),p=require('node:path');const root=process.argv[1],target=process.argv[2];if(p.resolve(target)!==target||!target.startsWith(root+p.sep))throw Error('fixture-remove-unowned');for(let at=target;at!==root;at=p.dirname(at)){try{if(fs.lstatSync(at).isSymbolicLink())throw Error('fixture-remove-symlink')}catch(e){if(e.code!=='ENOENT')throw e}}function inspect(at){let s;try{s=fs.lstatSync(at)}catch(e){if(e.code==='ENOENT')return;throw e}if(s.isSymbolicLink())throw Error('fixture-remove-symlink');if(s.isFile()){if(s.nlink!==1)throw Error('fixture-remove-hardlink');return}if(!s.isDirectory())throw Error('fixture-remove-kind');for(const name of fs.readdirSync(at))inspect(p.join(at,name))}inspect(target);fs.rmSync(target,{recursive:true,force:true});`;
  const r = await suite.hc(['run', '--json', '--bg', '--no-notify', '--outlive-parent', '--keep', '--on', machine, '--', 'node', '-e', code, destinationRoot(suite), path]);
  const address = (r.json as { address?: string } | null)?.address;
  if (r.exitCode !== 0 || !address?.startsWith(machine + '/')) throw new HarnessError('fixture-remove-launch-failed', r.stderr || r.stdout, r);
  suite.ledger.update(l => l.terminals.push({ side: 'local', address }));
  const state = await waitFor('owned destination remove finishes', async () => (await suite.hc(['get', address, '--json'])).json as { state?: string; exit_code?: number; signal?: number | null }, value => value?.state === 'finished', { expiresAt: Date.now() + 30000, signal: AbortSignal.timeout(30000) });
  if (state.exit_code !== 0 || state.signal !== null) throw new HarnessError('fixture-remove-failed', JSON.stringify(state));
  await suite.hc(['rm', address, '--json']);
}
export async function stagePayload(suite: Suite, options: PayloadOptions): Promise<PayloadHandle> {
  if (!/^[a-z0-9-]{1,40}$/.test(options.id)) throw new HarnessError('payload-id-invalid', options.id);
  const machine = options.machine ?? suite.cores?.machine;
  if (!machine) throw new HarnessError('missing-prerequisite', 'payload staging needs a destination');
  const directory = destinationPath(suite, join(destinationRoot(suite), 'payloads', options.id));
  const configPath = join(directory, 'input.json'), readyPath = join(directory, 'ready.json');
  const releasePath = join(directory, 'release.json'), effectPath = join(directory, 'effect.txt'), signalPath = join(directory, 'signal.json');
  const executable = join(directory, 'controlled.mjs'), nonce = randomBytes(16).toString('hex');
  await writeDestination(suite, machine, executable, await readFile(new URL('./controlled.mjs', import.meta.url), 'utf8'));
  const { id, nodePath = 'node', gate = true, gateMs = 180000, machine: _machine, ...payload } = options;
  await writeDestination(suite, machine, configPath, JSON.stringify({ ...payload, root: destinationRoot(suite), story: suite.story, id, nonce, effect: effectPath, signalFile: signalPath,
    ...(gate ? { ready: readyPath, release: releasePath, deadlineAt: Date.now() + gateMs } : {}) }));
  return {
    id, machine, configPath, readyPath, releasePath, effectPath, signalPath,
    code: `exec ${shellQuote(nodePath)} ${shellQuote(executable)} ${shellQuote(configPath)}`,
    async ready(limit) {
      if (!gate) throw new HarnessError('payload-not-gated', id);
      const text = await waitFor(`destination payload ${id} ready`, () => readDestination(suite, machine, readyPath), value => value !== null, limit, { reconcileMs: 100 });
      const value = JSON.parse(text!) as PayloadReady;
      if (value.story !== suite.story || value.id !== id || value.nonce !== nonce || !Number.isInteger(value.pid) || typeof value.cwd !== 'string') throw new HarnessError('payload-ready-invalid', text!);
      await suite.evidence(`payload-${id}-ready.json`, value);
      return value;
    },
    release: () => writeDestination(suite, machine, releasePath, JSON.stringify({ story: suite.story, id, nonce })),
    effect: () => readDestination(suite, machine, effectPath),
  };
}
