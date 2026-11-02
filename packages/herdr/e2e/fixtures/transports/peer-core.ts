// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSocketPath, HarnessError } from '../../harness/environment.js';
import { observe, type InteractiveDriver } from '../../harness/pi.js';
import { identityAlive, identityOf } from '../../harness/resources.js';
import type { Suite } from '../../harness/suite.js';
import { deadline, waitFor } from '../../harness/wait.js';

// The ordinary driver launches in the local core. This peer uses the same broker,
// packed launcher and supervisor ledger, but requests a terminal in the other owned core.
export async function launchPeerCore(suite: Suite, cwd: string, extraEnv: Record<string, string>): Promise<InteractiveDriver> {
  const cores = suite.cores;
  if (!cores) throw new HarnessError('missing-prerequisite', 'a second owned core is required');
  const socket = assertSocketPath(suite.root, join(suite.root, 'peer.s'));
  const rawLog = suite.ownPath(join(suite.root, 'logs', 'peer.raw'));
  const envFile = suite.ownPath(join(suite.root, 'peer-env.json'));
  await mkdir(dirname(rawLog), { recursive: true });
  await writeFile(envFile, JSON.stringify({ ...suite.pi.env, ...extraEnv, HC_SESSION: cores.dest.namespace, HC_SOCKET: cores.dest.socket,
    XDG_STATE_HOME: cores.dest.env.XDG_STATE_HOME, XDG_CONFIG_HOME: cores.dest.env.XDG_CONFIG_HOME }), { mode: 0o600 });
  const broker = fileURLToPath(new URL('../../harness/pty-broker.py', import.meta.url));
  const result = await cores.hc(['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--cwd', suite.ownPath(cwd), '--',
    '/usr/bin/python3', broker, '--socket', socket, '--log', rawLog, '--env-file', envFile, '--', suite.pi.launcher], 'dest', { cwd });
  const reply = result.json as { address?: unknown; terminal?: { address?: unknown } } | null;
  const terminal = typeof reply?.address === 'string' ? reply.address : typeof reply?.terminal?.address === 'string' ? reply.terminal.address : null;
  if (result.exitCode !== 0 || !terminal) throw new HarnessError('hc-run-failed', result.stderr || result.stdout);
  suite.ledger.update(ledger => { ledger.terminals.push({ side: 'dest', address: terminal }); });
  const call = (request: Record<string, unknown>, target: string = socket) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const connection = connect(suite.ownPath(target)); let buffer = '';
    connection.setTimeout(5000, () => { connection.destroy(); reject(new Error('peer broker response timed out')); });
    connection.on('connect', () => connection.write(JSON.stringify(request) + '\n'));
    connection.on('data', data => {
      buffer += data.toString('utf8'); const newline = buffer.indexOf('\n');
      if (newline >= 0) { connection.destroy(); try { resolve(JSON.parse(buffer.slice(0, newline))); } catch (error) { reject(error); } }
    });
    connection.on('error', reject);
  });
  await waitFor('destination broker socket', () => existsSync(socket), Boolean, deadline(20_000));
  const hello = await call({ op: 'hello' });
  if (typeof hello.pid !== 'number' || hello.terminal !== terminal) throw new HarnessError('broker-identity', `peer reports ${JSON.stringify(hello)} for ${terminal}`);
  const identity = identityOf(hello.pid);
  suite.ledger.update(ledger => { ledger.processes.push({ ...identity, label: 'peer-core-pi', group: false }); });
  const send = async (data: string) => {
    const ack = await call({ op: 'input', pid: identity.pid, terminal, data });
    if (ack.ok !== true) throw new HarnessError('broker-refused', JSON.stringify(ack));
  };
  const observations = observe(suite.pi.observerDir, () => identity.pid);
  return {
    mode: 'interactive', pid: identity.pid, identity, cwd, terminal, ...observations,
    prompt: text => send(text + '\r'), key: send,
    async draft() {
      const answer = await call({ op: 'draft' }, join(suite.pi.observerDir, `${identity.pid}.s`));
      if (typeof answer.draft !== 'string') throw new HarnessError('draft-unavailable', JSON.stringify(answer));
      return answer.draft;
    },
    rawOutput: () => readFile(rawLog),
    async close() {
      if (identityAlive(identity)) {
        try { process.kill(identity.pid, 'SIGTERM'); } catch { /* already exited */ }
        try { await waitFor('peer pi exits', () => identityAlive(identity), alive => !alive, deadline(10_000), { reconcileMs: 100 }); }
        catch { if (identityAlive(identity)) try { process.kill(identity.pid, 'SIGKILL'); } catch { /* exited */ } }
      }
      // A dead core must never be touched by a CLI that could autostart it.
      if (!existsSync(cores.dest.socket)) return;
      const state = await cores.hc(['get', terminal, '--json'], 'dest');
      if ((state.json as { state?: string } | null)?.state === 'live') await cores.hc(['kill', terminal, '--json'], 'dest');
      await cores.hc(['rm', terminal, '--json'], 'dest');
    },
  };
}
