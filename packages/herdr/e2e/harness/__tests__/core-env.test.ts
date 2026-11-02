// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSuite, type Suite } from '../suite.js';
import { storyId, type ScenarioDefinition } from '../scenario.js';
import { storyOptions } from '../../controls/story-report.js';
import { waitFor, deadline } from '../wait.js';

async function actualCoreVariable(suite: Suite, side: 'local' | 'dest'): Promise<string> {
  const path = suite.ownPath(join(suite.root, `core-env-${side}`));
  const result = await suite.hc(['run', '--json', '--bg', '--no-notify', '--outlive-parent', '--', '/bin/sh', '-c', `printf '%s' "\${E2E_CORE_ONLY-absent}" > '${path}'`], side);
  expect(result.exitCode, result.stderr).toBe(0);
  return waitFor('real core environment effect', () => readFile(path, 'utf8').catch(() => ''), value => value.length > 0, deadline(10000));
}
it('carries only an explicit per-story core environment through the central runner adapter', () => {
  const definition: ScenarioDefinition = { id: storyId('H-core-env-adapter'), title: 'adapter', tiers: ['headless'], async run() {} };
  expect(storyOptions(definition, { tier: 'headless' })).toEqual({ tier: 'headless', story: definition.id, script: undefined });
  const coreEnvironment = { E2E_CORE_ONLY: 'owned-value' };
  expect(storyOptions({ ...definition, coreEnvironment }, { tier: 'headless' }).coreEnvironment).toEqual(coreEnvironment);
});
it('does not add an extra variable without the coreEnvironment option', async () => {
  const suite = await createSuite({ tier: 'headless', story: storyId('H-core-env-default') });
  try {
    for (const side of ['local', 'dest'] as const) {
      expect(Object.hasOwn(suite.cores![side].env, 'E2E_CORE_ONLY')).toBe(false);
      expect(await actualCoreVariable(suite, side)).toBe('absent');
    }
    expect(Object.hasOwn(suite.env, 'E2E_CORE_ONLY')).toBe(false);
    expect(Object.hasOwn(suite.pi.env, 'E2E_CORE_ONLY')).toBe(false);
  } finally { expect((await suite.close()).clean).toBe(true); }
});
it.each(['HOME', 'HC_SOCKET'])('refuses an extra variable that changes isolation field %s', async key => {
  await expect(createSuite({ tier: 'headless', story: storyId('H-core-env-protected'), coreEnvironment: { [key]: '/not-an-owned-fixture' } })).rejects.toThrow('core-environment-invalid');
});
it('adds an opt-in variable only to both isolated core environments', async () => {
  const suite = await createSuite({ tier: 'headless', story: storyId('H-core-env-opt-in'), coreEnvironment: { E2E_CORE_ONLY: 'owned-value' } });
  try {
    for (const side of ['local', 'dest'] as const) {
      expect(suite.cores![side].env.E2E_CORE_ONLY).toBe('owned-value');
      expect(await actualCoreVariable(suite, side)).toBe('owned-value');
    }
    expect(Object.hasOwn(suite.env, 'E2E_CORE_ONLY')).toBe(false);
    expect(Object.hasOwn(suite.pi.env, 'E2E_CORE_ONLY')).toBe(false);
  } finally { expect((await suite.close()).clean).toBe(true); }
});
