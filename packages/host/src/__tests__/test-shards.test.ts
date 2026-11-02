import { execFileSync } from 'node:child_process';
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { partitionFiles, sortByDuration, medianDuration } from '../../../../scripts/test-shards.js';

const durations = JSON.parse(readFileSync('scripts/test-durations.json', 'utf8')) as Record<string, number>;
const files = globSync('packages/**/src/**/*.test.ts').sort();
const shardCount = 12;

// Model the same slowest-first scheduling that two Vitest workers use.
function wallTime(shard: string[], weights: Record<string, number>): number {
  const workers = [0, 0];
  for (const file of sortByDuration(shard, weights)) {
    const worker = workers[0]! <= workers[1]! ? 0 : 1;
    workers[worker]! += weights[file] ?? medianDuration(weights);
  }
  return Math.max(...workers);
}

describe('duration-balanced test shards', () => {
  it('assigns every real file exactly once, independent of discovery order', () => {
    const shards = partitionFiles(files, durations, shardCount);
    expect(shards).toHaveLength(shardCount);
    expect(shards.flat().sort()).toEqual(files);
    expect(new Set(shards.flat()).size).toBe(files.length);
    expect(partitionFiles([...files].reverse(), durations, shardCount)).toEqual(shards);
    expect(partitionFiles(files, { ...durations }, shardCount)).toEqual(shards);
  });

  it('uses longest processing time first with path and shard-index tie breaks', () => {
    const weights = { a: 10, b: 10, c: 6, d: 4, e: 2 };
    expect(partitionFiles(['e', 'b', 'd', 'a', 'c'], weights, 2)).toEqual([['a', 'c'], ['b', 'd', 'e']]);
    expect(sortByDuration(['e', 'b', 'd', 'a', 'c'], weights)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('gives unknown files the median, including even and empty histories', () => {
    expect(medianDuration({ a: 2, b: 10, c: 6 })).toBe(6);
    expect(medianDuration({ a: 2, b: 10 })).toBe(6);
    expect(medianDuration({})).toBe(1);
    expect(sortByDuration(['unknown', 'fast', 'slow'], { fast: 2, slow: 10 })).toEqual(['slow', 'unknown', 'fast']);
    expect(partitionFiles(['new-b', 'new-a', 'slow', 'fast'], { fast: 2, slow: 10 }, 2)).toEqual([['slow', 'fast'], ['new-a', 'new-b']]);
  });

  it('balances the real list within its indivisible-file and two-worker lower bounds', () => {
    const shards = partitionFiles(files, durations, shardCount);
    const fallback = medianDuration(durations);
    const weights = files.map(file => durations[file] ?? fallback);
    const lowerBound = Math.max(...weights, weights.reduce((sum, value) => sum + value, 0) / (shardCount * 2));
    expect(Math.max(...shards.map(shard => wallTime(shard, durations)))).toBeLessThanOrEqual(lowerBound * 1.1);
  });

  it('rejects invalid shard counts and permits empty shards', () => {
    expect(() => partitionFiles(files, durations, 0)).toThrow(/positive integer/);
    expect(() => partitionFiles(files, durations, 1.5)).toThrow(/positive integer/);
    expect(partitionFiles(['one'], {}, 3)).toEqual([['one'], [], []]);
  });
});

describe('duration report refresh', () => {
  it('uses file start/end times including hooks, normalizes runner paths, and retains the larger observation', () => {
    const root = mkdtempSync(join(process.cwd(), '.spider/scratch/duration-report-'));
    try {
      const first = join(root, 'first.json');
      const second = join(root, 'second.json');
      const output = join(root, 'durations.json');
      const file = 'packages/host/src/__tests__/example.test.ts';
      writeFileSync(first, JSON.stringify({ testResults: [{ name: `/home/runner/work/spider/spider/${file}`, startTime: 100, endTime: 500, assertionResults: [{ duration: 1 }] }] }));
      writeFileSync(second, JSON.stringify({ testResults: [{ name: file, startTime: 200, endTime: 400 }] }));
      execFileSync(process.execPath, ['scripts/update-test-durations.mjs', '--output', output, first, second]);
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ [file]: 400 });
      execFileSync(process.execPath, ['scripts/update-test-durations.mjs', '--output', output, second, first]);
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ [file]: 400 });
      writeFileSync(first, JSON.stringify({ testResults: [{ name: file, startTime: 500, endTime: 100 }] }));
      expect(() => execFileSync(process.execPath, ['scripts/update-test-durations.mjs', '--output', output, first], { stdio: 'pipe' })).toThrow();
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ [file]: 400 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
