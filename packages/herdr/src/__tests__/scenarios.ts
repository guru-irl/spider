// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { HerdrHarness } from './isolated.js';
import { createHerdrHarness } from './isolated.js';
import { HerdrError } from '../client/parse.js';
export type AcceptanceScenario = (h: HerdrHarness) => Promise<void>;
export async function runAcceptance(name: string, scenario: AcceptanceScenario): Promise<void> {
  if (process.env.SPIDER_HERDR_APP_E2E === '1' && process.env.SPIDER_HERDR_E2E !== '1') throw new HerdrError('real-mode-not-enabled', 'SPIDER_HERDR_APP_E2E=1 also requires SPIDER_HERDR_E2E=1');
  const mode = process.env.SPIDER_HERDR_APP_E2E === '1' ? 'app' : process.env.SPIDER_HERDR_E2E === '1' ? 'hc' : 'fake';
  const h = await createHerdrHarness(mode);
  try { await h.start(); await scenario(h); }
  finally { await h.close(); }
}
