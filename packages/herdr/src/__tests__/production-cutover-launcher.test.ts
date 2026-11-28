// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writePrivateJson } from '../sessions/registry.js';
import { readCutoverRecovery } from '../spaces/setup.js';
import { fixture, until, realCoreAvailable, registerJournalCrashTests } from './production-cutover-fixture.js';
if (process.env.SPIDER_HERDR_E2E === '1' && !realCoreAvailable) console.warn('Skipping isolated core acceptance: hc is not installed');
for (const mode of ['fake', 'hc'] as const) {
  const test = mode === 'hc' ? it.skipIf(process.env.SPIDER_HERDR_E2E !== '1' || !realCoreAvailable) : it;
  test(`a finished failed cutover launcher is retried on rerun (${mode})`, async () => {
    const f = await fixture(mode);
    try {
      await writePrivateJson(f.control, { earlyExit: true });
      const first = f.run(['setup-cutover']);
      await until(async () => { const placement = (await readCutoverRecovery(join(f.request.config.globalRoot, 'herdr/spaces'))).createdTabs[0]; return placement ? (await f.h.hc.get(placement.terminal)).state === 'finished' : false; });
      const failure = await Promise.race([first.result, delay(5000).then(() => null)]);
      if (!failure) first.child.kill('SIGKILL');
      expect(failure).not.toBeNull(); expect(failure?.code).not.toBe(0);
      const old = (await readCutoverRecovery(join(f.request.config.globalRoot, 'herdr/spaces'))).createdTabs[0]; expect(old).toBeDefined();
      await writePrivateJson(f.control, {});
      const retry = await f.run(['setup-cutover']).result; expect(retry.code, retry.stderr).toBe(0);
      const recovery = await readCutoverRecovery(join(f.request.config.globalRoot, 'herdr/spaces')); expect(recovery.createdTabs).toHaveLength(1); expect(recovery.createdTabs[0].terminal).not.toBe(old.terminal);
      await f.stopOwners();
    } finally { await f.h.close(); }
  }, 60000);
  registerJournalCrashTests(test, mode, ["spaces:3","installer:2"]);
}
