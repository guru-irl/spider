// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
// @ts-ignore The JavaScript runner boundary is exercised at runtime.
import { parseOptions, profileIds, storyWorkers } from '../../../../scripts/herdr-e2e.mjs';

function matrixFor(input: string): { story: string; timeout: number }[] {
  const result = spawnSync(process.execPath, ['packages/herdr/e2e/controls/ci-matrix.mjs', input], { cwd: process.cwd(), encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout).include;
}

it('selects R20 as a one-worker opt-in', () => {
  expect(matrixFor('R20')).toEqual([{ story: 'R20', timeout: 5 }]);
  const defaultIds = matrixFor('').map(({ story }) => story);
  expect(defaultIds).toEqual(['R18', 'R10', 'R11']);
  expect(profileIds.headless).not.toContain('R20');
  const roamTaskIds = parseOptions(['--tier', 'headless', '--task', 'roam'], {}).ids;
  expect(roamTaskIds).not.toContain('R20');
  const explicitR20 = parseOptions(['--tier', 'headless', '--story', 'R20'], {});
  expect(storyWorkers(explicitR20)).toBe(1);
});
