// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, writeFile, readFile, chmod, access, copyFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import { createHerdrHarness } from './isolated.js';
import { createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { readJournal, saveJournal } from '../setup/backup.js';
import { rollbackHerdr } from '../setup/installer.js';
import { createTerminalRegistry, writePrivateJson } from '../sessions/registry.js';
import { readCutoverRecovery, setupSpaces } from '../spaces/setup.js';
import { shellQuote } from '../sessions/resume.js';
import type { SetupRequest } from '../setup/installer.js';
import { fixture, until, realCoreAvailable, registerJournalCrashTests } from './production-cutover-fixture.js';

afterEach(() => vi.unstubAllEnvs());
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
  registerJournalCrashTests(test, mode, ["spaces:3","installer:2","installer:4"]);
  test(`pending cutover proves absence and rollback clears its intent (${mode})`, async () => {
    const f = await fixture(mode); vi.stubEnv('PATH', join(f.root, 'bin') + ':' + process.env.PATH);
    const ports = createProductionHerdrCliPorts(f.root, f.h.localEnv);
    try {
      const journal = await readJournal(f.request.journalRoot); journal.cutoverPending = true; await saveJournal(f.request.journalRoot, journal);
      const parts = await ports.setupParts(f.request);
      expect((await parts.preflight(f.request)).cutoverProvedAbsent).toBe(true);
      await rollbackHerdr(f.request, parts);
      expect((await readJournal(f.request.journalRoot)).cutoverPending).toBe(false);
    } finally { await ports.dispose(); await f.h.close(); }
    expect(await f.h.remainingOwnedResources()).toEqual([]);
  }, 60000);
}
