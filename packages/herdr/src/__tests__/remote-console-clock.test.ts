// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeRuntimePublication, runRemoteConsole } from '../remote/runtime.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
test.each([3000, -3000])('console stays alive across a %i ms source clock skew and ends after expiry', async skew => {
  const root = await mkdtemp(join(tmpdir(), 'console-clock-')); roots.push(root);
  const directory = join(root, '.consoles', 'store'); await mkdir(directory, { recursive: true });
  const lease = join(root, 'lease.json'), start = Date.now();
  await writeFile(lease, JSON.stringify({ version: 1, sessionId: 'session-1', generation: 'generation-1', consoleId: 'console-1', expiresAt: start + skew + 20000 }), { mode: 0o600 });
  await writeFile(join(directory, 'console.json'), encodeRuntimePublication({ version: 1, title: 'Retained output' }), { mode: 0o600 });
  await writeFile(join(directory, 'head.json'), encodeRuntimePublication({ version: 1, count: 0 }), { mode: 0o600 });
  let ticks = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => [start, start + 18000, start + 29000][Math.min(ticks++, 2)]);
  const output: string[] = [];
  await runRemoteConsole(directory, { displayLeaseFile: lease, sessionId: 'session-1', generation: 'generation-1', consoleId: 'console-1', pollMs: 1, write: text => output.push(text) });
  expect(output.join('')).toContain('Retained output');
  expect(JSON.parse(await readFile(join(directory, 'heartbeat.json'), 'utf8')).at).toBe(start + 18000);
  expect(ticks).toBe(3);
  expect(await readFile(join(directory, 'head.json'), 'utf8')).toContain('count');
});
