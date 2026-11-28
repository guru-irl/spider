// SPDX-License-Identifier: MIT
import { it } from 'vitest';
import { realCoreAvailable, registerJournalCrashTests } from './production-cutover-fixture.js';

if (process.env.SPIDER_HERDR_E2E === '1' && !realCoreAvailable) console.warn('Skipping isolated core acceptance: hc is not installed');
for (const mode of ['fake', 'hc'] as const) {
  const test = mode === 'hc' ? it.skipIf(process.env.SPIDER_HERDR_E2E !== '1' || !realCoreAvailable) : it;
  registerJournalCrashTests(test, mode, ["installer:3", "installer:5"]);
}
