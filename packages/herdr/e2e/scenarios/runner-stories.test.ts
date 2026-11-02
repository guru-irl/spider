import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, vi } from 'vitest';
import type { ScenarioDefinition } from '../harness/scenario.js';
import { createSuite, type Suite } from '../harness/suite.js';
import { scratchRoot } from '../harness/environment.js';
import { holdCleanupFixture } from '../controls/killed-run.js';
import { failureStatus, storyOptions, suiteEvidence } from '../controls/story-report.js';
// @ts-ignore Runtime-tested JavaScript runner boundary.
import { parseOptions, discoverScenarios, selectScenarios, storyTimeoutMs } from '../../../../scripts/herdr-e2e.mjs';

// Foundation story modules may register themselves for standalone runs. The
// central runner owns registration here; only that test-registration helper is
// suppressed, never the suite, drivers, product hooks or assertions.
vi.mock('../harness/scenario.js', async importOriginal => ({
  ...await importOriginal<typeof import('../harness/scenario.js')>(), registerScenarios: () => {},
}));
const root = process.env.SPIDER_HERDR_E2E_RUN_ROOT;
if (!root) throw new Error('scenario execution requires the central runner');
const options = JSON.parse(process.env.SPIDER_HERDR_E2E_OPTIONS ?? '{}') as ReturnType<typeof parseOptions>;
// @ts-ignore Vite provides import.meta.glob during test transformation.
const modules = import.meta.glob('./*.test.ts') as Record<string, () => Promise<Record<string, unknown>>>;
const selected = selectScenarios(await discoverScenarios(modules), options) as ScenarioDefinition[];
writeFileSync(path.join(root, 'selection.json'), JSON.stringify(selected.map(x => x.id)));
mkdirSync(path.join(root, 'stories'), { recursive: true, mode: 0o700 });
function record(id: string, result: string, reason: string | undefined, startedAt: number, suite: Suite | undefined, cleanup: unknown): void {
  const file = path.join(root!, 'stories', `${id}.json`);
  writeFileSync(`${file}.new`, JSON.stringify({ version: 1, id, tier: options.tier, result, reason, evidence: `stories/${id}.json`, startedAt, finishedAt: Date.now(), inputMarker: id, runnerEvidence: ['vitest.log', 'entries.json'], ...suite && suiteEvidence(suite), cleanup, assertionsReached: result === 'passed' ? 'scenario returned and suite close completed' : 'see reason and retained fixture evidence' }, null, 2));
  renameSync(`${file}.new`, file);
}

describe(`Herdr ${options.tier} stories`, () => {
  if (!selected.length) it('requires at least one discovered story', () => { throw new Error('no stories selected'); });
  for (const story of selected) it(`${story.id} ${story.title}`, async () => {
    const startedAt = Date.now();
    let suite: Suite | undefined;
    let failure: unknown, cleanup: unknown;
    let cleanupFailed = false;
    try {
      suite = await createSuite(storyOptions(story, options));
      const piReceipt = path.join(scratchRoot(), 'e2/_evidence/_pi', `${process.pid}.json`);
      await suite.evidence('pi-resolution.json', JSON.parse(readFileSync(piReceipt, 'utf8')));
      const binaries = path.join(suite.root, 'installed-binaries.json');
      if (existsSync(binaries)) await suite.keepEvidence(binaries);
      if (options.cleanupControl) await holdCleanupFixture(suite, root!, options.cleanupControl);
      else await story.run(suite);
    } catch (error) { failure = error; }
    try { cleanup = await suite?.close(); } catch (error) { cleanupFailed = true; failure = new Error(`cleanup failed: ${String(error)}; scenario: ${String(failure ?? 'returned')}`); cleanup = (error as { details?: unknown }).details; }
    if (failure) {
      record(story.id, failureStatus(failure, cleanupFailed), String((failure as Error).message ?? failure), startedAt, suite, cleanup);
      throw failure;
    }
    record(story.id, 'passed', undefined, startedAt, suite, cleanup);
  }, storyTimeoutMs(story.id));
});
