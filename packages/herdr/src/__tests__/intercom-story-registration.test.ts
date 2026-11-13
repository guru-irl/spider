import { expect, it } from 'vitest';
// @ts-ignore The executable JavaScript runner is tested at its public boundary.
import { parseOptions, profileIds, storyWorkers, buildMatrix } from '../../../../scripts/herdr-e2e.mjs';
it('R14 is selected only in headless acceptance and runs serially', () => {
  expect(parseOptions(['--tier', 'headless', '--story', 'R14'], {}).ids).toEqual(['R14']);
  expect(profileIds.headless).toContain('R14');
  expect(profileIds.ci).not.toContain('R14');
  expect(storyWorkers({ tier: 'headless', ids: ['R14'] })).toBe(1);
  expect(buildMatrix('ci', [], []).find((row: { id: string }) => row.id === 'R14').result).toBe('not exercised');
}, 5000);
