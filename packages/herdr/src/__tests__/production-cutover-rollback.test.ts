// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { readJournal, saveJournal } from '../setup/backup.js';
import { rollbackHerdr } from '../setup/installer.js';
import { writePrivateJson } from '../sessions/registry.js';
import { readCutoverRecovery } from '../spaces/setup.js';
import { fixture, until, realCoreAvailable, registerJournalCrashTests } from './production-cutover-fixture.js';

afterEach(() => vi.unstubAllEnvs());
if (process.env.SPIDER_HERDR_E2E === '1' && !realCoreAvailable) console.warn('Skipping isolated core acceptance: hc is not installed');
for (const mode of ['fake', 'hc'] as const) {
  const test = mode === 'hc' ? it.skipIf(process.env.SPIDER_HERDR_E2E !== '1' || !realCoreAvailable) : it;
  registerJournalCrashTests(test, mode, ["spaces:4"]);
  test(`Ctrl-C before the first tab permits rollback then setup (${mode})`, async () => {
    const f = await fixture(mode);
    try {
      const ps = join(f.root, 'bin/ps');
      await writeFile(ps, '#!/bin/sh\nif [ "$1" = -U ]; then printf "999 pi pi\\n"; exit 0; fi\nexec /bin/ps "$@"\n');
      const command = f.run(['setup-cutover']); let output = ''; command.child.stderr.on('data', bytes => output += bytes);
      await until(async () => output.includes('/reload in that session'));
      command.child.kill('SIGINT'); const aborted = await command.result; expect(aborted.code).not.toBe(0);
      expect((await readCutoverRecovery(join(f.request.config.globalRoot, 'herdr/spaces'))).createdTabs).toEqual([]);
      expect((await readJournal(f.request.journalRoot)).cutoverPending).toBe(true);
      const rollback = await f.run(['rollback', '--config', f.request.configPath]).result; expect(rollback.code, rollback.stderr).toBe(0);
      await writeFile(ps, '#!/bin/sh\nif [ "$1" = -U ]; then exit 0; fi\nexec /bin/ps "$@"\n');
      const again = await f.run(['setup-cutover']).result; expect(again.code, again.stderr).toBe(0); await f.stopOwners();
    } finally { await f.h.close(); }
    expect(await f.h.remainingOwnedResources()).toEqual([]);
  }, 60000);
  test(`pending cutover with no tab can rollback and set up again (${mode})`, async () => {
    const f = await fixture(mode); vi.stubEnv('PATH', join(f.root, 'bin') + ':' + process.env.PATH);
    const ports = createProductionHerdrCliPorts(f.root, f.h.localEnv);
    try {
      const journal = await readJournal(f.request.journalRoot); journal.cutoverPending = true; await saveJournal(f.request.journalRoot, journal);
      const parts = await ports.setupParts(f.request);
      expect((await parts.preflight(f.request)).cutoverProvedAbsent).toBe(true);
      await rollbackHerdr(f.request, parts);
      expect((await readJournal(f.request.journalRoot)).cutoverPending).toBe(false);
      const result = await f.run(['setup-cutover']).result; expect(result.code, result.stderr).toBe(0);
      await f.stopOwners();
      const rollback = await f.run(['rollback', '--config', f.request.configPath]).result; expect(rollback.code, rollback.stderr).toBe(0);
      expect((await readCutoverRecovery(join(f.request.config.globalRoot, 'herdr/spaces'))).entries).toEqual([]);
      await writePrivateJson(f.control, {});
      const again = await f.run(['setup-cutover']).result; expect(again.code, again.stderr).toBe(0); await f.stopOwners();
    } finally { await ports.dispose(); await f.h.close(); }
    expect(await f.h.remainingOwnedResources()).toEqual([]);
  }, 60000);
}
