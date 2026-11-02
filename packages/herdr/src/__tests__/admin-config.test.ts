// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseHerdrConfig } from '../config.js';

const config = {
  app: { binary: '/bin/app', home: '/app' }, core: { binary: '/bin/hc', config: '/core' },
  agentDirectory: '/agent', globalRoot: '/global', shellRc: '/shell', spaces: [], machines: [],
};
test('config preserves the user-approved wrapper path and sha256', () => {
  const wrapper = { path: '/opt/admin-wrapper', sha256: 'a'.repeat(64) };
  expect(parseHerdrConfig({ ...config, admin: { wrappers: [wrapper] } }).admin.wrappers).toEqual([wrapper]);
});
test('path-only approval fails with the current digest for deliberate review', async () => {
  const root = await mkdtemp(resolve('.spider/scratch/admin-config-'));
  try {
    const path = join(root, 'wrapper'); const bytes = '#!/bin/sh\nexit 0\n';
    await writeFile(path, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const parse = () => parseHerdrConfig({ ...config, admin: { wrappers: [path] } });
    expect(parse).toThrow(`Current sha256: ${digest}`);
    expect(parse).toThrow(path);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('unreadable path-only approval identifies the wrapper without inventing a digest', () => {
  expect(() => parseHerdrConfig({ ...config, admin: { wrappers: ['/nonexistent/admin-wrapper'] } })).toThrow('/nonexistent/admin-wrapper');
});
test('invalid wrapper digests and relative identities are rejected clearly', () => {
  for (const sha256 of ['', 'a'.repeat(63), 'z'.repeat(64)]) {
    expect(() => parseHerdrConfig({ ...config, admin: { wrappers: [{ path: '/opt/wrapper', sha256 }] } })).toThrow('Wrapper sha256 must be 64 lowercase hexadecimal characters');
  }
  expect(() => parseHerdrConfig({ ...config, admin: { wrappers: [{ path: 'relative', sha256: 'a'.repeat(64) }] } })).toThrow();
});
