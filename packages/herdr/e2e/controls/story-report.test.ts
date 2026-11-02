import { describe, expect, it } from 'vitest';
import { failureStatus, storyOptions, suiteEvidence } from './story-report.js';
import { storyId } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';

describe('central story reporting', () => {
  it('passes the scenario script through the fixed SuiteOptions union', () => {
    const definition = { id: storyId('S55'), title: 'cleanup', tiers: ['ci'] as const, script: { scripts: { hello: [{ steps: [{ text: 'hello' }] }] } }, run: async () => {} };
    expect(storyOptions(definition, { tier: 'ci' })).toEqual({ tier: 'ci', story: 'S55', script: { story: 'S55', ...definition.script } });
    expect(storyOptions(definition, { tier: 'app', displayUuid: 'owned-display', consent: true })).toMatchObject({ displayUuid: 'owned-display', consent: true });
  });
  it('links actual retained evidence and the independent cleanup proof, not a guessed root', () => {
    const suite = { root: '/owned/fixture', evidenceDirectory: '/owned/_evidence/S55/id', cleanupProofPath: '/owned/_ledgers/id.cleanup.json', ledger: { path: '/owned/_ledgers/id.json' } } as Suite;
    expect(suiteEvidence(suite)).toEqual({ fixtureRoot: suite.root, evidenceDirectory: suite.evidenceDirectory, cleanupProofPath: suite.cleanupProofPath, ledgerPath: suite.ledger.path });
  });
  it('uses foundation prerequisite codes and makes failed cleanup dominate a blocked body', () => {
    for (const code of ['missing-prerequisite', 'missing-adapter', 'app-consent-required', 'P2-native-rendered-ui-input-hook', 'HERDR_E2E_PREREQUISITE']) expect(failureStatus({ code })).toBe('blocked');
    expect(failureStatus({ code: 'cleanup-unproved', prerequisite: 'input-hook' }, true)).toBe('failed');
    expect(failureStatus(new Error('bad assertion'))).toBe('failed');
  });
});
