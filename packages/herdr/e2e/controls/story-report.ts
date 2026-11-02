import type { ScenarioDefinition } from '../harness/scenario.js';
import type { Suite, SuiteOptions, Tier } from '../harness/suite.js';

export function storyOptions(definition: ScenarioDefinition, options: { tier: Tier; machine?: string; displayUuid?: string; consent?: true }): SuiteOptions {
  const common = { story: definition.id, script: definition.script ? { ...definition.script, story: definition.id } : undefined, ...(definition.coreEnvironment ? { coreEnvironment: definition.coreEnvironment } : {}) };
  if (options.tier === 'app') return { ...common, tier: 'app', displayUuid: options.displayUuid ?? '', consent: true };
  if (options.tier === 'remote') return { ...common, tier: 'remote', machine: options.machine ?? '' };
  return { ...common, tier: options.tier };
}
export function suiteEvidence(suite: Suite): { fixtureRoot: string; evidenceDirectory: string; cleanupProofPath: string; ledgerPath: string } {
  return { fixtureRoot: suite.root, evidenceDirectory: suite.evidenceDirectory, cleanupProofPath: suite.cleanupProofPath, ledgerPath: suite.ledger.path };
}
export function failureStatus(failure: unknown, cleanupFailed = false): 'blocked' | 'failed' {
  if (cleanupFailed) return 'failed';
  const error = failure as { code?: string; prerequisite?: string; message?: string };
  return error?.prerequisite || /^(?:missing-prerequisite|missing-adapter|app-consent-required|P\d+-|HERDR_E2E_PREREQUISITE)$/.test(error?.code ?? '') || /^P\d+-/.test(error?.code ?? '') || /^(?:prerequisite:|blocked:)/i.test(error?.message ?? '') ? 'blocked' : 'failed';
}
