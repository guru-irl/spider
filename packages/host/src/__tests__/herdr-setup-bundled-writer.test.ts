// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildViteFixture as build } from '../../../../scripts/test-bundle.js';
import { createBundledFixture } from './herdr-setup-bundled-writer.js';

vi.mock('../../../../scripts/test-bundle.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../scripts/test-bundle.js')>();
  return { ...actual, buildViteFixture: vi.fn(actual.buildViteFixture) };
});

test('builds once and runs the same writer from separate fixture directories', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'herdr-writer-'));
  try {
    const first = join(parent, 'first'), second = join(parent, 'second');
    await mkdir(first); await mkdir(second);
    await writeFile(join(first, 'dependency.ts'), "export const prefix = 'writer:';\n");
    const writer = createBundledFixture('writer', "const dep = await import('./dependency.js'); console.log(dep.prefix + process.argv[2]);\n");
    const one = await writer(first);
    expect(execFileSync(process.execPath, [one, 'one'], { encoding: 'utf8' })).toBe('writer:one\n');
    await rm(first, { recursive: true });
    const two = await writer(second);
    expect(execFileSync(process.execPath, [two, 'two'], { encoding: 'utf8' })).toBe('writer:two\n');
    expect(vi.mocked(build)).toHaveBeenCalledTimes(1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
