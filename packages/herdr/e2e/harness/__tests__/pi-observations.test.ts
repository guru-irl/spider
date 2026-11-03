// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixtureRoot } from '../environment.js';
import { readObserved } from '../pi.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(): Promise<string> {
  const root = await createFixtureRoot();
  roots.push(root);
  return root;
}

describe('observer record framing', () => {
  it.each([undefined, 123])('defers a torn last record until its newline arrives with pid %s', async pid => {
    const root = await fixture();
    const file = join(root, '123.jsonl');
    await writeFile(file, '{"at":2,"pid":123,"type":"ready"}\n\n{"at":1,"pid":123,"type":"par');
    expect(await readObserved(root, pid)).toEqual([{ at: 2, pid: 123, type: 'ready' }]);
    await appendFile(file, 'tial"}\n');
    expect(await readObserved(root, pid)).toEqual([
      { at: 1, pid: 123, type: 'partial' },
      { at: 2, pid: 123, type: 'ready' },
    ]);
  });

  it('defers a valid JSON record until its newline arrives', async () => {
    const root = await fixture();
    const file = join(root, '123.jsonl');
    await writeFile(file, '{"at":1,"pid":123,"type":"ready"}');
    expect(await readObserved(root, 123)).toEqual([]);
    await appendFile(file, '\n');
    expect(await readObserved(root, 123)).toEqual([{ at: 1, pid: 123, type: 'ready' }]);
  });

  it('rejects an invalid complete record', async () => {
    const root = await fixture();
    await writeFile(join(root, '123.jsonl'), '{"at":1,"pid":123,"type":"ready"}\nnot json\n');
    await expect(readObserved(root, 123)).rejects.toThrow(SyntaxError);
  });
});
