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

function guard(cache: MachineSnapshot | null = snapshot, now = 1000) {
  const policy = createTransportPolicy(createSshPolicyReader(async () => cache, () => now), () => ({}));
  const ports = { enabled: () => true, policy } as RoutingPorts;
  return (code: string) => guardHerdrToolCall({ toolName: 'spider', input: { action: 'exec', language: 'shell', code } }, ports);
}

describe('SSH checks in shell expansions', () => {
  it.each([
    'echo `/usr/bin/ssh alpha.invalid uptime`',
    'echo "`/usr/bin/ssh alpha.invalid uptime`"',
    'echo "$(/usr/bin/ssh alpha.invalid uptime)"',
    'cat <<< "$(/usr/bin/ssh alpha.invalid uptime)"',
    'cat <<EOF\n`/usr/bin/ssh alpha.invalid uptime`\nEOF\n',
    'cat <<EOF\n$(printf "%s" "$(/usr/bin/ssh alpha.invalid uptime)")\nEOF\n',
    '. /dev/stdin <<EOF\n/usr/bin/ssh alpha.invalid uptime\nEOF\n',
    "source /dev/stdin <<'EOF'\n/usr/bin/ssh alpha.invalid uptime\nEOF\n",
    ". /dev/stdin <<< '/usr/bin/ssh alpha.invalid uptime'",
    'bash -c "$(cat <<EOF\n/usr/bin/ssh alpha.invalid uptime\nEOF\n)"',
    'bash -c "$(cat <<\'EOF\'\n# )\n/usr/bin/ssh alpha.invalid uptime\nEOF\n)"',
    'eval "$(cat <<\'EOF\'\n/usr/bin/ssh alpha.invalid uptime\nEOF\n)"',
    'x=$((1<<2))\n/usr/bin/ssh alpha.invalid uptime\n2\n',
    '((1<<2))\n/usr/bin/ssh alpha.invalid uptime\n2\n',
    '((1 + $(/usr/bin/ssh alpha.invalid uptime)))',
    'echo $((1 + $(/usr/bin/ssh alpha.invalid uptime)))',
  ])('blocks an executed managed route: %s', async code => {
    expect(await guard()(code)).toMatchObject({ block: true });
    expect(await guard(null)(code)).toMatchObject({ block: true });
  });

  it.each([
    'echo $((1<<3)); git status',
    '((1<<3)); git status',
    'x=$((1<<2))\nprintf "%s" "$x"\n2\n',
    "echo '`/usr/bin/ssh alpha.invalid uptime`'",
    'echo \\`/usr/bin/ssh alpha.invalid uptime\\`',
    "cat <<'EOF'\n`/usr/bin/ssh alpha.invalid uptime`\nEOF\n",
    'cat <<EOF\n\\`/usr/bin/ssh alpha.invalid uptime\\`\nEOF\n',
    'cat <<EOF\n`git rev-parse HEAD`\nEOF\n',
    'echo "$(cat <<EOF\n/usr/bin/ssh alpha.invalid uptime\nEOF\n)"',
    'echo "$(cat <<\'EOF\'\n# )\n/usr/bin/ssh alpha.invalid uptime\nEOF\n)"',
  ])('allows local arithmetic or inert text: %s', async code => {
    expect(await guard(null)(code)).toBeUndefined();
  });
});
