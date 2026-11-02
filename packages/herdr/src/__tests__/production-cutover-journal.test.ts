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
  test(`production resume exits promptly when pi exits before activation (${mode})`, async () => {
    const f = await fixture(mode, true);
    try {
      await writePrivateJson(f.control, { earlyExit: true });
      const command = await f.runInTerminal(['resume', '--config', f.request.configPath, '--file', f.file, '--session-id', 'selected', '--cwd', f.root]);
      const outcome = await Promise.race([command.result, delay(5000).then(() => null)]);
      if (!outcome) await command.cancel();
      expect(outcome).not.toBeNull(); expect(outcome?.code).not.toBe(0);
    } finally { await f.h.close(); }
  }, 60000);
  registerJournalCrashTests(test, mode, ["spaces:2","installer:1","installer:3","installer:5"]);
  test(`production discovery lists names without following unrelated symlinks (${mode})`, async () => {
    const f = await fixture(mode), ports = createProductionHerdrCliPorts(f.root, f.h.localEnv);
    try {
      const directory = join(f.request.config.agentDirectory, 'sessions'), listed = join(directory, 'listed.jsonl');
      await writeFile(listed, 'not a valid header'); await symlink(f.file, join(directory, 'unrelated.jsonl'));
      expect(await ports.spacePorts(f.request).listSessionFiles(f.request.config)).toEqual([listed]);
    } finally { await ports.dispose(); await f.h.close(); }
  }, 60000);
}
