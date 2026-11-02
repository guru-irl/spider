// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { guardHerdrToolCall, type RoutingPorts } from '../ssh/register.js';
import { createSshPolicyReader } from '../ssh/policy.js';

const ports = { enabled: () => true, policy: createSshPolicyReader(async () => null), readShellFile: (path: string) => readFile(path, 'utf8') } as RoutingPorts;
test.each([
  'grep -rn SPIDER_HERDR_SSH_BYPASS docs/',
  'printf "%s\\n" "$SPIDER_HERDR_SSH_BYPASS"',
  'echo "SPIDER_HERDR_SSH_BYPASS=1"',
  'grep "export SPIDER_HERDR_SSH_BYPASS" docs/policy.md',
  'printenv SPIDER_HERDR_SSH_BYPASS',
  'unset SPIDER_HERDR_SSH_BYPASS',
  'declare -p SPIDER_HERDR_SSH_BYPASS',
])('allows a harmless bypass-name read: %s', async command => {
  expect(await guardHerdrToolCall({ toolName: 'bash', input: { command } }, ports)).toBeUndefined();
  expect(await guardHerdrToolCall({ toolName: 'spider', input: { action: 'exec', language: 'shell', code: command } }, ports)).toBeUndefined();
});

test.each(['python', 'javascript'])('allows bypass-name reads in %s exec and batch', async language => {
  const code = language === 'python' ? 'import os; print(os.environ.get("SPIDER_HERDR_SSH_BYPASS"))' : 'console.log(process.env.SPIDER_HERDR_SSH_BYPASS)';
  expect(await guardHerdrToolCall({ toolName: 'spider', input: { action: 'exec', language, code } }, ports)).toBeUndefined();
  expect(await guardHerdrToolCall({ toolName: 'spider', input: { action: 'batch', commands: [{ language, code }] } }, ports)).toBeUndefined();
  const setting = language === 'python' ? 'import os; os.environ["SPIDER_HERDR_SSH_BYPASS"]="1"' : 'process.env.SPIDER_HERDR_SSH_BYPASS="1"';
  expect(await guardHerdrToolCall({ toolName: 'spider', input: { action: 'exec', language, code: setting } }, ports)).toMatchObject({ block: true });
});

test.each([
  ['python', 'print(\'os.environ["SPIDER_HERDR_SSH_BYPASS"]="1"\')'],
  ['javascript', 'console.log("process.env.SPIDER_HERDR_SSH_BYPASS=1")'],
  ['python', '# os.environ["SPIDER_HERDR_SSH_BYPASS"]="1"\nprint("ok")'],
])('allows inert assignment text in %s', async (language, code) => {
  expect(await guardHerdrToolCall({ toolName: 'spider', input: { action: 'exec', language, code } }, ports)).toBeUndefined();
});

test.each(['shell', 'python'])('allows a harmless bypass-name read from %s exec_file', async language => {
  const root = await mkdtemp(resolve('.spider/scratch/bypass-read-'));
  try {
    const path = join(root, 'program');
    await writeFile(path, language === 'shell' ? 'grep SPIDER_HERDR_SSH_BYPASS docs/' : 'import os; print(os.environ.get("SPIDER_HERDR_SSH_BYPASS"))');
    expect(await guardHerdrToolCall({ toolName: 'spider', input: { action: 'exec_file', language, path } }, ports)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
