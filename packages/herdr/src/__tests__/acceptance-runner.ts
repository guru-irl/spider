// SPDX-License-Identifier: MIT
import { expect } from 'vitest';
import type { AcceptanceMode } from '../contracts.js';
import type { AcceptanceScenario } from './testutil.js';
import { createAcceptanceHarness } from './scenario-setup.js';

export const modes: AcceptanceMode[] = ['fake'];
if (process.env.SPIDER_HERDR_E2E === '1') modes.push(process.env.SPIDER_HERDR_APP_E2E === '1' ? 'app' : 'hc');

export async function run(mode: AcceptanceMode, scenario: AcceptanceScenario): Promise<void> {
  const h = await createAcceptanceHarness(mode);
  try { await h.start(); await scenario(h); }
  finally { await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
}
