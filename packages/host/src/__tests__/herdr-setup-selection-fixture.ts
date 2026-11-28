// SPDX-License-Identifier: MIT
import { expect } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal } from '../../../herdr/src/setup/backup.js';
import type { SetupFixture } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';

export async function interruptSelection(command: 'layout.switch' | 'app.theme', coreTransport: 'process' | 'socket' = 'socket'): Promise<{
  f: SetupFixture; settings: string; original: Buffer; shared: string; originalShared: Buffer;
}> {
  const f = await focusedSetupFixture({ coreTransport, localOnly: true }), settings = join(f.request.config.app.home, 'settings.json');
  const shared = join(f.request.config.app.home, 'shared.json');
  const original = await readFile(settings), originalShared = await readFile(shared);
  const script = join(f.h.root, 'app-selection.mjs'), marker = join(f.h.root, 'interrupt-selection');
  const journal = join(f.request.journalRoot, 'journal.json'), interruptedJournal = join(f.h.root, 'interrupted-journal.json');
  await writeFile(marker, 'once');
  await writeFile(script, `import { existsSync as hasInterruption, unlinkSync as consumeInterruption, readFileSync as readIntent, writeFileSync as retainIntent } from 'node:fs';
if (process.argv[2] === 'do' && process.argv[3] === ${JSON.stringify(command)} && hasInterruption(${JSON.stringify(marker)})) {
  consumeInterruption(${JSON.stringify(marker)});
  retainIntent(${JSON.stringify(interruptedJournal)}, readIntent(${JSON.stringify(journal)}));
  console.error(JSON.stringify({ error: { kind: 'selection-interrupted', message: 'interrupted app selection' } })); process.exit(41);
}
` + await readFile(script, 'utf8'));
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'selection-interrupted' });
  // SIGKILL cannot run the installer's finally block. Restore its actual pre-acknowledgement journal.
  await writeFile(journal, await readFile(interruptedJournal));
  return { f, settings, original, shared, originalShared };
}

export async function fingerprint(f: SetupFixture): Promise<{ path: string; bytes: string; mtime: number }[]> {
  const journal = await readJournal(f.request.journalRoot);
  const paths = new Set([join(f.request.journalRoot, 'journal.json'), ...journal.entries.flatMap(entry => [entry.path, ...entry.backup ? [entry.backup] : []])]);
  return Promise.all([...paths].sort().map(async path => ({ path, bytes: (await readFile(path)).toString('base64'), mtime: (await stat(path)).mtimeMs })));
}
