// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import type { SetupFixture } from './herdr-setup-fixture.js';

export const runs = async (f: SetupFixture): Promise<{ argv: string[] }[]> => {
  const calls: { argv: string[] }[] = f.h.mode === 'hc'
    ? (await readFile(join(f.h.root, 'observed-core-calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    : await f.h.calls();
  return calls.filter(call => call.argv[0] === 'run');
};

export async function replay(f: SetupFixture): Promise<void> {
  const before = (await runs(f)).length, path = join(f.request.journalRoot, 'journal.json'), journal = await readFile(path);
  let output = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  let result;
  try { result = await setupHerdr(f.request, await f.ports.setupParts(f.request)); } finally { stdout.mockRestore(); }
  const added = (await runs(f)).slice(before);
  expect(added).toHaveLength(f.request.config.machines.length);
  for (const call of added) { expect(call.argv).toContain('--probe'); expect(call.argv).not.toContain('--version'); }
  expect(result.writes).toEqual([]);
  expect(await readFile(path)).toEqual(journal);
  expect(output).not.toContain('verified earlier');
}
