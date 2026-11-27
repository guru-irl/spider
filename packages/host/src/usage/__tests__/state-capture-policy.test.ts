import { expect, test } from 'vitest';
import { shouldCaptureState } from '../e2e/state-capture-policy.js';

test('only the problematic session capture is omitted at 1440', () => {
  const widths = [1280, 1440, 1600];
  const states = ['overview-default', 'session-default', 'session-stale'];
  const captured = widths.flatMap(width => states.filter(name => shouldCaptureState(width, name)).map(name => `${width}:${name}`));
  expect(captured).toEqual([
    '1280:overview-default', '1280:session-default', '1280:session-stale',
    '1440:overview-default', '1440:session-stale',
    '1600:overview-default', '1600:session-default', '1600:session-stale',
  ]);
  expect(shouldCaptureState(1441, 'session-default')).toBe(true);
});
