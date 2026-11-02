// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { HERDR_LABELS, HERDR_KINDS, type MachineName, panelIpcArgv, type IpcDescriptor, type SessionIpcRequest } from '../contracts.js';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { parseHerdrConfig } from '../config.js';
import { setupHerdr, rollbackHerdr, type SetupParts, type SetupRequest, type InstallFile, type CutoverResult } from '../setup/installer.js';
import { DOCTOR_ITEMS, doctorHerdr, type DoctorParts, type DoctorFailure } from '../setup/doctor.js';
import { runHerdrCli, type HerdrCliPorts } from '../setup/cli.js';
import { readJournal, withSetupLock } from '../setup/backup.js';
import { fixture, hash, realFs, registerSetupCleanup } from './setup-fixture.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, chmod: vi.fn(actual.chmod), readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename), open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});
registerSetupCleanup();

const renameCases = Array.from({ length: 16 }, (_, index) => ['before', 'after'].map(timing => [timing, index] as const)).flat();

test.each(renameCases)('verified backup recovery resumes %s installed file rename %i', async (timing, index) => {
  const f = await fixture();
  let writes = 0;
  let crashed = false;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    const target = String(to);
    const isInstalled = target !== join(f.request.journalRoot, 'journal.json') && target.startsWith(f.h.root + '/');
    const fail = isInstalled && writes++ === index && !crashed;
    if (fail && timing === 'before') {
      crashed = true;
      throw new Error('crash before rename');
    }
    await realFs.rename(from, to);
    if (fail && timing === 'after') {
      crashed = true;
      throw new Error('crash after rename');
    }
  });
  await expect(setupHerdr(f.request, f.parts)).rejects.toThrow(`crash ${timing} rename`);
  vi.mocked(fs.rename).mockImplementation(realFs.rename);
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(f.settings, 'utf8'))).toEqual({ theme: 'dracula-plus-glass', unrelated: 'keep' });
  const journal = await readJournal(f.request.journalRoot);
  const saved = journal.entries.find(e => e.path === f.settings)!;
  expect(await readFile(saved.backup!, 'utf8')).toBe('{"theme":"stock","unrelated":"keep"}\n');
  expect(f.cutovers()).toBe(1);
  expect(f.launches).toHaveLength(1);
  await f.h.close();
  expect(await f.h.remainingOwnedResources()).toEqual([]);
}, 30000);
