// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Two real isolated hc cores (local and destination), a recording hc wrapper, and a local --via machine.
import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { mkdir, writeFile, chmod, readFile, stat } from 'node:fs/promises';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertSocketPath, defaultCoreSocket, HarnessError, ownedPath, scratchRoot, type OwnedPath } from './environment.js';
import { identityOf, type LedgerHandle } from './resources.js';

export type Side = 'local' | 'dest';
export const DEST_MACHINE = 'dest.invalid';
export interface CoreDescriptor { side: Side; namespace: string; socket: OwnedPath; env: Record<string, string>; coreId: string; pid: number }
export interface HcResult { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; json: unknown }
export interface HcRecord { at: number; pid: number; ppid: number; argv: string[]; namespace: string; socket: string | null; cwd: string; terminal: string | null }
export interface Cores {
  local: CoreDescriptor; dest: CoreDescriptor; machine: typeof DEST_MACHINE;
  /** The recording wrapper path; spider finds it as `hc` on PATH. */
  wrapper: OwnedPath; recordLog: OwnedPath; viaLog: OwnedPath;
  hc(argv: readonly string[], side?: Side, options?: { cwd?: string; input?: string }): Promise<HcResult>;
  records(): Promise<HcRecord[]>;
}

export function realHcBinary(): string {
  const override = process.env.SPIDER_HERDR_E2E_HC;
  if (!override) return join(userInfo().homedir, '.local/bin/hc');
  if (!isAbsolute(override)) throw new HarnessError('outside-owned-root', 'The hc override must be an absolute path under the fixture root');
  const path = ownedPath(scratchRoot(), override), info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || !(info.mode & 0o100)) throw new HarnessError('outside-owned-root', 'The hc override must be an owned executable under the fixture root');
  return path;
}

const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;

export function runHc(binary: string, argv: readonly string[], env: Record<string, string>, options: { cwd?: string; input?: string } = {}): Promise<HcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...argv], { env, cwd: options.cwd ?? env.HOME, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', d => out.push(d)); child.stderr.on('data', d => err.push(d));
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8');
      let json: unknown = null; try { json = JSON.parse(stdout || stderr); } catch { /* not JSON */ }
      resolve({ exitCode, signal, stdout, stderr, json });
    });
    child.stdin.end(options.input ?? '');
  });
}
function ok(result: HcResult, what: string): Record<string, unknown> {
  if (result.exitCode !== 0 || !result.json || typeof result.json !== 'object') throw new HarnessError('hc-failed', `${what}: exit ${result.exitCode} ${result.stderr.slice(0, 400)}`, result);
  return result.json as Record<string, unknown>;
}

/**
 * Starts both cores. Sockets are fenced and registered in the ledger before any hc call;
 * every call goes through the recording wrapper so the log shows each spawn.
 */
export async function startCores(ledger: LedgerHandle, root: string, base: Record<string, string>, binDirectory: string, coreEnvironment: Readonly<Record<string, string>> = {}): Promise<Cores> {
  for (const key of Object.keys(coreEnvironment)) if (key in base || /^(HC_|HERDR_|XDG_|PI_|SPIDER_)/.test(key))
    throw new HarnessError('core-environment-invalid', `Extra core environment may not replace isolation field ${key}`);
  for (const candidate of [base.HC_SOCKET, base.HC_TERMINAL_SOCKET])
    if (candidate && resolve(candidate) === defaultCoreSocket()) throw new HarnessError('default-socket', 'refusing the default hc socket');
  const real = realHcBinary();
  await writeFile(ownedPath(root, join(root, 'installed-binaries.json')), JSON.stringify({ hc: real, herdrCore: join(dirname(real), 'herdr-core'), herdrApp: join(userInfo().homedir, '.local/bin/herdr-app') }, null, 2));
  try { await stat(real); } catch { throw new HarnessError('missing-prerequisite', `hc is not installed at ${real}; Tier 1 needs the real hc 0.1.16`); }
  const bin = ownedPath(root, binDirectory); await mkdir(bin, { recursive: true });
  const recordLog = ownedPath(root, join(root, 'hc-calls.jsonl')), viaLog = ownedPath(root, join(root, 'via.jsonl'));
  await writeFile(recordLog, ''); await writeFile(viaLog, '');
  const wrapper = ownedPath(root, join(bin, 'hc'));
  const recorder = fileURLToPath(new URL('../fixtures/hc-record.mjs', import.meta.url));
  await writeFile(wrapper, `#!/bin/sh\nHC_RECORD_LOG=${quote(recordLog)} HC_REAL_BINARY=${quote(real)} exec ${quote(process.execPath)} ${quote(recorder)} "$@"\n`); await chmod(wrapper, 0o700);
  // The --via line runs `herdr-core connect` on the far side; record it through the same wrapper.
  const coreWrapper = ownedPath(root, join(bin, 'herdr-core'));
  await writeFile(coreWrapper, `#!/bin/sh\nHC_RECORD_LOG=${quote(recordLog)} HC_REAL_BINARY=${quote(join(dirname(real), 'herdr-core'))} exec ${quote(process.execPath)} ${quote(recorder)} "$@"\n`); await chmod(coreWrapper, 0o700);

  const state = ownedPath(root, base.XDG_STATE_HOME);
  const sides: Record<Side, { namespace: string; env: Record<string, string> }> = {
    local: { namespace: 'l', env: { ...base, ...coreEnvironment, HC_SESSION: 'l', XDG_STATE_HOME: state, XDG_CONFIG_HOME: ownedPath(root, base.XDG_CONFIG_HOME) } },
    dest: { namespace: 'd', env: { ...base, ...coreEnvironment, HC_SESSION: 'd', XDG_STATE_HOME: state, XDG_CONFIG_HOME: ownedPath(root, join(root, 'dc')), HOME: ownedPath(root, join(root, 'dh')), TMPDIR: ownedPath(root, join(root, 'dt')) } },
  };
  const sockets = {} as Record<Side, OwnedPath>;
  for (const side of ['local', 'dest'] as const) {
    const { env, namespace } = sides[side];
    for (const key of ['HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SOCKET', 'HC_SCOPE', 'XDG_RUNTIME_DIR']) delete env[key];
    for (const dir of [env.XDG_CONFIG_HOME, env.HOME, env.TMPDIR, join(env.XDG_CONFIG_HOME, 'herdr-core')]) await mkdir(dir, { recursive: true });
    await writeFile(join(env.XDG_CONFIG_HOME, 'herdr-core', 'config.toml'), 'notes = false\n');
    sockets[side] = assertSocketPath(root, join(state, 'herdr-core', namespace, `${namespace}.sock`));
  }
  if (sockets.local === sockets.dest || [sockets.local, sockets.dest].includes(defaultCoreSocket() as OwnedPath)) throw new HarnessError('isolation-unproved', 'core sockets are not distinct owned paths');
  ledger.update(l => { for (const side of ['local', 'dest'] as const) l.cores.push({ side, namespace: sides[side].namespace, socket: sockets[side], hcBinary: real, env: sides[side].env }); });

  const hc: Cores['hc'] = (argv, side = 'local', options) => runHc(wrapper, argv, sides[side].env, options);
  const descriptors = {} as Record<Side, CoreDescriptor>;
  for (const side of ['local', 'dest'] as const) {
    ok(await hc(['server', 'start', '--json'], side), `${side} server start`);
    const status = ok(await hc(['server', 'status', '--json'], side), `${side} server status`);
    const core = status.core as { id?: unknown } | undefined;
    if (typeof status.pid !== 'number' || typeof core?.id !== 'string' || status.version !== '0.1.16') throw new HarnessError('isolation-unproved', `${side} core status is not hc 0.1.16 with an id and pid`, status);
    if (!(await stat(sockets[side])).isSocket()) throw new HarnessError('isolation-unproved', `${side} socket was not created at ${sockets[side]}`);
    const identity = identityOf(status.pid);
    ledger.update(l => { const c = l.cores.find(x => x.side === side)!; c.coreId = core.id as string; c.pid = identity.pid; c.start = identity.start; });
    descriptors[side] = { side, namespace: sides[side].namespace, socket: sockets[side], env: sides[side].env, coreId: core.id, pid: status.pid };
  }
  if (descriptors.local.coreId === descriptors.dest.coreId) throw new HarnessError('isolation-unproved', 'local and destination cores share an id');

  const descriptorPath = ownedPath(root, join(root, 'via-d.json'));
  const viaDirectory = ownedPath(root, join(root, 'via-processes'));
  await mkdir(viaDirectory, { mode: 0o700 });
  ledger.update(l => { l.viaDirectory = viaDirectory; });
  await writeFile(descriptorPath, JSON.stringify({ root, env: sides.dest.env, log: viaLog, ledgerPath: ledger.path, socket: sockets.dest, viaDirectory }), { mode: 0o600 });
  const via = ownedPath(root, join(bin, 'via-d'));
  await writeFile(via, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('../fixtures/via.mjs', import.meta.url)))} ${quote(descriptorPath)} "$@"\n`); await chmod(via, 0o700);
  ledger.update(l => { l.machines.push({ side: 'local', name: DEST_MACHINE }); });
  ok(await hc(['machine', 'add', '--via', via, '--name', DEST_MACHINE, '--session', 'd', '--json']), 'machine add');
  const machines = ok(await hc(['machine', 'ls', '--json']), 'machine ls').machines;
  const machine = Array.isArray(machines) ? machines.find(m => (m as { name?: unknown }).name === DEST_MACHINE) as Record<string, unknown> | undefined : undefined;
  if (!machine || machine.id !== descriptors.dest.coreId) throw new HarnessError('isolation-unproved', 'the --via machine does not reach the destination core', machines);

  return {
    local: descriptors.local, dest: descriptors.dest, machine: DEST_MACHINE, wrapper, recordLog, viaLog, hc,
    async records() { return (await readFile(recordLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as HcRecord); },
  };
}
