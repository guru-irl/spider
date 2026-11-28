// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import * as fs from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { expect, test, vi } from 'vitest';
import { createHerdrHarness } from './testutil.js';
import { setupHerdr } from '../setup/installer.js';
import { readJournal } from '../setup/backup.js';
import { fixture, realFs } from './setup-fixture.js';
import { createInProcessHerdrHarness } from './setup-inprocess-harness.js';

export function registerPublicationCases(timing: 'before' | 'after'): void {
  const publicationCases = Array.from({ length: 16 }, (_, index) => [timing, index] as const);
  test.each(publicationCases)('verified backup recovery resumes %s installed file publication %i', async (timing, index) => {
    const processBoundary = timing === 'before' && index === 0 || timing === 'after' && index === 15;
    const f = await fixture('fake', processBoundary ? createHerdrHarness : createInProcessHerdrHarness);
    let writes = 0;
    let crashed = false;
    const publish = (operation: typeof realFs.rename) => async (from: Parameters<typeof realFs.rename>[0], to: Parameters<typeof realFs.rename>[1]) => {
      const target = String(to);
      const isInstalled = !target.startsWith(f.request.journalRoot + '/') && target.startsWith(f.h.root + '/');
      const fail = isInstalled && writes++ === index && !crashed;
      if (fail && timing === 'before') {
        crashed = true;
        throw new Error('crash before publication');
      }
      await operation(from, to);
      if (fail && timing === 'after') {
        crashed = true;
        throw new Error('crash after publication');
      }
    };
    vi.mocked(fs.rename).mockImplementation(publish(realFs.rename));
    vi.mocked(fs.link).mockImplementation(publish(realFs.link));
    await expect(setupHerdr(f.request, f.parts)).rejects.toThrow(`crash ${timing} publication`);
    vi.mocked(fs.rename).mockImplementation(realFs.rename);
    vi.mocked(fs.link).mockImplementation(realFs.link);
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

}
