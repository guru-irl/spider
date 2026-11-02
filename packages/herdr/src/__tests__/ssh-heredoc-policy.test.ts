// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, it } from 'vitest';
import { createSshPolicyReader } from '../ssh/policy.js';
import { createTransportPolicy } from '../ssh/admin.js';
import { guardHerdrToolCall, type RoutingPorts } from '../ssh/register.js';
import type { MachineSnapshot } from '../ssh/cache.js';

const snapshot = {
  version: 1,
  identity: { coreId: 'core' as MachineSnapshot['identity']['coreId'], socket: '/socket', sessionNamespace: 'fixture' },
  fetchedAt: 1000,
  machines: [{ id: 'one', name: 'alpha', targets: ['alpha', 'alpha.invalid'] }],
} as MachineSnapshot;
const policy = createTransportPolicy(createSshPolicyReader(async () => snapshot, () => 1000), () => ({}));
const ports = { enabled: () => true, policy } as RoutingPorts;

async function check(code: string, on?: string) {
  return guardHerdrToolCall({ toolName: 'spider', input: { action: 'exec', language: 'shell', code, ...(on ? { on } : {}) } }, ports);
}

describe('heredocs and parse failures in the SSH guard', () => {
  it.each([undefined, 'alpha'])('treats heredoc bodies as data with destination %s', async on => {
    for (const code of [
      "python3 - <<EOF\nssh alpha.invalid\nEOF\n",
      "cat > result <<'EOF'\nssh alpha.invalid\nscp x alpha.invalid:/x\nEOF\n",
      "cat <<-EOF\n\tssh alpha.invalid\n\tEOF\n",
      "cat <<A <<'B'\nssh alpha.invalid\nA\nscp x alpha.invalid:/x\nB\n",
      "cat <<< 'ssh alpha.invalid'",
    ]) expect(await check(code, on)).toBeUndefined();
  });

  it.each([undefined, 'alpha'])('guards covered substitutions in unquoted heredocs with destination %s', async on => {
    for (const [command, token] of [['/usr/bin/ssh alpha.invalid', 'ssh'], ['scp local alpha.invalid:/file', 'scp']]) {
      const active = await check(`cat <<EOF\n$(${command})\nEOF\n`, on);
      expect(active).toMatchObject({ block: true });
      expect(active?.reason.toLowerCase()).toMatch(/substitution/);
      expect(active?.reason.toLowerCase()).toContain(token);
      expect(active?.reason).toMatch(/on:alpha/);
      expect(active?.reason.toLowerCase()).toMatch(/quote.*heredoc.*plain data/);
      expect(await check(`cat <<'EOF'\n$(${command})\nEOF\n`, on)).toBeUndefined();
    }
    expect(await check("cat <<EOF\n$(printf safe)\nEOF\n", on)).toBeUndefined();
    expect(await check("cat <<EOF\n$(printf safe)\nssh is data\nEOF\n", on)).toBeUndefined();
    const scp = await check("cat <<EOF\nssh is data\n$(scp local alpha.invalid:/file)\nEOF\n", on);
    expect(scp?.reason).toContain('"scp"');
    expect(await check("cat <<EOF\n\\$(/usr/bin/ssh alpha.invalid)\nEOF\n", on)).toBeUndefined();
  });

  it.each([undefined, 'alpha'])('checks executed here-string substitutions with destination %s', async on => {
    const code = 'cat <<< "$(/usr/bin/ssh alpha.invalid)"';
    expect(await check(code, on)).toMatchObject({ block: true });
    expect(await policy.checkShell(code)).toMatchObject({ kind: 'refuse', machine: snapshot.machines[0].name });
    expect(await check("cat <<< '$(/usr/bin/ssh alpha.invalid)'", on)).toBeUndefined();
    expect(await check('cat <<< "\\$(/usr/bin/ssh alpha.invalid)"', on)).toBeUndefined();
  });

  it.each([undefined, 'alpha'])('checks commands fed to a shell with destination %s', async on => {
    for (const code of [
      "bash <<EOF\nssh alpha.invalid\nEOF\n",
      "sh <<'EOF'\nscp x alpha.invalid:/x\nEOF\n",
      "zsh <<-EOF\n\tssh alpha.invalid\n\tEOF\n",
      "bash <<< 'ssh alpha.invalid'",
      "cat <<EOF | sh\nssh alpha.invalid\nEOF\n",
    ]) {
      const result = await check(code, on);
      expect(result?.block).toBe(true);
      expect(result?.reason.toLowerCase()).toContain('managed');
    }
  });

  it.each([undefined, 'alpha'])('allows unrelated malformed input and identifies the unsafe token on parse failure with destination %s', async on => {
    expect(await check("echo 'unfinished", on)).toBeUndefined();
    expect(await check("echo 'unfinished git", on)).toBeUndefined();
    for (const token of ['ssh', 'scp', 'sftp', 'rsync']) {
      const result = await check(`echo 'unfinished ${token}`, on);
      expect(result?.block).toBe(true);
      expect(result?.reason.toLowerCase()).toContain(token);
      expect(result?.reason.toLowerCase()).toMatch(/quote|parse/);
    }
  });
});
