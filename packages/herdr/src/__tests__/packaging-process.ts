// SPDX-License-Identifier: MIT
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try { return await run(); }
    finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  };
}

export function createProcessRunners(root: string, env: NodeJS.ProcessEnv): {
  run: (args: string[], cwd?: string) => string;
  runAsync: (args: string[], cwd?: string) => Promise<string>;
} {
  const run = (args: string[], cwd = root) => execFileSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 180_000, stdio: 'pipe' });
  const limit = createLimiter(2);
  const runAsync = (args: string[], cwd = root): Promise<string> => limit(async () => {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
    return stdout;
  });
  return { run, runAsync };
}
