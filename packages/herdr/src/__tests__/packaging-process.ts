// SPDX-License-Identifier: MIT
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function createProcessRunners(root: string, env: NodeJS.ProcessEnv) {
  const run = (args: string[], cwd = root) => execFileSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 180_000, stdio: 'pipe' });
  const runAsync = async (args: string[], cwd = root): Promise<string> => {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
    return stdout;
  };
  return { run, runAsync };
}
