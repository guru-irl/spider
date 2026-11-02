// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createSuite } from '../../harness/suite.js';
import { storyId } from '../../harness/scenario.js';
import { stageChildSsh } from '../child-scripts.js';

it('executes the declared fixture command in owned cwd and records its real argv', async () => {
  const suite = await createSuite({ tier: 'ci', story: storyId('H-task4-ssh') });
  try {
    const ssh = await stageChildSsh(suite);
    const result = await suite.invoke(ssh.binary, ['dest.invalid', ssh.command], suite.env);
    expect(result).toEqual({ exitCode: 0, stdout: `SSH_COMMAND_EXECUTED\n${ssh.cwd}\n`, stderr: '' });
    expect(await readFile(ssh.effect, 'utf8')).toBe('SSH_EXECUTION_EFFECT\n');
    const unmanaged = await suite.invoke(ssh.binary, [ssh.unmanagedAlias, ssh.command], suite.env); expect(unmanaged.exitCode).toBe(0);
    expect(unmanaged.stdout).toBe(`SSH_COMMAND_EXECUTED\n${ssh.cwd}\n`);
    expect(await readFile(ssh.effect, 'utf8')).toBe('SSH_EXECUTION_EFFECT\nSSH_EXECUTION_EFFECT\n');
    const rows = await ssh.calls(); expect(rows).toHaveLength(2); expect(rows.map(row => row.argv)).toEqual([['dest.invalid', ssh.command], [ssh.unmanagedAlias, ssh.command]]); expect(rows[0].cwd).toBe(ssh.cwd);
  } finally { expect((await suite.close()).clean).toBe(true); }
});
it('records and refuses foreign aliases and undeclared commands without effects', async () => {
  const suite = await createSuite({ tier: 'ci', story: storyId('H-task4-ssh-refuse') });
  try {
    const ssh = await stageChildSsh(suite);
    const foreign = await suite.invoke(ssh.binary, ['other.invalid', ssh.command], suite.env);
    expect(foreign.exitCode).toBe(92); expect(foreign.stderr).toContain('refusing non-fixture alias');
    const forbidden = `${ssh.cwd}/undeclared`; const command = `touch '${forbidden}'`;
    const undeclared = await suite.invoke(ssh.binary, ['dest.invalid', command], suite.env);
    expect(undeclared.exitCode).toBe(92); expect(undeclared.stderr).toContain('refusing undeclared fixture command');
    expect(await readFile(ssh.effect, 'utf8').catch(() => null)).toBe(null);
    expect((await ssh.calls()).map(r => r.argv)).toEqual([['other.invalid', ssh.command], ['dest.invalid', command]]);
    expect(await readFile(forbidden, 'utf8').catch(() => null)).toBe(null);
  } finally { expect((await suite.close()).clean).toBe(true); }
});
