// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { validSnapshot, type MachineCache, type MachineSnapshot } from './cache.js';
import { HerdrError } from '../client/parse.js';
import { parseSshDestinations, shellCommands, commandName, normalizeSshHost, parseFailureToken, type ShellCommand, type SshDestination } from './parse.js';
import { HERDR_NOTICES } from '../notices.js';
export type SshDecision = { kind: 'allow' } | { kind: 'refuse'; machine?: string; reason: string };
export interface SshPolicy { checkArgv(argv: readonly string[]): Promise<SshDecision>; checkShell(code: string): Promise<SshDecision> }
export function explainHereRefusal(decision: SshDecision, command: ShellCommand): SshDecision {
  if (decision.kind !== 'refuse' || !command.hereSubstitution) return decision;
  return { ...decision, reason: `${decision.reason} ${HERDR_NOTICES.sshHeredoc.text.replace('<command>', JSON.stringify(commandName(command[0])))}` };
}
export function parseFailureDecision(code: string, error: unknown): SshDecision {
  if (!(error instanceof HerdrError) || error.code !== 'ssh-parse-failed') throw error;
  const token = parseFailureToken(code);
  const substitution = error.message === 'Unsupported here-document command substitution';
  const detail = substitution && error.details && typeof error.details === 'object' && 'token' in error.details && typeof error.details.token === 'string' ? error.details.token : undefined;
  const trigger = detail ?? token;
  return trigger ? { kind: 'refuse', reason: HERDR_NOTICES[substitution ? 'sshHeredoc' : 'sshParse'].text.replace('<command>', JSON.stringify(commandName(trigger))) } : { kind: 'allow' };
}
export function decideSsh(routes: readonly SshDestination[], snapshot: MachineSnapshot | null, now: number): SshDecision {
  if (!snapshot || !validSnapshot(snapshot, now)) return { kind: 'refuse', reason: HERDR_NOTICES.sshList.text };
  for (const route of routes) {
    const match = snapshot.machines.find(m => m.targets.some(target => normalizeSshHost(target) === route.host));
    if (match) return { kind: 'refuse', machine: match.name, reason: HERDR_NOTICES.sshManaged.text.replace('<machine>', match.name.replace(/[\x00-\x1f\x7f]/g, '?')) };
  }
  if (routes.some(r => r.ambiguous)) return { kind: 'refuse', reason: HERDR_NOTICES.sshUnclear.text };
  return { kind: 'allow' };
}
export function createSshPolicy(cache: MachineCache, clock: () => number = cache.now): SshPolicy {
  return createSshPolicyReader(async () => { await cache.ready; return cache.snapshot(); }, clock);
}
export function createSshPolicyReader(readSnapshot: () => Promise<MachineSnapshot | null>, clock: () => number = Date.now): SshPolicy {
  const checkArgv = async (argv: readonly string[]) => decideSsh(parseSshDestinations(argv), await readSnapshot(), clock());
  const checkShell = async (code: string): Promise<SshDecision> => {
    try {
      for (const argv of shellCommands(code)) {
        const name = commandName(argv[0]); let result: SshDecision = { kind: 'allow' };
        if (name === 'ssh') result = await checkArgv(argv.slice(1));
        else if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(name)) {
          const option = argv.findIndex(a => /^-[^-]*c/.test(a));
          if (option >= 0 && argv[option + 1] !== undefined) result = await checkShell(argv[option + 1]);
        }
        if (result.kind === 'refuse') return explainHereRefusal(result, argv);
      }
      return { kind: 'allow' };
    } catch (error) { return parseFailureDecision(code, error); }
  };
  return { checkArgv, checkShell };
}
