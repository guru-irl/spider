// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { createJobStore } from '../jobs/store.js';
import { parseHerdrConfig } from '../config.js';
import { finish, monitorFixture, on, program } from './herdr-monitor-fixture.js';

const withoutApp = {
  core: { binary: '/bin/hc', config: '/core/config.toml' },
  agentDirectory: '/agent', globalRoot: '/global', shellRc: '/shellrc', spaces: [], machines: [],
};

test('core-only loads without app configuration', () => {
  const input = { ...withoutApp, mode: 'core-only' as const };
  expect(() => parseHerdrConfig(input)).not.toThrow();
  const config = parseHerdrConfig(input);
  expect(config.mode).toBe('core-only');
  expect(config.app).toBeUndefined();
  expect(config.core.binary).toBe('/bin/hc');
  const { spaces: _spaces, ...noSpaces } = input;
  expect(parseHerdrConfig(noSpaces).spaces).toEqual([]);
}, 5000);

test('a headless job monitor records and completes a job without an app', async () => {
  const fixture = await monitorFixture();
  const jobs = fixture.monitor();
  const handle = await jobs.start(program, fixture.owner, on, {});
  fixture.complete(handle.address);
  await expect(handle.finished).resolves.toEqual(finish);
  const saved = await createJobStore(fixture.f.root, fixture.owner.sessionId).read();
  expect(saved.jobs).toEqual(expect.arrayContaining([expect.objectContaining({ id: handle.id, phase: expect.objectContaining({ kind: 'finished' }) })]));
  expect(fixture.errors).toEqual([]);
}, 5000);
