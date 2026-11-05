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

test('the tab look setting defaults on and accepts a boolean opt-out', () => {
  const base = { ...config, machines: [] };
  expect(parseHerdrConfig(base)).toMatchObject({ look: { autoHideTabs: true } });
  expect(parseHerdrConfig({ ...base, look: { autoHideTabs: false } })).toMatchObject({ look: { autoHideTabs: false } });
  for (const autoHideTabs of ['false', 0, null, {}]) expect(() => parseHerdrConfig({ ...base, look: { autoHideTabs } })).toThrow(/autoHideTabs/);
});

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

test('new configs default to panes and allow a global tabs choice with per-space overrides', () => {
  const base = { ...config, machines: [], spaces: [{ name: 'Group', sessions: [] }] };
  expect(parseHerdrConfig(base)).toMatchObject({ layout: 'panes' });
  expect(parseHerdrConfig({ ...base, layout: 'tabs', spaces: [{ name: 'Group', layout: 'panes', sessions: [] }] })).toMatchObject({ layout: 'tabs', spaces: [{ layout: 'panes' }] });
  expect(parseHerdrConfig({ ...base, spaces: [{ name: 'Group', layout: 'tabs', sessions: [] }] }).spaces[0]).toMatchObject({ layout: 'tabs' });
});
test('invalid global and per-space layout choices are rejected', () => {
  for (const layout of ['grid', '', null, 2, {}]) {
    expect(() => parseHerdrConfig({ ...config, machines: [], layout })).toThrow();
    expect(() => parseHerdrConfig({ ...config, machines: [], spaces: [{ name: 'Group', sessions: [], layout }] })).toThrow();
  }
});

test('automatic subagent panes are off by default and accept only an explicit boolean opt-in', () => {
  const base = { ...config, machines: [] };
  expect(parseHerdrConfig(base)).toMatchObject({ automaticSubagentPanes: false });
  expect(parseHerdrConfig({ ...base, automaticSubagentPanes: true })).toMatchObject({ automaticSubagentPanes: true });
  expect(parseHerdrConfig({ ...base, automaticSubagentPanes: false })).toMatchObject({ automaticSubagentPanes: false });
  for (const automaticSubagentPanes of ['true', 1, null, {}]) expect(() => parseHerdrConfig({ ...base, automaticSubagentPanes })).toThrow();
});
