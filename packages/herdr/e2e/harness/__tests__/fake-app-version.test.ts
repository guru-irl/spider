// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { stageFakeAppDaemon } from '../fake-app.js';

it('answers every 0.1.12 version spelling without starting or contacting a daemon', async () => {
  const scratch = resolve('.spider/scratch/e2'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'v-'));
  const staged = await stageFakeAppDaemon(root, path => {
    if (!path.startsWith(`${root}/`)) throw new Error('unowned version fixture path');
    return path;
  });
  const before = (await readdir(root)).sort();
  const invoke = async (spelling: string) => {
    try {
      const result = await promisify(execFile)(staged.binary, [spelling], { timeout: 15000, env: { ...process.env, TMPDIR: root } });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const result = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      if (typeof result.code !== 'number' || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw error;
      return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
    }
  };
  for (const spelling of ['-V', '--version', 'version']) {
    expect(await invoke(spelling)).toEqual({ exitCode: 0, stdout: 'herdr-app 0.1.12\n', stderr: '' });
    expect(existsSync(staged.socket)).toBe(false);
    expect((await readdir(root)).sort()).toEqual(before);
  }
  let contacts = 0;
  const trap = createServer(connection => { contacts++; connection.destroy(); });
  await new Promise<void>((done, fail) => { trap.once('error', fail); trap.listen(staged.socket, done); });
  try {
    for (const spelling of ['-V', '--version', 'version']) {
      expect(await invoke(spelling)).toEqual({ exitCode: 0, stdout: 'herdr-app 0.1.12\n', stderr: '' });
    }
    expect(contacts).toBe(0);
  } finally { await new Promise<void>((done, fail) => trap.close(error => error ? fail(error) : done())); }
  expect(existsSync(staged.socket)).toBe(false);
  expect((await readdir(root)).sort()).toEqual(before);
});
