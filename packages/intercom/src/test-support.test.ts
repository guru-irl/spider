import { expect, it } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startTestBroker, stopTestBroker, testBrokerEnv, testTmpDir } from './test-support.js';

it.each(['HOME', 'PI_CODING_AGENT_DIR'])('Test broker refuses non-fixture roots for %s', key => {
  expect(() => startTestBroker(process.execPath, ['-e', 'throw new Error("must not spawn")'], {
    env: { ...testBrokerEnv(), [key]: resolve('.') }, stdio: 'ignore',
  })).toThrow('Test broker refuses non-fixture roots');
});

it('requires explicit fixture roots', () => {
  expect(() => startTestBroker(process.execPath, [], { env: {} })).toThrow('Test broker requires explicit fixture roots');
});

it('refuses symlinked fixture roots', () => {
  const root = mkdtempSync(join(testTmpDir(), 'guard-'));
  try {
    mkdirSync(join(root, 'target'));
    symlinkSync(join(root, 'target'), join(root, 'link'), 'dir');
    expect(() => startTestBroker(process.execPath, [], { env: { ...testBrokerEnv(), HOME: join(root, 'link') } })).toThrow('Test broker refuses symlinked or unowned fixture roots');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('refuses to signal a process handle it did not start', async () => {
  await expect(stopTestBroker(new ChildProcess())).rejects.toThrow('Refusing to signal an unowned broker');
});
