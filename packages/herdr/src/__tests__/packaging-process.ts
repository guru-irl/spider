// SPDX-License-Identifier: MIT
import { execFile, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const root = resolve('.');
export const env = { ...process.env, TMPDIR: join(root, '.spider/scratch/tmp'), COPYFILE_DISABLE: '1' };
export const run = (args: string[], cwd = root) => execFileSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 180_000, stdio: 'pipe' });
const execFileAsync = promisify(execFile);
export async function runAsync(args: string[], cwd = root): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
  return stdout;
}
