// SPDX-License-Identifier: MIT
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { replacePackageFile, snapshotPackage } from './packaging-copy.js';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

it('isolates package mutations while preserving nested files, modes and symlinks', () => {
  root = mkdtempSync(join(tmpdir(), 'herdr-packaging-copy-'));
  const source = join(root, 'source'), first = join(root, 'first'), second = join(root, 'second');
  mkdirSync(join(source, 'nested'), { recursive: true });
  writeFileSync(join(source, 'nested', 'file'), 'original');
  chmodSync(join(source, 'nested', 'file'), 0o640);
  writeFileSync(join(source, 'remove'), 'keep');
  symlinkSync('nested/file', join(source, 'link'));
  snapshotPackage(source, first);
  snapshotPackage(source, second);
  replacePackageFile(join(first, 'nested', 'file'), 'mutated');
  replacePackageFile(join(first, 'new-file'), 'added');
  rmSync(join(first, 'remove'));
  expect(readFileSync(join(first, 'nested', 'file'), 'utf8')).toBe('mutated');
  expect(readFileSync(join(first, 'new-file'), 'utf8')).toBe('added');
  expect(readFileSync(join(source, 'nested', 'file'), 'utf8')).toBe('original');
  expect(readFileSync(join(second, 'nested', 'file'), 'utf8')).toBe('original');
  expect(readFileSync(join(source, 'remove'), 'utf8')).toBe('keep');
  expect(readFileSync(join(second, 'remove'), 'utf8')).toBe('keep');
  expect(lstatSync(join(first, 'nested', 'file')).mode & 0o777).toBe(0o640);
  expect(readlinkSync(join(first, 'link'))).toBe('nested/file');
});
