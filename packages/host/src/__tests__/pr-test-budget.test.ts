import { describe, expect, it } from 'vitest';

async function api() {
  return import(/* @vite-ignore */ `${process.cwd()}/scripts/test-shard-budget.mjs`);
}

describe('PR test budget', () => {
  it('fills by proximity before path or duration and lists every deferred file', async () => {
    const { cutToBudget, selectionSummary } = await api();
    const result = cutToBudget({
      files: ['a-importer', 'b-neighbor', 'z-direct', 'y-changed', 'c-small'],
      priorities: { 'y-changed': 0, 'z-direct': 0, 'b-neighbor': 1, 'a-importer': 2, 'c-small': 2 },
      durations: { 'a-importer': 6, 'b-neighbor': 6, 'z-direct': 6, 'y-changed': 6, 'c-small': 4 },
      machines: 2, workerCount: 1, limitMs: 10,
    });
    expect(result.files).toEqual(['c-small', 'y-changed', 'z-direct']);
    expect(result.deferred.map((entry: { file: string }) => entry.file)).toEqual(['a-importer', 'b-neighbor']);
    expect(result.budget.predictedMaxMs).toBe(10);
    expect(result.budget.shards.map((shard: { predictedMs: number }) => shard.predictedMs)).toEqual([10, 6]);
    const summary = selectionSummary({ ...result, optional: { chrome: true, acceptance: true, stories: true } });
    for (const file of ['a-importer', 'b-neighbor']) expect(summary).toContain(`\`${file}\``);
    expect(summary).not.toContain('`y-changed`');
    expect(summary).toMatch(/full run.*Chrome/);
    expect(summary).toMatch(/full run.*acceptance/);
    expect(summary).toMatch(/full run.*headless story/);
  });

  it('keeps same-directory tests ahead of importers and continues after an oversized file', async () => {
    const { cutToBudget } = await api();
    const result = cutToBudget({ files: ['a-importer', 'z-neighbor', 'oversized'],
      priorities: { oversized: 0, 'z-neighbor': 1, 'a-importer': 2 },
      durations: { 'a-importer': 10, 'z-neighbor': 10, oversized: 11 },
      machines: 1, workerCount: 1, limitMs: 10 });
    expect(result.files).toEqual(['z-neighbor']);
    expect(result.deferred.map((entry: { file: string }) => entry.file)).toEqual(['a-importer', 'oversized']);
    expect(result.deferred.every((entry: { rule: string }) => /budget/.test(entry.rule))).toBe(true);
  });

  it('reserves import time on the same workers instead of treating imports as free', async () => {
    const { cutToBudget } = await api();
    const result = cutToBudget({ files: ['a', 'b', 'c'], durations: { a: 4, b: 4, c: 4 },
      machines: 1, workerCount: 2, limitMs: 10, importMs: 2 });
    expect(result.files).toEqual(['a', 'b']);
    expect(result.deferred.map((entry: { file: string }) => entry.file)).toEqual(['c']);
    expect(result.budget).toMatchObject({ predictedMaxMs: 6, aggregateMs: 8, importMs: 2 });
    for (const importMs of [-1, NaN, Infinity]) expect(() => cutToBudget({ files: [], durations: {}, importMs })).toThrow(/import/);
  });

  it('uses the timing median for unknown files, permits empty selections, and is deterministic', async () => {
    const { cutToBudget } = await api();
    const options = { files: ['unknown', 'known'], durations: { known: 8, other: 12 }, machines: 1, workerCount: 1, limitMs: 9 };
    const result = cutToBudget(options);
    expect(result.files).toEqual(['known']);
    expect(result.deferred).toMatchObject([{ file: 'unknown', durationMs: 10 }]);
    expect(cutToBudget({ ...options, files: [...options.files].reverse() })).toEqual(result);
    expect(cutToBudget({ ...options, files: [] })).toMatchObject({ files: [], deferred: [], budget: { predictedMaxMs: 0 } });
    for (const limitMs of [0, -1, NaN, Infinity]) expect(() => cutToBudget({ ...options, limitMs })).toThrow(/budget/);
  });
});
