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
  test(`production cutover waits for pi activation and preserves its generation (${mode})`, async () => {
    const f = await fixture(mode);
    try {
      await writePrivateJson(f.control, { activationDelay: 1500 });
      const result = await f.run(['spaces']).result; expect(result.code, result.stderr).toBe(0);
      const placed = JSON.parse(result.stdout), registry = createTerminalRegistry(join(f.request.config.globalRoot, 'herdr'));
      const mapping = (await registry.list())[0]; expect(mapping.owner).toMatchObject({ sessionId: 'selected', generation: 'authoritative', name: 'Selected', sessionFile: f.file });
      expect(placed.launched[0].pid).toBeGreaterThan(0); expect(placed.tabs).toHaveLength(1);
      expect((await f.run(['spaces']).result).code).toBe(0);
      expect((await readFile(join(f.root, 'launches.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
      await f.stopOwners();
    } finally { await f.h.close(); }
    expect(await f.h.remainingOwnedResources()).toEqual([]);
  }, 60000);
  test(`a lost app reply recovers the labelled tab after a real CLI crash (${mode})`, async () => {
    const f = await fixture(mode);
    try {
      await writePrivateJson(f.control, { lostReply: true });
      const first = await f.run(['setup-cutover']).result; expect(first.signal).toBe('SIGKILL');
      const layout = JSON.parse(await readFile(join(f.root, 'layout.json'), 'utf8')); const address = layout.spaces[0].tabs[0].terminals[0].terminal;
      const retry = await f.run(['setup-cutover']).result; expect(retry.code, retry.stderr).toBe(0);
      const recovery = await readCutoverRecovery(join(f.request.config.globalRoot, 'herdr/spaces')); expect(recovery.createdTabs[0].terminal).toBe(address); expect(recovery.recoveredCutover?.launched[0].sessionId).toBe('selected');
      expect((await readFile(join(f.root, 'launches.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
      await f.stopOwners();
      const rollback = await f.run(['rollback', '--config', f.request.configPath]).result; expect(rollback.code, rollback.stderr).toBe(0);
    } finally { await f.h.close(); }
  }, 60000);
  registerJournalCrashTests(test, mode, ["spaces:1"]);
  test(`the cutover deadline before allocation can be reconciled and rolled back (${mode})`, async () => {
    const f = await fixture(mode); vi.stubEnv('PATH', join(f.root, 'bin') + ':' + process.env.PATH);
    const ports = createProductionHerdrCliPorts(f.root, f.h.localEnv);
    try {
      await writeFile(join(f.root, 'bin/ps'), '#!/bin/sh\nif [ "$1" = -U ]; then printf "999 pi pi\\n"; exit 0; fi\nexec /bin/ps "$@"\n');
      const journal = await readJournal(f.request.journalRoot); journal.cutoverPending = true; await saveJournal(f.request.journalRoot, journal);
      let now = 0; const spaces = ports.spacePorts(f.request);
      await expect(setupSpaces(f.request.config, { ...spaces, clock: () => now, waitForChange: async () => { now += 30 * 60 * 1000; } })).rejects.toMatchObject({ code: 'cutover-deadline' });
      const parts = await ports.setupParts(f.request); expect((await parts.preflight(f.request)).cutoverProvedAbsent).toBe(true);
      await rollbackHerdr(f.request, parts); expect((await readJournal(f.request.journalRoot)).cutoverPending).toBe(false);
      expect((await readCutoverRecovery(spaces.journalRoot)).entries).toEqual([]);
    } finally { await ports.dispose(); await f.h.close(); }
  }, 60000);
  test(`a removed recorded terminal and space do not wedge cutover reconciliation (${mode})`, async () => {
    const f = await fixture(mode);
    try {
      const first = await f.run(['setup-cutover']).result; expect(first.code, first.stderr).toBe(0); await f.stopOwners();
      const recovery = await readCutoverRecovery(join(f.request.config.globalRoot, 'herdr/spaces')); await f.h.hc.rm(recovery.createdTabs[0].terminal);
      await writeFile(join(f.root, 'layout.json'), '{"spaces":[]}');
      const journal = await readJournal(f.request.journalRoot); journal.cutoverPending = true; journal.verified = false; await saveJournal(f.request.journalRoot, journal);
      await writePrivateJson(f.control, {});
      const retry = await f.run(['setup-cutover']).result; expect(retry.code, retry.stderr).toBe(0);
      expect((await readCutoverRecovery(join(f.request.config.globalRoot, 'herdr/spaces'))).createdTabs).toHaveLength(1); await f.stopOwners();
    } finally { await f.h.close(); }
  }, 60000);
}
