import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { runtimeInstallPath } from '../setup/installer.js';

test('runtime installation paths identify the actual bytes', () => {
  const directory = resolve('.spider/scratch/runtime/programs');
  const bytes = Buffer.from('runtime source');
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  expect(runtimeInstallPath(directory, bytes)).toBe(join(dirname(directory), `spider-remote-runtime-${hash}.mjs`));
  expect(runtimeInstallPath(directory, Buffer.from('new runtime'))).not.toBe(runtimeInstallPath(directory, bytes));
  expect(runtimeInstallPath(directory, Buffer.from(bytes))).toBe(runtimeInstallPath(directory, bytes));
});
