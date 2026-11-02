// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it('fingerprints the packaged reader along with all other deployed entries', async () => {
  const scratch = resolve('.spider/scratch'); await mkdir(scratch, { recursive: true }); root = await mkdtemp(join(scratch, 'e2e-package-'));
  const checkout = join(root, 'checkout'); await mkdir(join(checkout, 'dist/herdr'), { recursive: true });
  for (const name of ['extension.js', 'herdr/cli.mjs', 'herdr/viewer.mjs', 'herdr/remote-runtime.mjs', 'herdr/feed-reader.mjs', 'herdr/viewer-pi.mjs', 'herdr/subagent-supervisor.mjs']) await writeFile(join(checkout, 'dist', name), name);
  const { packEntryDigests } = await import(pathToFileURL(resolve('scripts/herdr-e2e.mjs')).href);
  const result = await packEntryDigests(checkout, root, async () => {
    await writeFile(join(checkout, 'dist/herdr/feed-reader.mjs'), 'packed reader');
    await writeFile(join(checkout, 'dist/herdr/subagent-supervisor.mjs'), 'packed supervisor'); return { code: 0 };
  });
  expect(result.entries).toContain('herdr/feed-reader.mjs');
  expect(result.entries).toContain('herdr/viewer-pi.mjs');
  expect(result.entries).toContain('herdr/subagent-supervisor.mjs');
  expect(result.digests['herdr/subagent-supervisor.mjs']).toBe(createHash('sha256').update('packed supervisor').digest('hex'));
  expect(result.digests['herdr/viewer-pi.mjs']).toBe(createHash('sha256').update('herdr/viewer-pi.mjs').digest('hex'));
  expect(result.digests['herdr/feed-reader.mjs']).toBe(createHash('sha256').update('packed reader').digest('hex'));
  expect(JSON.parse(await readFile(join(root, 'entries.json'), 'utf8'))).toEqual(result.digests);
});
