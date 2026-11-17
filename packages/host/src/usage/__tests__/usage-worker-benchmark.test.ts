import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

it.each([['startup', 'SIGINT', 130], ['startup', 'SIGTERM', 143], ['active workers', 'SIGINT', 130]] as const)(
  'removes generated benchmark data on %s %s', async (phase, signal, exitCode) => {
  const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, 'benchmark-test-'));
  const child = spawn(process.execPath, ['scripts/usage-worker-benchmark.mjs', '1000'], {
    cwd: resolve('.'), env: { ...process.env, SPIDER_USAGE_BENCHMARK: '1', SPIDER_USAGE_BENCHMARK_ROOT: root },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  try {
    await vi.waitFor(() => expect(readdirSync(root).some(name => name.startsWith('usage-worker-benchmark-'))).toBe(true));
    if (phase === 'active workers') await vi.waitFor(() => expect(stderr).toContain('idle follower for two ticks'), { timeout: 20000 });
    expect(child.kill(signal)).toBe(true);
    const result = await exited;
    expect(result.code === exitCode || result.signal === signal, JSON.stringify({ result, stderr })).toBe(true);
    expect(readdirSync(root), stderr).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
}, 30000);
