// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { spawn } from 'node:child_process';
import { realpathSync, constants as fsConstants } from 'node:fs';
import { mkdir, writeFile, rename, unlink, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname, basename, win32, isAbsolute, resolve } from 'node:path';
import { constants } from 'node:os';
import type { ExecutionEnvironmentPolicy } from '../contracts.js';
import { HerdrError, object, text } from '../client/parse.js';
import { isCoreAvailable } from '../client/liveness.js';
import { readMachineSnapshot, validSnapshot, type CacheDescriptor } from './cache.js';
import { decideSsh } from './policy.js';
import { normalizeSshHost, parseSshDestinations } from './parse.js';
export type { ExecutionEnvironmentPolicy } from '../contracts.js';
export const SSH_DESCRIPTOR_ENV = 'SPIDER_HERDR_SSH_DESCRIPTOR';
const ADMIN_BYPASS_VALID_MS = 60000;
/** The cache file already carries the core, namespace and socket key. */
export function sshShimDirectory(descriptor: CacheDescriptor): string {
  return join(dirname(descriptor.path), 'bin', basename(descriptor.path, '.json'));
}
export interface EnvironmentPolicyOptions { shimDirectory: string; realSshBinary: string; cacheDescriptor: CacheDescriptor; shimProgram: string; platform?: NodeJS.Platform; platformCheck?: () => { ok: boolean; reason?: string }; reportDisabled?: (reason: string) => void }
function stripped(env: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !/^SPIDER_(?:HERDR_(?:SSH_BYPASS|ADMIN|TRANSPORT|LEASE|JOB|DELEGAT)|SESSION_LEASE)/i.test(key)));
}
function descriptorFromEnv(env: Readonly<NodeJS.ProcessEnv>): EnvironmentPolicyOptions | null {
  if (!env[SSH_DESCRIPTOR_ENV]) return null;
  try {
    const raw = object(JSON.parse(env[SSH_DESCRIPTOR_ENV]!)), cache = object(raw.cacheDescriptor), identity = object(cache.identity);
    return { shimDirectory: text(raw.shimDirectory), realSshBinary: text(raw.realSshBinary), shimProgram: text(raw.shimProgram),
      ...(process.platform === 'win32' ? { platformCheck: () => ({ ok: raw.platformChecked === true, reason: 'Windows environment and transport checks are required' }) } : {}),
      cacheDescriptor: { path: text(cache.path), identity: { coreId: text(identity.coreId) as CacheDescriptor['identity']['coreId'], socket: text(identity.socket), sessionNamespace: text(identity.sessionNamespace) } } };
  } catch { throw new HerdrError('ssh-environment-invalid', 'Invalid SSH environment descriptor; refusing execution'); }
}
function validatePaths(options: EnvironmentPolicyOptions, platform: NodeJS.Platform): void {
  const absolute = platform === 'win32' ? win32.isAbsolute : isAbsolute;
  if (![options.shimDirectory, options.realSshBinary, options.shimProgram, options.cacheDescriptor.path].every(absolute)) throw new HerdrError('ssh-environment-invalid', 'SSH policy paths must be absolute');
  const normalize = platform === 'win32' ? (v: string) => win32.normalize(v).toLowerCase() : resolve;
  if ([join(options.shimDirectory, 'ssh'), join(options.shimDirectory, 'ssh.cmd')].some(v => normalize(v) === normalize(options.realSshBinary))) throw new HerdrError('ssh-self-resolution', 'Real SSH must be resolved before installing the shim');
}
export function createExecutionEnvironmentPolicy(options: EnvironmentPolicyOptions): ExecutionEnvironmentPolicy {
  const platform = options.platform ?? process.platform;
  let check = { ok: true, reason: '' };
  if (!['darwin', 'linux', 'win32'].includes(platform)) check = { ok: false, reason: 'Unsupported SSH enforcement platform' };
  else if (platform === 'win32' && !options.platformCheck) check = { ok: false, reason: 'Windows environment and transport checks are required' };
  else if (options.platformCheck) { const result = options.platformCheck(); check = { ok: result.ok, reason: result.reason ?? 'SSH environment check failed' }; }
  if (!check.ok) {
    options.reportDisabled?.(check.reason);
    return env => { const next = stripped(env); delete next[SSH_DESCRIPTOR_ENV]; return Object.freeze(next); };
  }
  validatePaths(options, platform);
  const serialized = JSON.stringify({ shimDirectory: options.shimDirectory, realSshBinary: options.realSshBinary, shimProgram: options.shimProgram, cacheDescriptor: options.cacheDescriptor, platformChecked: platform === 'win32' });
  return env => {
    const next = stripped(env), separator = platform === 'win32' ? ';' : ':';
    let inherited = next.PATH;
    if (platform === 'win32') {
      const key = Object.keys(next).find(k => k.toUpperCase() === 'PATH'); inherited = inherited ?? (key ? next[key] : undefined);
      for (const key of Object.keys(next)) if (key.toUpperCase() === 'PATH' && key !== 'PATH') delete next[key];
      const extensions = (next.PATHEXT ?? '.COM;.EXE;.BAT').toUpperCase().split(';').filter(e => e !== '.CMD'); next.PATHEXT = ['.CMD', ...extensions].join(';');
    }
    const canonical = platform === 'win32' ? (v: string) => win32.normalize(v).toLowerCase() : (v: string) => v;
    const parts = (inherited ?? '').split(separator).filter(v => v && canonical(v) !== canonical(options.shimDirectory));
    next.PATH = [options.shimDirectory, ...parts].join(separator); next[SSH_DESCRIPTOR_ENV] = serialized;
    return Object.freeze(next);
  };
}
export function ordinaryExecutionEnvironment(env: Readonly<NodeJS.ProcessEnv>): Readonly<NodeJS.ProcessEnv> {
  const options = descriptorFromEnv(env);
  return options ? createExecutionEnvironmentPolicy(options)(env) : Object.freeze(stripped(env));
}
export function finalChildEnvironment(base: Readonly<NodeJS.ProcessEnv>, extra: Readonly<NodeJS.ProcessEnv>, policy?: ExecutionEnvironmentPolicy): Readonly<NodeJS.ProcessEnv> {
  // Child-supplied settings may not replace the parent's active policy descriptor.
  const merged = { ...base, ...extra };
  if (base[SSH_DESCRIPTOR_ENV]) merged[SSH_DESCRIPTOR_ENV] = base[SSH_DESCRIPTOR_ENV];
  return (policy ?? ordinaryExecutionEnvironment)(merged);
}
const quoted = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
async function publishShim(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.new`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o700 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function installSshShim(options: EnvironmentPolicyOptions): Promise<void> {
  validatePaths(options, options.platform ?? process.platform);
  const real = realpathSync(options.realSshBinary);
  for (const file of ['ssh', 'ssh.cmd']) { try { if (realpathSync(join(options.shimDirectory, file)) === real) throw new HerdrError('ssh-self-resolution', 'The real binary resolves to the shim'); } catch (error) { if (error instanceof HerdrError) throw error; } }
  await mkdir(options.shimDirectory, { recursive: true, mode: 0o700 });
  const descriptor = createExecutionEnvironmentPolicy(options)({})[SSH_DESCRIPTOR_ENV]; if (!descriptor) return;
  const path = join(options.shimDirectory, 'ssh');
  await publishShim(path, `#!/bin/sh\nexport ${SSH_DESCRIPTOR_ENV}=${quoted(descriptor)}\nexec ${quoted(process.execPath)} ${quoted(options.shimProgram)} --ssh-shim "$@"\n`);
  if ((options.platform ?? process.platform) === 'win32') {
    // cmd wrapper uses the descriptor inherited from the immutable execution environment.
    await publishShim(join(options.shimDirectory, 'ssh.cmd'), `@echo off\r\n"${process.execPath}" "${options.shimProgram}" --ssh-shim %*\r\n`);
  }
}
async function hasAdminBypass(token: string | undefined, descriptor: CacheDescriptor): Promise<boolean> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  let file;
  try {
    // The installer fixes this root via the cache descriptor, never the bypass variable.
    file = await open(join(dirname(descriptor.path), '../admin/bypass', token), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await file.stat(), age = Date.now() - Math.floor(stat.mtimeMs);
    return age >= 0 && age < ADMIN_BYPASS_VALID_MS && stat.isFile() && (stat.mode & 0o777) === 0o600 && (!process.getuid || stat.uid === process.getuid())
      && await file.readFile('utf8') === token;
  } catch { return false; }
  finally { await file?.close(); }
}
export async function runSshShim(argv: readonly string[], env: Readonly<NodeJS.ProcessEnv> = process.env): Promise<number> {
  try {
    const options = descriptorFromEnv(env); if (!options) throw new HerdrError('ssh-environment-invalid', 'SSH shim requires its machine cache descriptor');
    validatePaths(options, process.platform);
    const real = realpathSync(options.realSshBinary);
    if (real === realpathSync(join(options.shimDirectory, 'ssh'))) throw new HerdrError('ssh-self-resolution', 'Real SSH resolves to the shim');
    // A child or user shell can retain this shim after its owner has gone inactive.
    // Probe the descriptor's socket, never an inherited selection for another core.
    if (await isCoreAvailable({ HC_SOCKET: options.cacheDescriptor.identity.socket })) {
      const routes = parseSshDestinations(argv), snapshot = await readMachineSnapshot(options.cacheDescriptor), now = Date.now();
      // The owner may stop refreshing after core loss. Last-known targets still
      // protect managed routes without blocking confidently unmanaged ones.
      const staleUnmanaged = snapshot && !validSnapshot(snapshot, now) && routes.every(route =>
        !route.ambiguous && !snapshot.machines.some(machine => machine.targets.some(target => normalizeSshHost(target) === route.host)));
      const decision = staleUnmanaged ? { kind: 'allow' as const } : decideSsh(routes, snapshot, now);
      if (decision.kind === 'refuse' && !await hasAdminBypass(env.SPIDER_HERDR_SSH_BYPASS, options.cacheDescriptor)) { process.stderr.write(decision.reason + '\n'); return 126; }
    }
    return await new Promise<number>(resolve => {
      const child = spawn(real, [...argv], { env: { ...env }, stdio: 'inherit' });
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
      const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
      const handlers = signals.map(signal => { const handler = () => forward(signal); process.on(signal, handler); return [signal, handler] as const; });
      const cleanup = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
      child.once('error', error => { cleanup(); process.stderr.write(error.message + '\n'); resolve(127); });
      child.once('close', (code, signal) => { cleanup(); if (signal && process.platform !== 'win32') process.kill(process.pid, signal); resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1)); });
    });
  } catch (error) { process.stderr.write(`SSH policy unavailable: ${String((error as Error).message)}; use spider exec with on:<machine>\n`); return 126; }
}
