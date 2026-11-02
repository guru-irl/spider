// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixtureRoot } from '../environment.js';
import { realHcBinary } from '../hc.js';

afterEach(() => vi.unstubAllEnvs());
it('accepts a test-owned hc binary and rejects an unowned override', async () => {
  const root = await createFixtureRoot();
  try {
    const binary = join(root, 'hc'); await writeFile(binary, 'fixture'); await chmod(binary, 0o700);
    vi.stubEnv('SPIDER_HERDR_E2E_HC', binary);
    expect(realHcBinary()).toBe(binary);
    vi.stubEnv('SPIDER_HERDR_E2E_HC', '/usr/bin/true');
    expect(() => realHcBinary()).toThrow(/owned|fixture root/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
