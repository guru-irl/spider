// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { identityOf, type ProcessIdentity } from '../harness/resources.js';
import { deadline, waitFor } from '../harness/wait.js';
import type { Suite } from '../harness/suite.js';
import { writeScript } from '../harness/pi.js';
import type { ScriptFile } from './scripted-provider.js';

/** Write the offline model's actual input, not a result or product state. */
export async function installScripts(suite: Suite, scripts: ScriptFile['scripts']): Promise<void> {
  await writeScript(suite.pi.scriptPath, { story: suite.story, scripts });
}

/** Configure only this fixture's global settings and optional Herdr config. */
export async function configureHerdr(suite: Suite, enabled: boolean | 'auto' | undefined, withConfig: boolean): Promise<void> {
  const file = join(suite.directories.SPIDER_GLOBAL_ROOT, 'config.json');
  const settings = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  if (enabled === undefined) delete settings['herdr.enabled']; else settings['herdr.enabled'] = enabled;
  if (withConfig) {
    const config = join(suite.root, 'herdr.json');
    settings['herdr.config'] = config;
    await writeFile(config, JSON.stringify({
      enabled: 'auto', app: { binary: join(suite.root, 'bin', 'herdr-app'), home: suite.directories.HERDR_APP_HOME },
      core: { binary: join(suite.root, 'bin', 'hc'), config: join(suite.directories.XDG_CONFIG_HOME, 'herdr-core', 'config.toml') },
      agentDirectory: suite.directories.PI_CODING_AGENT_DIR, globalRoot: suite.directories.SPIDER_GLOBAL_ROOT,
      shellRc: join(suite.root, 'rc'), spaces: [], machines: [],
    }));
  } else delete settings['herdr.config'];
  await writeFile(file, JSON.stringify(settings, null, 2));
}

/** Point an active pi at the supervised app boundary and the real isolated core. */
export interface OwnedShell {
  identity: ProcessIdentity; terminal: string;
  input(text: string): Promise<void>;
  output(): Promise<string>;
  draft(): Promise<string>;
  wrongIdentityControl(): Promise<Record<string, unknown>>;
}
/** Connect only to a broker whose real hc terminal and child PID were created by this suite. */
export async function connectOwnedShell(suite: Suite, terminal: string, socketPath: string, logPath: string): Promise<OwnedShell> {
  const socket = suite.ownPath(socketPath), log = suite.ownPath(logPath);
  if (Buffer.byteLength(socket) > 103) throw new Error('owned broker socket exceeds the platform limit');
  const requestAt = (target: string, value: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const connection = connect(target); let buffer = '';
    connection.setTimeout(5000, () => { connection.destroy(); reject(new Error('broker request timed out')); });
    connection.once('connect', () => connection.write(JSON.stringify(value) + '\n'));
    connection.on('data', data => {
      buffer += data.toString('utf8'); const end = buffer.indexOf('\n'); if (end < 0) return;
      connection.destroy(); try { resolve(JSON.parse(buffer.slice(0, end))); } catch (error) { reject(error); }
    });
    connection.once('error', reject);
  });
  const request = (value: Record<string, unknown>) => requestAt(socket, value);
  const hello = await waitFor('owned shell broker ready', async () => { try { return await request({ op: 'hello' }); } catch { return null; } }, value => typeof value?.pid === 'number', deadline(30_000));
  if (!hello || typeof hello.pid !== 'number' || hello.terminal !== terminal) throw new Error('recovery shell broker identity mismatch');
  const result = await suite.hc(['get', terminal, '--json']);
  const actual = result.json as { pid?: number; argv?: string[] } | null;
  const parent = Number(execFileSync('ps', ['-p', String(hello.pid), '-o', 'ppid='], { encoding: 'utf8' }).trim());
  if (result.exitCode !== 0 || !actual || actual.pid !== parent || !actual.argv?.includes(socket) || !actual.argv.includes(log) || !actual.argv.some(arg => arg.endsWith('/pty-broker.py'))) throw new Error('recovery shell broker is not the selected owned hc terminal');
  const identity = identityOf(hello.pid);
  suite.ledger.update(ledger => { ledger.processes.push({ ...identity, label: 'recovery-shell', group: false }); });
  return {
    identity, terminal,
    async input(text) { const result = await request({ op: 'input', pid: identity.pid, terminal, data: text }); if (result.ok !== true) throw new Error(`broker refused shell input: ${JSON.stringify(result)}`); },
    async output() { return readFile(log, 'utf8').catch(() => ''); },
    async draft() {
      const target = suite.ownPath(join(suite.pi.observerDir, `${identity.pid}.s`));
      const value = await requestAt(target, { op: 'draft' });
      if (typeof value.draft !== 'string') throw new Error('owned pi draft unavailable');
      return value.draft;
    },
    wrongIdentityControl: () => request({ op: 'input', pid: -1, terminal, data: '' }),
  };
}

export async function configureActiveHerdr(suite: Suite): Promise<Record<string, string>> {
  await suite.app();
  if (!suite.appConnection) throw new Error('prerequisite: the selected app tier has no supervised product CLI connection');
  await configureHerdr(suite, 'auto', true);
  const path = join(suite.root, 'herdr.json');
  const config = JSON.parse(await readFile(path, 'utf8')) as { app: { binary: string } };
  config.app.binary = suite.appConnection.binary;
  await writeFile(path, JSON.stringify(config));
  return { PI_PROGRAM_STATUS: '1' };
}
