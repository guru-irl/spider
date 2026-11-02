import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
// @ts-ignore Runtime-tested JavaScript runner boundary.
import { packEntryDigests } from '../../../../scripts/herdr-e2e.mjs';

const entries = ['extension.js', 'herdr/cli.mjs', 'herdr/viewer.mjs', 'herdr/feed-reader.mjs', 'herdr/remote-runtime.mjs', 'herdr/viewer-pi.mjs', 'herdr/subagent-supervisor.mjs'];

it('hashes the checkout after pack has rebuilt dist, matching the bytes in the tarball', async () => {
  const root = mkdtempSync(join(process.cwd(), '.spider/scratch/packed-digests-'));
  const checkout = join(root, 'checkout');
  const tarball = join(root, 'fixture.tgz');
  try {
    for (const entry of entries) {
      const file = join(checkout, 'dist', entry);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'before prepare');
    }
    const result = await packEntryDigests(checkout, root, async () => {
      // npm 10 can run prepare even with --ignore-scripts. Model its new build id.
      for (const entry of entries) writeFileSync(join(checkout, 'dist', entry), `rebuilt during pack: ${entry}`);
      execFileSync('tar', ['-czf', tarball, '-C', checkout, 'dist']);
      return { code: 0 };
    });
    expect(result.entries).toEqual(entries);
    expect(JSON.parse(readFileSync(join(root, 'entries.json'), 'utf8'))).toEqual(result.digests);
    for (const entry of entries) {
      const bytes = execFileSync('tar', ['-xOf', tarball, `dist/${entry}`]);
      expect(result.digests[entry]).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(bytes.toString()).toBe(`rebuilt during pack: ${entry}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('does not record a snapshot when pack fails', async () => {
  const root = mkdtempSync(join(process.cwd(), '.spider/scratch/packed-digests-'));
  try {
    await expect(packEntryDigests(join(root, 'missing-checkout'), root, async () => ({ code: 1 }))).rejects.toThrow('pack failed');
    expect(existsSync(join(root, 'entries.json'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
