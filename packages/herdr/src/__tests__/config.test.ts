// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { parseHerdrConfig } from '../config.js';

const config = {
  app: { binary: '/bin/app', home: '/app' }, core: { binary: '/bin/hc', config: '/core' },
  agentDirectory: '/agent', globalRoot: '/global', shellRc: '/shell', spaces: [],
};
const machine = {
  name: 'destination.invalid', aliases: [],
  runtime: { cwd: null, directory: '/runtime', commands: { javascript: ['node'] } },
};

test('preserves each configured per-machine nodePath', () => {
  const parsed = parseHerdrConfig({ ...config, machines: [
    { ...machine, nodePath: '/bin/node-a' },
    { ...machine, name: 'other.invalid', nodePath: '/opt/node-b' },
  ] });
  expect(parsed.machines).toMatchObject([
    { name: 'destination.invalid', nodePath: '/bin/node-a' },
    { name: 'other.invalid', nodePath: '/opt/node-b' },
  ]);
});

test('rejects a relative configured nodePath', () => {
  expect(() => parseHerdrConfig({ ...config, machines: [{ ...machine, nodePath: 'bin/node' }] })).toThrow();
});

test('leaves an omitted nodePath available for destination PATH resolution', () => {
  expect(parseHerdrConfig({ ...config, machines: [machine] }).machines[0]).not.toHaveProperty('nodePath');
});
