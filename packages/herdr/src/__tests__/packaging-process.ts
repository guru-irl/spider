// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export const root = resolve('.');
export const env = { ...process.env, TMPDIR: join(root, '.spider/scratch/tmp'), COPYFILE_DISABLE: '1' };
export const run = (args: string[], cwd = root) => execFileSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 180_000, stdio: 'pipe' });
export async function runAsync(_args: string[], _cwd = root): Promise<string> {
  throw new Error('not implemented');
}
