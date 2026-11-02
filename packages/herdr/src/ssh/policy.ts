// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { validSnapshot, type MachineCache, type MachineSnapshot } from './cache.js';
import { parseSshDestinations, shellCommands, commandName, normalizeSshHost, type SshDestination } from './parse.js';
export type SshDecision = { kind: 'allow' } | { kind: 'refuse'; machine?: string; reason: string };
export interface SshPolicy { checkArgv(argv: readonly string[]): Promise<SshDecision>; checkShell(code: string): Promise<SshDecision> }
export function decideSsh(routes: readonly SshDestination[], snapshot: MachineSnapshot | null, now: number): SshDecision {
  const refuse = (reason: string, machine?: string): SshDecision => ({ kind: 'refuse', ...(machine ? { machine } : {}), reason: `${reason}; use spider exec with on:${machine ?? '<machine>'}` });
  if (!snapshot || !validSnapshot(snapshot, now)) return refuse('No valid machine cache: raw SSH is unavailable');
  for (const route of routes) {
    const match = snapshot.machines.find(m => m.targets.some(target => normalizeSshHost(target) === route.host));
    if (match) return refuse('Raw SSH to a managed machine is unavailable', match.name);
  }
  if (routes.some(r => r.ambiguous)) return refuse('SSH destination cannot be classified');
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
        if (result.kind === 'refuse') return result;
      }
      return { kind: 'allow' };
    } catch { return { kind: 'refuse', reason: 'SSH parser failed; use spider exec with on:<machine>' }; }
  };
  return { checkArgv, checkShell };
}
