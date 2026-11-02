import { describe, expect, it } from 'vitest';
import { matchesComposedFailure } from './behavioral.js';

describe('composed control assertion identity', () => {
  it('recognizes the exact transcript wait and per-job duplicate count, not other failures', () => {
    expect(matchesComposedFailure('wrong-transcript-path', { code: 'wait-deadline', message: 'wait-deadline: viewer output VIEW_TRANSCRIPT_TAIL_α界', details: { last: 'running transcript-missing' } })).toBe(true);
    expect(matchesComposedFailure('wrong-transcript-path', { code: 'wait-deadline', message: 'wait-deadline: provider gate', details: { last: 'pending' } })).toBe(false);
    expect(matchesComposedFailure('duplicated-notice', { code: 'ERR_ASSERTION', message: 'exact per-job persisted notice count', expected: 1, actual: 2 })).toBe(true);
    expect(matchesComposedFailure('duplicated-notice', { code: 'ERR_ASSERTION', message: 'exact per-job persisted notice count', expected: 1, actual: 0 })).toBe(false);
    expect(matchesComposedFailure('duplicated-notice', { code: 'ERR_ASSERTION', message: 'child count', expected: 1, actual: 2 })).toBe(false);
  });
  it('requires the main identity equality in the panes story rather than any pane-shaped error', () => {
    const failure = { name: 'AssertionError', message: 'main-pane-layout-preserved: changed', expected: [{ terminal: 'owned', pane: 'main' }], actual: [undefined], stack: 'at scenarios/panes.test.ts:24:3' };
    expect(matchesComposedFailure('main-pane-mutation', failure)).toBe(true);
    expect(matchesComposedFailure('main-pane-mutation', { ...failure, stack: 'at scenarios/sidebar.test.ts:24:3' })).toBe(false);
    expect(matchesComposedFailure('main-pane-mutation', { message: 'pane allocation failed' })).toBe(false);
    expect(matchesComposedFailure('main-pane-mutation', { ...failure, actual: failure.expected })).toBe(false);
  });
  it('accepts only the marked main-focus guard with an actual focus change', () => {
    const failure = { name: 'AssertionError', message: 'main-pane-focus-preserved: changed', expected: { agent: 't2' }, actual: { agent: 't9' }, stack: 'at scenarios/panes.test.ts:118:3' };
    expect(matchesComposedFailure('main-pane-mutation', failure)).toBe(true);
    expect(matchesComposedFailure('main-pane-mutation', { ...failure, actual: { agent: 't2' } })).toBe(false);
    expect(matchesComposedFailure('main-pane-mutation', { ...failure, stack: 'at scenarios/sidebar.test.ts:118:3' })).toBe(false);
  });
  it('rejects untagged pane-array and generic object match failures', () => {
    expect(matchesComposedFailure('main-pane-mutation', { name: 'AssertionError', expected: [{ terminal: 't2', pane: 'p2' }], actual: [], stack: 'at scenarios/panes.test.ts:117:3' })).toBe(false);
    expect(matchesComposedFailure('main-pane-mutation', { name: 'AssertionError', message: 'expected toMatchObject', expected: { agent: 't2' }, actual: { agent: 't9' }, stack: 'at scenarios/panes.test.ts:118:3' })).toBe(false);
  });
});
