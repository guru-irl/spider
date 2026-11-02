// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Owner } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { HERDR_NOTICES } from '../notices.js';
import { ordinaryExecutionEnvironment } from './shim.js';
import { shellCommands, commandName, parseSshDestinations } from './parse.js';
import { explainHereRefusal, parseFailureDecision, type SshPolicy, type SshDecision } from './policy.js';
export interface WrapperIdentity { path: string; sha256: string }
export interface AdminRequest { owner: Pick<Owner, 'sessionId'>; wrapper: string; reason: string; destination: string; argv?: readonly string[] }
export interface AdminResult { exitCode: number | null; stdout: string; stderr: string }
export interface AdminAuditRow { at: string; pid: number; argv: readonly string[]; owner: string; wrapper: WrapperIdentity; reason: string; destination: string }
export interface AdminTransportRequest { wrapper: WrapperIdentity; destination: string; argv: readonly string[]; env: Readonly<NodeJS.ProcessEnv> }
export interface AdminPolicy { wrappers: readonly WrapperIdentity[]; routing: SshPolicy; environment: Readonly<NodeJS.ProcessEnv>; audit(row: AdminAuditRow): Promise<void>; transport(request: AdminTransportRequest): Promise<AdminResult> }
export async function runHerdrAdmin(request: AdminRequest, policy: AdminPolicy): Promise<AdminResult> {
  const denied = () => new HerdrError('admin-not-authorized', 'Administration requires a configured wrapper identity, reason, and managed destination');
  if (!isAbsolute(request.wrapper) || !request.reason.trim() || request.reason.length > 2048 || /\p{Cc}/u.test(request.reason) || !request.owner.sessionId || !request.destination || /[\s\x00]/.test(request.destination)) throw denied();
  let wrapper: WrapperIdentity;
  try { wrapper = { path: await realpath(request.wrapper), sha256: createHash('sha256').update(await readFile(request.wrapper)).digest('hex') }; }
  catch { throw denied(); }
  // Both canonical path and contents are allowlisted. A familiar basename grants nothing.
  let authorized = false;
  for (const approved of policy.wrappers) {
    try { if (await realpath(approved.path) === wrapper.path && approved.sha256 === wrapper.sha256) { authorized = true; break; } } catch { /* inaccessible allowlist entries do not authorize */ }
  }
  const route = await policy.routing.checkArgv([request.destination]);
  if (!authorized || route.kind !== 'refuse' || !route.machine) throw denied();
  const env = ordinaryExecutionEnvironment(policy.environment);
  await policy.audit({ at: new Date().toISOString(), pid: process.pid, argv: [request.destination, ...request.argv ?? []], owner: request.owner.sessionId, wrapper, reason: request.reason.trim(), destination: request.destination });
  return policy.transport({ wrapper, destination: request.destination, argv: request.argv ?? [], env });
}
const refuse = (_reason: string): SshDecision => ({ kind: 'refuse', reason: HERDR_NOTICES.sshUnclear.text });
const quote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
function endpoint(value: string): string | null {
  if (/^(?:ssh|scp|sftp):\/\//i.test(value)) { try { return new URL(value).hostname; } catch { return '$unknown'; } }
  if (/^(?:https?|file|rsync):\/\//i.test(value) || /^[a-z]:[\\/]/i.test(value)) return null;
  const bracket = /^(?:[^@/]+@)?\[[^\]]+\]:/.exec(value);
  if (bracket) return bracket[0].slice(0, -1);
  const match = /^([^/:]+):([^:].*)?$/.exec(value); return match ? match[1] : null;
}
function assignments(code: string, env: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const match of code.matchAll(/\b(GIT_SSH_COMMAND|GIT_SSH|RSYNC_RSH)=('(?:[^']*)'|"(?:[^"\\]|\\.)*"|[^\s;|&]+)/g)) {
    const words = shellCommands('assignment ' + match[2]); next[match[1]] = words[0]?.[1];
  }
  return next;
}
async function checkOverride(override: string | undefined, host: string | undefined, policy: SshPolicy): Promise<SshDecision> {
  if (!override) return host ? policy.checkArgv([host]) : { kind: 'allow' };
  // Explicit custom transports cannot be introspected. Refuse rather than executing configuration probes.
  const commands = shellCommands(override);
  if (!commands.length || commands.some(c => commandName(c[0]) !== 'ssh')) return refuse('Unsupported explicit SSH transport');
  for (const command of commands) {
    if (!host) {
      if (command[0] !== 'ssh') return refuse('Explicit SSH executable bypasses the runtime shim');
      for (const route of parseSshDestinations(command.slice(1), false)) {
        if (route.ambiguous) return refuse('SSH override destination cannot be classified');
        const result = await policy.checkArgv([route.host]); if (result.kind === 'refuse') return result;
      }
      continue; // The shim receives Git's actual remote destination.
    }
    const result = await policy.checkArgv([...command.slice(1), host]); if (result.kind === 'refuse') return result;
  }
  return { kind: 'allow' };
}
async function copyRoute(name: string, argv: readonly string[], policy: SshPolicy): Promise<SshDecision> {
  const operands: string[] = [], sshOptions: string[] = [];
  const withValue = new Set((name === 'scp' ? 'c D F i J l o P S X' : 'B b c D F i J l o P R S s').split(' '));
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]; if (arg === '--') { operands.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { operands.push(arg); continue; }
    const flag = arg[1];
    if (withValue.has(flag)) {
      const value = arg.slice(2) || argv[++i]; if (value === undefined) return refuse('Incomplete SSH transfer option');
      if (['F', 'J', 'o'].includes(flag)) sshOptions.push('-' + flag, value);
    }
  }
  const hosts = name === 'sftp' ? operands.map(v => endpoint(v) ?? v) : operands.map(endpoint).filter((v): v is string => v !== null);
  for (const host of hosts) { const result = await policy.checkArgv([...sshOptions, host]); if (result.kind === 'refuse') return result; }
  return { kind: 'allow' };
}
function gitTransport(argv: readonly string[], initialOverride: string | undefined): { override: string | undefined; remotes: string[] } | undefined {
  let override = initialOverride, i = 0;
  const globalOperands = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path']);
  while (i < argv.length && argv[i].startsWith('-')) {
    const arg = argv[i++];
    if (arg === '--') break;
    if (arg === '-c' || arg.startsWith('-c')) {
      const config = arg === '-c' ? argv[i++] ?? '' : arg.slice(2);
      if (config.toLowerCase().startsWith('core.sshcommand=')) override = config.slice(config.indexOf('=') + 1);
    } else if (globalOperands.has(arg)) i++;
  }
  const subcommand = argv[i++], rest = argv.slice(i);
  const network = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote', 'fetch-pack', 'send-pack']);
  if (subcommand === 'archive') {
    const remotes: string[] = [];
    for (let n = 0; n < rest.length; n++) {
      if (rest[n] === '--remote') remotes.push(rest[++n] ?? '');
      else if (rest[n].startsWith('--remote=')) remotes.push(rest[n].slice(9));
    }
    return remotes.length ? { override, remotes } : undefined;
  }
  if (subcommand === 'submodule') {
    const action = rest.find(arg => !arg.startsWith('-'));
    return action === 'update' || action === 'sync' ? { override, remotes: [] } : undefined;
  }
  let args = rest, multiple = false;
  let remoteAdd = false;
  if (subcommand === 'remote') {
    const actionIndex = rest.findIndex(arg => !arg.startsWith('-'));
    const action = rest[actionIndex];
    args = rest.slice(actionIndex + 1);
    remoteAdd = action === 'add' && args.some(arg => arg === '--fetch' || arg.startsWith('-f'));
    if (!remoteAdd && (!['show', 'update', 'prune'].includes(action) || action === 'show' && args.includes('-n'))) return undefined;
    multiple = !remoteAdd;
  } else if (!network.has(subcommand)) return undefined;
  const operands = new Set(['--upload-pack', '--receive-pack', '--exec', '--depth', '--deepen', '--shallow-since', '--shallow-exclude', '--filter', '--server-option', '--refmap', '--negotiation-tip', '--jobs', '--branch', '--revision', '--ref-format', '--remote', '--origin', '--reference', '--reference-if-able', '--separate-git-dir', '--template', '--push-option', '--strategy', '--strategy-option', '--cleanup', '--track', '--master']);
  const shortOperands: Record<string, string[]> = {
    fetch: ['-j', '-o'], pull: ['-j', '-o', '-s', '-X'], push: ['-o'], clone: ['-b', '-o', '-j', '-u'], 'ls-remote': ['-o'], 'fetch-pack': [], 'send-pack': [], remote: ['-t', '-m'],
  };
  const remotes: string[] = []; let options = true, pushRepo: string | undefined, position = 0;
  for (let n = 0; n < args.length; n++) {
    const arg = args[n];
    if (options && arg === '--') { options = false; continue; }
    if (options && arg.startsWith('-') && arg !== '-') {
      if (arg === '--multiple' || subcommand === 'fetch' && arg === '-m') multiple = true;
      if (subcommand === 'push' && (arg === '--repo' || arg.startsWith('--repo='))) {
        pushRepo = arg === '--repo' ? args[++n] : arg.slice(7);
      } else if (subcommand === 'clone' && (arg === '-c' || arg.startsWith('-c') || arg === '--config' || arg.startsWith('--config='))) {
        const config = arg === '-c' || arg === '--config' ? args[++n] ?? '' : arg.startsWith('--config=') ? arg.slice(9) : arg.slice(2);
        if (config.toLowerCase().startsWith('core.sshcommand=')) override = config.slice(config.indexOf('=') + 1);
      } else if (operands.has(arg) || subcommand === 'push' && arg === '--recurse-submodules' || remoteAdd && /^-f+[tm]$/.test(arg) || (shortOperands[subcommand] ?? []).includes(arg)) n++;
      continue;
    }
    if (!remoteAdd || position++ === 1) remotes.push(arg);
    if (!multiple && (!remoteAdd || remotes.length)) break;
  }
  if (!remotes.length && pushRepo !== undefined) remotes.push(pushRepo);
  return { override, remotes };
}

export async function preflightTransports(code: string, policy: SshPolicy, env: Readonly<NodeJS.ProcessEnv> = {}): Promise<SshDecision> {
  try {
    const environment = assignments(code, env);
    for (const command of shellCommands(code)) {
      const name = commandName(command[0]), argv = command.slice(1); let result: SshDecision = { kind: 'allow' };
      if (name === 'scp' || name === 'sftp') result = await copyRoute(name, argv, policy);
      else if (name === 'rsync') {
        let override = environment.RSYNC_RSH; const operands: string[] = [];
        for (let i = 0; i < argv.length; i++) {
          const arg = argv[i];
          if (arg === '-e' || arg === '--rsh') override = argv[++i] ?? '$unknown';
          else if (arg.startsWith('--rsh=')) override = arg.slice(6);
          else if (arg.startsWith('-e') && !arg.startsWith('--')) override = arg.slice(2);
          else if (!arg.startsWith('-')) operands.push(arg);
        }
        for (const value of operands) {
          const host = endpoint(value); if (!host) continue;
          result = await checkOverride(override, host, policy); if (result.kind === 'refuse') break;
        }
      } else if (name === 'git') {
        const transport = gitTransport(argv, environment.GIT_SSH_COMMAND ?? environment.GIT_SSH);
        if (transport) {
          const hosts = transport.remotes.map(endpoint).filter((v): v is string => v !== null);
          const httpsOnly = hosts.length === 0 && transport.remotes.some(v => /^https?:\/\//i.test(v));
          if (!httpsOnly) {
            if (hosts.length) for (const host of hosts) { result = await checkOverride(transport.override, host, policy); if (result.kind === 'refuse') break; }
            else if (transport.override) result = await checkOverride(transport.override, undefined, policy);
          }
        }
      } else if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(name)) {
        const index = argv.findIndex(v => /^-[^-]*c/.test(v)); if (index >= 0 && argv[index + 1]) result = await preflightTransports(argv[index + 1], policy, environment);
      }
      if (result.kind === 'refuse') return explainHereRefusal(result, command);
    }
    return { kind: 'allow' };
  } catch (error) { return parseFailureDecision(code, error); }
}
/** Compose this policy into RoutingPorts so direct SSH and explicit transports share one preflight. */
export function createTransportPolicy(policy: SshPolicy, environment: () => Readonly<NodeJS.ProcessEnv> = () => process.env): SshPolicy {
  return { checkArgv: argv => policy.checkArgv(argv), async checkShell(code) {
    const direct = await policy.checkShell(code); return direct.kind === 'refuse' ? direct : preflightTransports(code, policy, environment());
  } };
}
