// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Scenario definitions and selection. Scenario files export `scenarios: readonly ScenarioDefinition[]` and register
// them with registerScenarios(scenarios). A selected ID that no file defines is a failure, not a skip.
import { describe, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError, scratchRoot, type StoryId } from './environment.js';
import { createSuite, type Suite, type SuiteOptions, type Tier } from './suite.js';
import type { ScriptFile } from '../fixtures/scripted-provider.js';

export type { StoryId, Tier };
export interface ScenarioDefinition {
  id: StoryId; title: string; tiers: readonly Tier[];
  /** Optional scripted-provider turns for this story. */
  script?: Omit<ScriptFile, 'story'>;
  coreEnvironment?: Readonly<Record<string, string>>;
  run(suite: Suite): Promise<void>;
}
export type ScenarioStatus = 'passed' | 'failed' | 'blocked' | 'not exercised';
export interface ScenarioResult { id: StoryId; tier: Tier; status: ScenarioStatus; error?: string; code?: string; root?: string; cleanup?: unknown; startedAt: string; finishedAt: string }

export function storyId(value: string): StoryId {
  if (!/^[SHR]\d{2}[a-z0-9-]*$|^H-[a-z0-9-]+$/.test(value)) throw new HarnessError('invalid-story-id', value);
  return value as StoryId;
}

/** Error codes that mean a prerequisite is missing: the story is blocked, which still fails the run. */
const BLOCKING = /^(missing-prerequisite|missing-adapter|app-consent-required|P\d+-)/;

export function selectedTier(env: Readonly<NodeJS.ProcessEnv> = process.env): Tier {
  const tier = env.SPIDER_HERDR_E2E_TIER ?? 'headless';
  if (!['headless', 'remote', 'app', 'ci'].includes(tier)) throw new HarnessError('invalid-tier', tier);
  return tier as Tier;
}
/** Filters by tier and an optional comma-separated ID list; every requested ID must exist. */
export function selectScenarios(all: readonly ScenarioDefinition[], tier: Tier, ids?: readonly string[]): ScenarioDefinition[] {
  const known = new Set(all.map(s => s.id));
  for (const id of ids ?? []) if (!known.has(id as StoryId)) throw new HarnessError('unknown-story', `selected story ${id} is not defined`);
  return all.filter(s => (!ids || ids.includes(s.id)) && s.tiers.includes(tier));
}

function suiteOptions(definition: ScenarioDefinition, tier: Tier): SuiteOptions {
  const script = definition.script ? { ...definition.script, story: definition.id } : undefined;
  const extra = definition.coreEnvironment ? { coreEnvironment: definition.coreEnvironment } : {};
  if (tier === 'app') return { ...extra, tier, story: definition.id, consent: true, displayUuid: process.env.SPIDER_HERDR_TEST_DISPLAY_UUID ?? '', script };
  if (tier === 'remote') return { ...extra, tier, story: definition.id, machine: process.env.SPIDER_HERDR_REAL_MACHINE ?? '', script };
  return { ...extra, tier, story: definition.id, script };
}

export function resultsDirectory(): string { return join(scratchRoot(), 'e2', '_results'); }
/** Creates the suite, runs the story, always closes, and writes a result record outside the fixture root. */
export async function runScenario(definition: ScenarioDefinition, tier: Tier): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  let suite: Suite | undefined; let failure: unknown; let cleanup: unknown;
  try { suite = await createSuite(suiteOptions(definition, tier)); await definition.run(suite); }
  catch (error) { failure = error; }
  finally {
    if (suite) try { cleanup = await suite.close(); } catch (error) { failure ??= error; cleanup = (error as HarnessError).details; }
  }
  const code = (failure as HarnessError | undefined)?.code;
  const result: ScenarioResult = { id: definition.id, tier, status: failure ? (code && BLOCKING.test(code) ? 'blocked' : 'failed') : 'passed',
    ...(failure ? { error: String((failure as Error)?.stack ?? failure), code } : {}), root: suite?.root, cleanup, startedAt, finishedAt: new Date().toISOString() };
  mkdirSync(resultsDirectory(), { recursive: true });
  writeFileSync(join(resultsDirectory(), `${definition.id}.${tier}.json`), JSON.stringify(result, null, 2));
  if (failure) throw failure;
  return result;
}

/** Registers one Vitest test per selected scenario for the tier in SPIDER_HERDR_E2E_TIER. */
export function registerScenarios(scenarios: readonly ScenarioDefinition[], timeoutMs = 300_000): void {
  const tier = selectedTier();
  const ids = process.env.SPIDER_HERDR_E2E_STORIES?.split(',').map(s => s.trim()).filter(Boolean);
  const requested = ids?.filter(id => scenarios.some(s => s.id === id));
  const selected = selectScenarios(scenarios, tier, requested?.length ? requested : undefined);
  describe(`herdr e2e (${tier})`, () => {
    for (const definition of scenarios) {
      if (!selected.includes(definition)) { it.skip(`${definition.id} ${definition.title} [not exercised in ${tier}]`, () => {}); continue; }
      it(`${definition.id} ${definition.title}`, async () => { await runScenario(definition, tier); }, timeoutMs);
    }
  });
}
