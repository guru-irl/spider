// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { guardHerdrToolCall, type RoutingPorts } from '../ssh/register.js';
import { createSshPolicyReader } from '../ssh/policy.js';

const ports = {
  enabled: () => true, policy: createSshPolicyReader(async () => null),
  readShellFile: (path: string) => readFile(path, 'utf8'),
} as RoutingPorts;

test.each([
  { toolName: 'bash', input: { command: 'export SPIDER_HERDR_SSH_BYPASS=1; git push' } },
  { toolName: 'spider', input: { action: 'exec', language: 'shell', code: 'SPIDER_HERDR_SSH_BYPASS=1 python3 -c "pass"' } },
  { toolName: 'functions.spider', input: { action: 'exec', language: 'python', code: 'import os; os.environ["SPIDER_HERDR_SSH_BYPASS"]="1"' } },
  { toolName: 'spider', input: { action: 'batch', commands: [{ language: 'python', code: 'import os; os.environ["SPIDER_HERDR_SSH_BYPASS"]="1"' }] } },
])('refuses bypass-variable input at the tool boundary: $toolName $input.action', async event => {
  expect(await guardHerdrToolCall(event, ports)).toMatchObject({ block: true, reason: expect.stringContaining('SPIDER_HERDR_SSH_BYPASS') });
});
test.each(['shell', 'python'])('refuses bypass-variable source in exec_file language %s', async language => {
  const directory = await mkdtemp(resolve('.spider/scratch/bypass-guard-'));
  try {
    const path = join(directory, 'program'); await writeFile(path, 'SPIDER_HERDR_SSH_BYPASS=1');
    expect(await guardHerdrToolCall({ toolName: 'spider', input: { action: 'exec_file', language, path } }, ports))
      .toMatchObject({ block: true, reason: expect.stringContaining('SPIDER_HERDR_SSH_BYPASS') });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
