// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, it } from 'vitest';
import { createTransportPolicy } from '../ssh/admin.js';
import { createSshPolicyReader } from '../ssh/policy.js';
import { guardHerdrToolCall, type RoutingPorts } from '../ssh/register.js';
import type { MachineSnapshot } from '../ssh/cache.js';

const snapshot = {
  version: 1,
  identity: { coreId: 'core' as MachineSnapshot['identity']['coreId'], socket: '/socket', sessionNamespace: 'fixture' },
  fetchedAt: 1000,
  machines: [{ id: 'one', name: 'alpha', targets: ['alpha.invalid'] }],
} as MachineSnapshot;

function guard(cache: MachineSnapshot | null, now: number, environment: NodeJS.ProcessEnv = {}) {
  const policy = createTransportPolicy(createSshPolicyReader(async () => cache, () => now), () => environment);
  const ports = { enabled: () => true, policy } as RoutingPorts;
  return (code: string) => guardHerdrToolCall({ toolName: 'spider', input: { action: 'exec', language: 'shell', code } }, ports);
}

const localCommands = [
  "for c in abc def; do git for-each-ref --points-at $c --format='%(refname:short)' refs/heads; done",
  'for b in one two; do git show $b:packages/host/src/herdr/child.ts; done',
  'cat > notes <<EOF\nhead $(git rev-parse HEAD)\nEOF\n',
  'git show alpha.invalid:some/file',
  'git status alpha.invalid:some/file',
  'git fetch origin alpha.invalid:refs/heads/main',
  'git fetch -o alpha.invalid:option origin',
  'git pull --strategy alpha.invalid:strategy origin',
  'git clone --revision alpha.invalid:branch origin',
  'git send-pack --remote alpha.invalid:label origin HEAD',
  'git -C alpha.invalid:folder status',
  "git show 'unfinished",
  "echo 'unfinished git",
];

describe('Git SSH preflight', () => {
  it.each(localCommands.flatMap(code => [[code, snapshot, 1000], [code, snapshot, 121000], [code, null, 1000]] as const))
  ('allows local Git with a valid, stale, or missing machine list: %s', async (code, cache, now) => {
    expect(await guard(cache, now)(code)).toBeUndefined();
  });

  it.each([
    'git fetch alpha.invalid:repo',
    'git pull ssh://alpha.invalid/repo',
    'git push alpha.invalid:repo main',
    'git clone alpha.invalid:repo',
    'git ls-remote alpha.invalid:repo',
    'git fetch-pack alpha.invalid:repo',
    'git send-pack alpha.invalid:repo main',
    'git archive --remote=ssh://alpha.invalid/repo HEAD',
    'git -C work fetch alpha.invalid:repo',
    'git fetch --recurse-submodules alpha.invalid:repo',
    'git pull --recurse-submodules alpha.invalid:repo',
    'git clone --recurse-submodules alpha.invalid:repo',
    'git push --repo=alpha.invalid:repo',
    'git push --repo alpha.invalid:repo',
    'git fetch -m origin alpha.invalid:repo',
    'git remote add -f upstream alpha.invalid:repo',
    'git remote add --fetch upstream alpha.invalid:repo',
    'git remote add -ft main upstream alpha.invalid:repo',
    'git remote add -f --track main upstream alpha.invalid:repo',
    'cat <<EOF\n$(git fetch alpha.invalid:repo)\nEOF\n',
  ])('blocks a network Git route to a managed machine: %s', async code => {
    expect(await guard(snapshot, 1000)(code)).toMatchObject({ block: true, reason: expect.stringContaining('managed') });
  });

  it('uses the positional push repository before --repo', async () => {
    expect(await guard(snapshot, 1000)('git push --repo=alpha.invalid:repo other.invalid:repo HEAD')).toBeUndefined();
  });

  it.each([snapshot, null])('keeps network routes fail-closed without a current list', async cache => {
    expect(await guard(cache, 121000)('git fetch alpha.invalid:repo')).toMatchObject({ block: true });
    expect(await guard(cache, 121000)("git -C work fetch 'alpha.invalid:repo")).toMatchObject({ block: true });
  });

  it.each([
    'GIT_SSH_COMMAND="ssh -J alpha.invalid" git fetch',
    'GIT_SSH=/usr/bin/ssh git fetch',
    'git -c core.sshCommand="ssh -J alpha.invalid" fetch',
    'git clone -c core.sshCommand=/usr/bin/ssh origin',
    'GIT_SSH=/usr/bin/ssh git submodule update',
    'GIT_SSH=/usr/bin/ssh git submodule sync',
  ])('checks explicit SSH overrides for network Git: %s', async code => {
    expect(await guard(snapshot, 1000)(code)).toMatchObject({ block: true });
  });

  it.each(["echo 'unfinished ssh", 'GIT_SSH=/usr/bin/ssh git fetch', 'ssh -p', 'SPIDER_HERDR_SSH_BYPASS=1 true'])
  ('does not send a destinationless refusal to a remote machine: %s', async code => {
    const result = await guard(snapshot, 1000)(code);
    expect(result).toMatchObject({ block: true });
    expect(result?.reason).not.toContain('on:<machine>');
  });
});
